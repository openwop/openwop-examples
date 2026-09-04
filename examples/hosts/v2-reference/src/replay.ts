/**
 * replay.md — `POST /runs/{runId}:fork`. The fork is a new run with its own
 * log: the TRANSLATED source prefix (`sequence < fromSeq`, read through the
 * storage boundary so an era-2 parent is byte-equivalent to its codemap
 * rendering) is copied as fixed history — never fanned out — and the loop
 * re-executes from the projected state. `owner` is copied verbatim.
 */
import { appendEvent, ownerOf, readEvents } from './events.js';
import { err } from './errors.js';
import { scheduleRun } from './executor.js';
import { nowIso, tenantBound } from './ids.js';
import { EVENT_LOG_SCHEMA_VERSION } from './config.js';
import type { Host } from './host.js';
import type { RunRow } from './store.js';

export interface ForkRequest { mode?: unknown; fromSeq?: unknown; runOptionsOverlay?: unknown }

export function forkRun(host: Host, source: RunRow, body: ForkRequest): { runId: string; sourceRunId: string; fromSeq: number; mode: string; status: string } {
  const allowed = new Set(['mode', 'fromSeq', 'runOptionsOverlay']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw err('validation_error', `unknown key ${k} in the fork body`, { key: k });
  const mode = body.mode;
  if (mode !== 'replay' && mode !== 'branch') throw err('validation_error', 'mode MUST be replay | branch', { mode });
  const overlay = body.runOptionsOverlay;
  if (mode === 'replay' && overlay !== undefined && !(overlay !== null && typeof overlay === 'object' && Object.keys(overlay as object).length === 0)) {
    throw err('validation_error', 'runOptionsOverlay MUST be omitted or empty for replay');
  }
  if (mode === 'branch' && body.fromSeq === undefined) throw err('validation_error', 'fromSeq is REQUIRED for branch');
  if (body.fromSeq !== undefined && (!Number.isInteger(body.fromSeq) || (body.fromSeq as number) < 0)) throw err('validation_error', 'fromSeq MUST be an integer >= 0');
  const fromSeq = body.fromSeq === undefined ? 0 : (body.fromSeq as number);
  // Through the storage boundary: an era-2 parent with an unmapped row fails here with event_type_unmapped.
  const prefix = readEvents(host, source);
  if (fromSeq > 0 && !prefix.some((e) => e.sequence === fromSeq) && !(fromSeq === host.store.lastSequence(source.run_id) + 1)) {
    // spec gap: runs.md says 422, but spec/v2/errors.json registers no 422 code for a missing sequence — validation_error (400) is the registered choice.
    throw err('validation_error', `fromSeq ${fromSeq} is not a sequence in the source log`, { fromSeq, lastSequence: host.store.lastSequence(source.run_id) });
  }
  const retention = host.config.replayRetentionDays * 86_400_000;
  if (Date.parse(source.created_at) < Date.now() - retention) throw err('validation_error', 'the source log is past the advertised replay retention', { sourceRunId: source.run_id, fromSeq, retentionDays: host.config.replayRetentionDays });
  const owner = ownerOf(host, source);
  const options = JSON.parse(source.options_json) as Record<string, unknown>;
  const merged = mode === 'branch' && overlay && typeof overlay === 'object' ? { ...options, ...(overlay as Record<string, unknown>) } : options;
  const child: RunRow = {
    run_id: tenantBound(source.tenant),
    tenant: source.tenant,
    workflow_id: source.workflow_id,
    status: 'pending',
    era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: JSON.stringify(owner),
    options_json: JSON.stringify(merged),
    inputs_json: source.inputs_json,
    created_at: nowIso(),
    updated_at: nowIso(),
    started_at: null,
    completed_at: null,
    current_node_id: null,
    error_json: null,
    source_run_id: source.run_id,
    fork_mode: mode,
    from_seq: fromSeq,
    compensation_json: null,
    pause_requested: 0,
    cancel_requested: 0,
    pin_checked: 1,
    scope_id: null,
  };
  host.store.insertRun(child);
  for (const e of prefix) {
    if (e.sequence >= fromSeq) break;
    const opts: { nodeId?: string; causationId?: string; fixedHistory: true; timestamp: string } = { fixedHistory: true, timestamp: e.timestamp };
    if (e.nodeId !== undefined) opts.nodeId = e.nodeId;
    if (e.causationId !== undefined) opts.causationId = e.causationId;
    appendEvent(host, child, e.type, e.payload, opts);
    if (e.type === 'run.started') host.store.updateRun(child.run_id, { started_at: e.timestamp });
  }
  const started = prefix.some((e) => e.sequence < fromSeq && e.type === 'run.started');
  host.store.updateRun(child.run_id, { status: started ? 'running' : 'pending' });
  scheduleRun(host, child.run_id);
  return { runId: child.run_id, sourceRunId: source.run_id, fromSeq, mode, status: started ? 'running' : 'pending' };
}
