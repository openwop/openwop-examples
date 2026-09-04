/**
 * events.md — the append-only log, the one ordering field (`sequence` from 0),
 * the poll cursor and the SSE frames. `readEvents()` is the storage boundary
 * every reader passes through (persistence.md §The seat): era-2 rows are
 * translated in codemap.ts; era-3 rows are served as written.
 */
import type { ServerResponse } from 'node:http';
import { ENGINE_VERSION, EVENT_SCHEMA_VERSION, LEGACY_ISSUER } from './config.js';
import { eraOf, rowToDoc, type RunEventDoc } from './codemap.js';
import { err } from './errors.js';
import { nowIso, opaque } from './ids.js';
import { TERMINAL, type AppendedEvent, type Host, type Owner } from './host.js';
import type { RunRow } from './store.js';

export interface AppendOptions {
  nodeId?: string;
  causationId?: string;
  /** A prefix copied onto a fork is fixed history: never fanned out (replay.md §Fan-out). */
  fixedHistory?: boolean;
  timestamp?: string;
}

/** Append one event in v2 vocabulary. Returns the persisted document. */
export function appendEvent(host: Host, run: RunRow, type: string, payload: unknown, opts: AppendOptions = {}): RunEventDoc {
  if (!host.artifacts.v2EventTypes.has(type) && !host.artifacts.vendorEventPattern.test(type)) {
    throw new Error(`producer refused: ${type} is not a registered v2 event type (events.md §Types)`);
  }
  const sequence = host.store.lastSequence(run.run_id) + 1;
  const timestamp = opts.timestamp ?? nowIso();
  const eventId = opaque();
  host.store.insertEvent({
    run_id: run.run_id,
    sequence,
    event_id: eventId,
    type,
    payload_json: JSON.stringify(payload ?? {}),
    timestamp,
    node_id: opts.nodeId ?? null,
    causation_id: opts.causationId ?? null,
    schema_version: EVENT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
  });
  const doc: RunEventDoc = { eventId, runId: run.run_id, type, payload: payload ?? {}, timestamp, sequence, schemaVersion: EVENT_SCHEMA_VERSION, engineVersion: ENGINE_VERSION };
  if (opts.nodeId !== undefined) doc.nodeId = opts.nodeId;
  if (opts.causationId !== undefined) doc.causationId = opts.causationId;
  host.validate('run-event', doc, `append ${type}`);
  const appended: AppendedEvent = { run: { runId: run.run_id, tenant: run.tenant, forkMode: run.fork_mode, fromSeq: run.from_seq }, doc };
  host.bus.emit(`run:${run.run_id}`, appended);
  if (!opts.fixedHistory) host.bus.emit('event', appended);
  return doc;
}

/** The owner block, legacy-stamped at first v2 read for a run that predates subjects (identity.md §1.2). */
export function ownerOf(host: Host, run: RunRow): Owner {
  if (run.owner_json !== null) return JSON.parse(run.owner_json) as Owner;
  const owner: Owner = {
    tenant: run.tenant,
    subject: { issuer: LEGACY_ISSUER, subjectId: 'legacy', tenant: run.tenant, lane: 'api-key', kind: 'user' },
  };
  // Stamp once; never rewritten later.
  host.store.updateRun(run.run_id, { owner_json: JSON.stringify(owner) });
  run.owner_json = JSON.stringify(owner);
  return owner;
}

/** Every event of a run through the storage boundary, era-2 rows translated. */
export function readEvents(host: Host, run: RunRow, afterSequence = -1): RunEventDoc[] {
  const owner = eraOf(run) < 3 ? (ownerOf(host, run) as unknown as Record<string, unknown>) : null;
  return host.store.listEventRows(run.run_id, afterSequence).map((row) => rowToDoc(row, run, owner));
}

export function pollResponse(host: Host, run: RunRow, afterSequence: number | undefined): { runId: string; events: RunEventDoc[]; lastSequence: number; status: string; isTerminal: boolean } {
  const events = readEvents(host, run, afterSequence ?? -1);
  const fresh = host.store.getRun(run.run_id) ?? run;
  return { runId: run.run_id, events, lastSequence: host.store.lastSequence(run.run_id), status: fresh.status, isTerminal: TERMINAL.has(fresh.status) };
}

export const STREAM_MODE = /^(values|(updates|messages|debug)(,(updates|messages|debug))*)$/;
const IMPLEMENTED_MODES = ['updates', 'values', 'messages', 'debug'];
const UPDATES_PREFIXES = ['run.', 'interrupt.', 'approval.', 'clarification.', 'node.', 'artifact.', 'eval.', 'deployment.', 'workspace.', 'replay.', 'cap.', 'compensation.', 'negotiation.'];
const DEBUG_ONLY = new Set(['log.appended', 'variable.changed', 'version.pinned', 'lease.acquired', 'lease.renewed', 'lease.lost', 'lease.handed-off', 'node.retried']);

export function parseStreamModes(raw: string | null): string[] {
  const value = raw === null || raw === '' ? 'updates' : raw;
  if (!STREAM_MODE.test(value)) throw err('unsupported_stream_mode', `streamMode ${value} is outside the grammar`, { supported: IMPLEMENTED_MODES });
  return value.split(',');
}

function admitted(modes: string[], doc: RunEventDoc): string | null {
  const vendor = !doc.type.includes('.') ? false : !/^(run|node|interrupt|approval|clarification|artifact|eval|deployment|workspace|replay|cap|compensation|negotiation|log|variable|version|lease|agent|output|provider|prompt|envelope|memory|budget|dispatch|orchestrator|conversation|channel|context|workflow|workflow-chain|trigger|tool|egress|import|goal|proposal|connector|authorization|voice|roster|commitment|model)\./.test(doc.type);
  for (const mode of modes) {
    if (mode === 'debug') return 'debug';
    if (mode === 'updates' && !vendor && !DEBUG_ONLY.has(doc.type) && UPDATES_PREFIXES.some((p) => doc.type.startsWith(p))) return 'updates';
    if (mode === 'messages' && doc.type === 'output.chunk') return 'messages';
    if (mode === 'values' && UPDATES_PREFIXES.some((p) => doc.type.startsWith(p)) && !DEBUG_ONLY.has(doc.type)) return 'values';
  }
  return null;
}

/** events.md §SSE frames — id: sequence, event: type, data: RunEventDoc; keep-alive comments; closes on terminal. */
export function streamRun(host: Host, run: RunRow, res: ServerResponse, opts: { modes: string[]; lastEventId: number | null; bufferMs: number; snapshot: () => Record<string, unknown>; headers: Record<string, string> }): void {
  // The backlog is read through the storage boundary BEFORE the 200 is
  // committed, so an untranslatable era-2 log answers 500 event_type_unmapped.
  const backlog = readEvents(host, run, opts.lastEventId ?? -1);
  res.writeHead(200, { ...opts.headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const values = opts.modes.includes('values');
  let closed = false;
  let batch: RunEventDoc[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const writeFrame = (id: number, event: string, data: unknown): void => {
    if (closed) return;
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const flush = (): void => {
    if (batch.length === 0) return;
    const last = batch[batch.length - 1] as RunEventDoc;
    writeFrame(last.sequence, 'batch', batch);
    batch = [];
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };
  const end = (): void => {
    if (closed) return;
    flush();
    closed = true;
    clearInterval(keepAlive);
    host.bus.off(`run:${run.run_id}`, onEvent);
    res.end();
  };
  const emit = (doc: RunEventDoc): void => {
    const mode = admitted(opts.modes, doc);
    if (mode === null) return;
    if (opts.bufferMs > 0) {
      batch.push(doc);
      if (doc.type === 'node.suspended' || TERMINAL.has(doc.type.replace('run.', ''))) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, opts.bufferMs);
    } else {
      writeFrame(doc.sequence, opts.modes.length === 1 ? doc.type : mode, doc);
    }
    if (values && mode !== null) writeFrame(doc.sequence, 'state.snapshot', opts.snapshot());
    if (doc.type === 'run.completed' || doc.type === 'run.failed' || doc.type === 'run.cancelled') end();
  };
  const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
  let delivered = opts.lastEventId ?? -1;
  const onEvent = (e: AppendedEvent): void => {
    if (e.doc.sequence <= delivered) return;
    delivered = e.doc.sequence;
    emit(e.doc);
  };
  res.on('close', end);
  if (values && opts.lastEventId !== null) writeFrame(opts.lastEventId, 'state.snapshot', opts.snapshot());
  // Backlog (translated at the boundary), then live.
  for (const doc of backlog) { delivered = doc.sequence; emit(doc); if (closed) return; }
  const fresh = host.store.getRun(run.run_id);
  if (fresh && TERMINAL.has(fresh.status)) { end(); return; }
  host.bus.on(`run:${run.run_id}`, onEvent);
}
