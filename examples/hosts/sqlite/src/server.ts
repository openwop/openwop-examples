/**
 * OpenWOP SQLite host — protocol v2.
 *
 * A single-process, single-file, SQLite-backed host for the OpenWOP v2 wire:
 * unversioned paths, `OpenWOP-Version: 2`, the closed v2 discovery root, v2
 * event names, tenant-bound ids and the flat `{ error, message, details? }`
 * envelope. What it is for:
 *
 *   1. DURABILITY you can watch. Runs, events, interrupts and idempotency
 *      records are rows in one SQLite file. Kill the process mid-run, start it
 *      again, and the run picks up from its event log.
 *   2. CLAIM-BASED DISPATCH. A process executes a run only while it holds the
 *      run's claim (`claim_holder_id` + `claim_expires_at`, renewed by a
 *      heartbeat). A crashed process's claims lapse and the next process to
 *      boot resumes those runs, without double-executing.
 *   3. A PORTING WALKTHROUGH. This host was a v1 host. Its database keeps the
 *      v1 tables, and runs written by the v1 host still read on the v2 wire:
 *      their event logs are era 2 and are translated through
 *      `spec/v2/event-codemap.json` at the storage boundary
 *      (persistence.md §The reader rule). README.md walks through it.
 *
 * Read top to bottom; the `// ─── … ───` markers match the README sections.
 *
 * What it reuses. The contract-level modules of the v2 reference host
 * (`../../v2-reference/src/`): the spec-artifacts loader (`artifacts.ts`), the
 * error registry (`errors.ts`), the id grammars and the `~` projection
 * (`ids.ts`) and the codemap reader and writer rules (`codemap.ts`). Those are
 * pure functions of `@openwop/spec-artifacts`. Everything with state (the
 * store, the executor, the front door) is this file's own.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';

import { loadArtifacts } from '../../v2-reference/src/artifacts.js';
import { HostError, err } from '../../v2-reference/src/errors.js';
import { IDEMPOTENCY_KEY, NODE_ID, WORKFLOW_ID, checkTenantBound, nowIso, opaque, projectBoundId, tenantBound, unprojectBoundId } from '../../v2-reference/src/ids.js';
import { rowToDoc, toStorageVocabulary, type RunEventDoc } from '../../v2-reference/src/codemap.js';
import type { EventRow as ContractEventRow, RunRow as ContractRunRow } from '../../v2-reference/src/store.js';

// ─── Contract ────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const pkgRequire = createRequire(join(PKG_ROOT, 'package.json'));

// The contract this host implements is `@openwop/spec-artifacts`, installed
// beside it. `artifacts.ts` resolves the package from its own directory unless
// told otherwise, so point it at this package's copy before the first load.
if (!process.env['OPENWOP_SPEC_ARTIFACTS_DIR']) {
  try {
    process.env['OPENWOP_SPEC_ARTIFACTS_DIR'] = dirname(pkgRequire.resolve('@openwop/spec-artifacts/package.json'));
  } catch {
    /* loadArtifacts() names the missing package */
  }
}
const contract = loadArtifacts();

const PROTOCOL_VERSION = '2.0';
const ENGINE_VERSION = 1;
/** persistence.md §The era key — a v2 host stamps 3 on every run it creates. */
const ERA = 3;
const EVENT_SCHEMA_VERSION = 1;
const SINCE = '2.0';
const EXPERIMENTAL_UNTIL = '2.1';
const HOST_NAME = 'openwop-host-sqlite';
const HOST_VERSION = (JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const API_KEY_ISSUER = `urn:${HOST_NAME}:api-key`;
const LEGACY_ISSUER = 'urn:openwop:legacy';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WAITING = new Set(['waiting-approval', 'waiting-input', 'waiting-external']);

// ─── Configuration ───────────────────────────────────────────────────────────

export interface HostOptions {
  host: string;
  port: number;
  dbPath: string;
  apiKey: string;
  tenant: string;
  tenantBKey: string | null;
  tenantB: string;
  claimTtlMs: number;
  heartbeatMs: number;
  maxRunDurationMs: number;
  fixturesDir: string | null;
  logResumeTokens: boolean;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function optionsFromEnv(): HostOptions {
  return {
    host: process.env['OPENWOP_HOST'] ?? '127.0.0.1',
    port: envInt('OPENWOP_PORT', 3839),
    dbPath: process.env['OPENWOP_SQLITE_PATH'] ?? join(PKG_ROOT, 'data', 'openwop-host.sqlite'),
    apiKey: process.env['OPENWOP_API_KEY'] ?? 'openwop-sqlite-dev-key',
    tenant: 'openwop-sqlite-tenant',
    tenantBKey: process.env['OPENWOP_TENANT2_API_KEY'] ?? null,
    tenantB: 'openwop-sqlite-tenant-b',
    claimTtlMs: envInt('OPENWOP_CLAIM_TTL_MS', 30_000),
    heartbeatMs: envInt('OPENWOP_HEARTBEAT_INTERVAL_MS', 10_000),
    maxRunDurationMs: envInt('OPENWOP_MAX_RUN_DURATION_MS', 600_000),
    fixturesDir: process.env['OPENWOP_FIXTURES_DIR'] ?? null,
    logResumeTokens: process.env['OPENWOP_LOG_RESUME_TOKENS'] === 'true',
  };
}

const MAX_NODE_EXECUTIONS = 1000;
const MAX_REQUEST_BODY_BYTES = 4_194_304;
const RUN_LIST_MAX_PAGE = 100;
const TOKEN_KID = 'sqlite-1';
const TOKEN_DEFAULT_TTL_MS = 30 * 60_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Subject {
  issuer: string;
  subjectId: string;
  tenant: string;
  lane: 'api-key';
  kind: 'user';
}

interface Owner {
  tenant: string;
  subject: Record<string, unknown>;
}

interface WorkflowNode {
  id: string;
  typeId: string;
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

interface Workflow {
  id: string;
  name?: string;
  nodes: WorkflowNode[];
  edges?: Array<Record<string, unknown>>;
  variables?: Array<{ name: string; required?: boolean; defaultValue?: unknown }>;
}

interface RunRow {
  run_id: string;
  tenant: string;
  workflow_id: string;
  status: string;
  inputs_json: string;
  options_json: string | null;
  owner_json: string | null;
  created_at: string | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
  current_node_id: string | null;
  claim_holder_id: string | null;
  claim_expires_at: number | null;
  cancel_requested: number;
  cancel_reason: string | null;
  pause_requested: string | null;
  parent_run_id: string | null;
  fork_mode: string | null;
  from_seq: number | null;
  scope_id: string | null;
  engine_version: number | null;
  event_log_schema_version: number | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  node_id: string | null;
  data_json: string | null;
  timestamp: string;
  causation_id: string | null;
  event_id: string | null;
  schema_version: number | null;
  engine_version: number | null;
}

interface InterruptRow {
  interrupt_id: string;
  run_id: string;
  node_id: string;
  ikey: string;
  payload_json: string;
  state: 'open' | 'resolved' | 'invalidated';
  expires_at: number;
}

interface InterruptPayload {
  kind: string;
  key: string;
  data: Record<string, unknown>;
  resumeSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

class NodeFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Thrown into a running loop when the process shuts down: the loop stops without recording anything. */
class HostClosing extends Error {}

type NodeResult = { outputs: Record<string, unknown> } | { suspend: InterruptPayload } | 'cancelled' | 'paused' | 'timeout';

// ─── Host ────────────────────────────────────────────────────────────────────

export interface RunningHost {
  readonly port: number;
  readonly server: Server;
  readonly processId: string;
  close(): Promise<void>;
}

export async function startHost(overrides: Partial<HostOptions> = {}): Promise<RunningHost> {
  const opts: HostOptions = { ...optionsFromEnv(), ...overrides };
  const processId = `host-${opaque().slice(0, 12)}`;
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // ─── 1. Schema ─────────────────────────────────────────────────────────────
  //
  // The v1 host's tables are kept and grown additively; nothing a v1 host wrote
  // is rewritten. persistence.md §Per-store disposition, one row per store:
  //
  //   runs            legacy-stamped — `tenant` and `owner_json` filled at first v2 read;
  //                                    `event_log_schema_version` NULL or 2 = era 2
  //   events          translated     — era-2 rows read through the codemap, never rewritten
  //   interrupts_v2   new            — v2 interrupts (key K, ow2 tokens)
  //   idempotency_v2  new            — Layer-1 records keyed (tenant, endpoint, key)
  //   host_secrets    new            — token and cursor MAC keys, durable across restarts
  //   interrupts, idempotency, webhook_*, audit_*, annotations, memory_entries
  //                   never-upgraded — v1 rows, not read by this host

  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      error_json TEXT,
      claim_holder_id TEXT,
      claim_expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      node_id TEXT,
      data_json TEXT,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  const addColumns = (table: string, cols: Record<string, string>): void => {
    const have = new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, ddl] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  addColumns('runs', {
    tenant: 'TEXT', owner_json: 'TEXT', options_json: 'TEXT', created_at: 'TEXT', current_node_id: 'TEXT',
    cancel_requested: 'INTEGER NOT NULL DEFAULT 0', cancel_reason: 'TEXT', pause_requested: 'TEXT',
    parent_run_id: 'TEXT', fork_mode: 'TEXT', from_seq: 'INTEGER', scope_id: 'TEXT',
    engine_version: 'INTEGER', event_log_schema_version: 'INTEGER',
  });
  addColumns('events', { causation_id: 'TEXT', event_id: 'TEXT', schema_version: 'INTEGER', engine_version: 'INTEGER' });
  // The era is stamped by the persistence layer, not by call sites: every row
  // inserted from now on is era 3 unless it says otherwise. The v1 host's
  // trigger stamped 2; replacing it is the cut. Rows it already stamped keep 2.
  db.exec(`
    DROP TRIGGER IF EXISTS runs_stamp_versions;
    CREATE TRIGGER runs_stamp_versions AFTER INSERT ON runs
    BEGIN
      UPDATE runs SET engine_version = COALESCE(NEW.engine_version, ${ENGINE_VERSION}),
                      event_log_schema_version = COALESCE(NEW.event_log_schema_version, ${ERA})
       WHERE run_id = NEW.run_id AND (engine_version IS NULL OR event_log_schema_version IS NULL);
    END;
    CREATE INDEX IF NOT EXISTS idx_runs_tenant_created ON runs(tenant, created_at);
    CREATE TABLE IF NOT EXISTS interrupts_v2 (
      interrupt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      ikey TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, ikey)
    );
    CREATE TABLE IF NOT EXISTS idempotency_v2 (
      tenant TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      digest TEXT NOT NULL,
      status INTEGER,
      headers_json TEXT,
      body TEXT,
      stored_at INTEGER NOT NULL,
      PRIMARY KEY (tenant, endpoint, idem_key)
    );
    CREATE TABLE IF NOT EXISTS host_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // identity.md §1.2 — a run a v1 host wrote has no tenant; it belongs to the
  // default tenant. Stamped once, the first time a v2 host opens the file.
  db.prepare('UPDATE runs SET tenant = ? WHERE tenant IS NULL').run(opts.tenant);

  const secret = (name: string): string => {
    const row = db.prepare('SELECT value FROM host_secrets WHERE name = ?').get(name) as { value: string } | undefined;
    if (row) return row.value;
    const value = randomBytes(32).toString('hex');
    db.prepare('INSERT OR IGNORE INTO host_secrets (name, value) VALUES (?, ?)').run(name, value);
    return (db.prepare('SELECT value FROM host_secrets WHERE name = ?').get(name) as { value: string }).value;
  };
  const tokenSecret = secret('interrupt-token-hs256');
  const cursorSecret = secret('run-list-cursor');

  const q = {
    insertRun: db.prepare(`INSERT INTO runs (run_id, tenant, workflow_id, status, inputs_json, options_json, owner_json, created_at, started_at,
                            parent_run_id, fork_mode, from_seq, scope_id, engine_version, event_log_schema_version)
                           VALUES (@run_id, @tenant, @workflow_id, @status, @inputs_json, @options_json, @owner_json, @created_at, @started_at,
                            @parent_run_id, @fork_mode, @from_seq, @scope_id, ${ENGINE_VERSION}, ${ERA})`),
    getRun: db.prepare('SELECT * FROM runs WHERE run_id = ?'),
    getLegacyRun: db.prepare('SELECT * FROM runs WHERE run_id = ? AND tenant = ?'),
    insertEvent: db.prepare(`INSERT INTO events (run_id, seq, type, node_id, data_json, timestamp, causation_id, event_id, schema_version, engine_version)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    lastSeq: db.prepare('SELECT MAX(seq) AS s FROM events WHERE run_id = ?'),
    eventsAfter: db.prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC'),
    claim: db.prepare(`UPDATE runs SET claim_holder_id = ?, claim_expires_at = ?
                       WHERE run_id = ? AND status NOT IN ('completed','failed','cancelled')
                         AND (claim_holder_id IS NULL OR claim_holder_id = ? OR claim_expires_at < ?)`),
    renew: db.prepare('UPDATE runs SET claim_expires_at = ? WHERE run_id = ? AND claim_holder_id = ?'),
    release: db.prepare('UPDATE runs SET claim_holder_id = NULL, claim_expires_at = NULL WHERE run_id = ? AND claim_holder_id = ?'),
    orphans: db.prepare(`SELECT run_id FROM runs WHERE status IN ('pending','running','cancelling')
                           AND (claim_holder_id IS NULL OR claim_expires_at < ?)`),
    activeForScope: db.prepare(`SELECT run_id FROM runs WHERE tenant = ? AND scope_id = ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1`),
    insertInterrupt: db.prepare(`INSERT INTO interrupts_v2 (interrupt_id, run_id, node_id, ikey, payload_json, state, expires_at, created_at)
                                 VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`),
    openInterrupt: db.prepare(`SELECT * FROM interrupts_v2 WHERE run_id = ? AND node_id = ? AND state = 'open'`),
    anyInterrupt: db.prepare('SELECT * FROM interrupts_v2 WHERE run_id = ? AND node_id = ? LIMIT 1'),
    interruptById: db.prepare('SELECT * FROM interrupts_v2 WHERE interrupt_id = ?'),
    claimInterrupt: db.prepare(`UPDATE interrupts_v2 SET state = 'resolved' WHERE interrupt_id = ? AND state = 'open'`),
    invalidateInterrupts: db.prepare(`UPDATE interrupts_v2 SET state = 'invalidated' WHERE run_id = ? AND state = 'open'`),
    getIdem: db.prepare('SELECT * FROM idempotency_v2 WHERE tenant = ? AND endpoint = ? AND idem_key = ?'),
    claimIdem: db.prepare('INSERT OR IGNORE INTO idempotency_v2 (tenant, endpoint, idem_key, digest, status, stored_at) VALUES (?, ?, ?, ?, NULL, ?)'),
    completeIdem: db.prepare('UPDATE idempotency_v2 SET status = ?, headers_json = ?, body = ? WHERE tenant = ? AND endpoint = ? AND idem_key = ?'),
    releaseIdem: db.prepare('DELETE FROM idempotency_v2 WHERE tenant = ? AND endpoint = ? AND idem_key = ?'),
    pruneIdem: db.prepare('DELETE FROM idempotency_v2 WHERE stored_at < ?'),
  };

  const loadRunRow = (runId: string): RunRow | null => (q.getRun.get(runId) as RunRow | undefined) ?? null;
  const update = (runId: string, patch: Partial<RunRow>): void => {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE run_id = @run_id`).run({ ...patch, run_id: runId });
  };
  const eraOf = (run: RunRow): number => run.event_log_schema_version ?? 2;
  /** The run's id on the wire: a v1-minted id gains its tenant segment (identity.md §5). */
  const wireId = (run: RunRow): string => (run.run_id.includes('/') ? run.run_id : `${run.tenant}/${run.run_id}`);

  // ─── 2. Identity ───────────────────────────────────────────────────────────
  //
  // One lane: `api-key`. Each configured key is bound to one tenant and resolves
  // to one Subject (identity.md §1.1). The key realm is the issuer.

  const keys = new Map<string, Subject>();
  const subjectFor = (tenant: string, subjectId: string): Subject => ({ issuer: API_KEY_ISSUER, subjectId, tenant, lane: 'api-key', kind: 'user' });
  keys.set(opts.apiKey, subjectFor(opts.tenant, 'primary-key'));
  if (opts.tenantBKey !== null) keys.set(opts.tenantBKey, subjectFor(opts.tenantB, 'tenant-b-key'));

  const authenticate = (req: IncomingMessage): Subject => {
    const h = req.headers['authorization'];
    // A prefix check and a slice, not `/^Bearer\s+(.+)$/i`: that pattern backtracks
    // polynomially on a long run of spaces after the scheme (CodeQL js/polynomial-redos).
    const value = typeof h === 'string' ? h.trim() : '';
    const credential = value.slice(0, 7).toLowerCase() === 'bearer ' ? value.slice(7).trim() : '';
    if (!credential) throw err('unauthenticated', 'a Bearer credential is required', undefined, { 'WWW-Authenticate': 'Bearer' });
    const presented = Buffer.from(credential);
    for (const [key, subject] of keys) {
      const k = Buffer.from(key);
      if (k.length === presented.length && timingSafeEqual(k, presented)) return subject;
    }
    throw err('unauthenticated', 'the credential is not valid', undefined, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  };

  /**
   * Resolve a tenant-bound run id for the caller. The bare (v1) form is refused
   * 400 — this host advertises no 1.x member (identity.md §5). A run the v1 host
   * minted is stored under its bare id and found as `<tenant>/<v1 id>`.
   */
  const runFor = (subject: Subject, id: string): RunRow => {
    if (!id.includes('/')) throw err('validation_error', 'a bare run id is the v1 spelling; this host serves v2 only, so use <tenantId>/<id> (identity.md §5)', { runId: id });
    const { opaque: tail } = checkTenantBound(id, subject.tenant, 'run');
    const run = loadRunRow(id) ?? ((q.getLegacyRun.get(tail, subject.tenant) as RunRow | undefined) ?? null);
    if (!run || run.tenant !== subject.tenant) throw err('not_found', 'run not found');
    return run;
  };

  /** identity.md §1.2 — the owner block, legacy-stamped on first read for a run the v1 host wrote. */
  const ownerOf = (run: RunRow): Owner => {
    if (run.owner_json !== null) return JSON.parse(run.owner_json) as Owner;
    const owner: Owner = { tenant: run.tenant, subject: { issuer: LEGACY_ISSUER, subjectId: 'legacy', tenant: run.tenant, lane: 'api-key', kind: 'user' } };
    update(run.run_id, { owner_json: JSON.stringify(owner) });
    run.owner_json = JSON.stringify(owner);
    return owner;
  };

  // ─── 3. The event log ──────────────────────────────────────────────────────
  //
  // Append-only, `sequence` from 0. Every reader (poll, SSE, snapshot, fork,
  // the executor's own fold) goes through `readEvents`, the storage boundary:
  // an era-2 row is translated there by the reference `rowToDoc`, and nowhere
  // else. Every writer goes through `appendEvent`, which stores the name the
  // run's era requires (persistence.md §The writer rule).

  const lastSequence = (runId: string): number => {
    const r = q.lastSeq.get(runId) as { s: number | null };
    return r.s ?? -1;
  };

  const appendEvent = (run: RunRow, type: string, payload: Record<string, unknown>, nodeId?: string): RunEventDoc => {
    if (!contract.v2EventTypes.has(type)) throw new Error(`producer refused: ${type} is not a registered v2 event type`);
    const sequence = lastSequence(run.run_id) + 1;
    const doc: RunEventDoc = { eventId: opaque(), runId: wireId(run), type, payload, timestamp: nowIso(), sequence, schemaVersion: EVENT_SCHEMA_VERSION, engineVersion: ENGINE_VERSION };
    if (nodeId !== undefined) doc.nodeId = nodeId;
    q.insertEvent.run(run.run_id, sequence, toStorageVocabulary(type, eraOf(run)), nodeId ?? null, JSON.stringify(payload), doc.timestamp, null, doc.eventId, EVENT_SCHEMA_VERSION, ENGINE_VERSION);
    bus.emit(`run:${run.run_id}`, doc);
    return doc;
  };

  const readEvents = (run: RunRow, afterSequence = -1): RunEventDoc[] => {
    const owner = eraOf(run) < 3 ? (ownerOf(run) as unknown as Record<string, unknown>) : null;
    const contractRun = { era: eraOf(run) } as unknown as ContractRunRow;
    return (q.eventsAfter.all(run.run_id, afterSequence) as EventRow[]).map((row) => {
      const contractRow: ContractEventRow = {
        run_id: wireId(run),
        sequence: row.seq,
        // A v1 row carries no eventId; derive a stable one from its key.
        event_id: row.event_id ?? `v1.${createHash('sha256').update(`${row.run_id}:${row.seq}`).digest('hex').slice(0, 24)}`,
        type: row.type,
        payload_json: row.data_json ?? '{}',
        timestamp: row.timestamp,
        node_id: row.node_id,
        causation_id: row.causation_id,
        schema_version: row.schema_version ?? EVENT_SCHEMA_VERSION,
        engine_version: row.engine_version,
      };
      return rowToDoc(contractRow, contractRun, owner);
    });
  };

  // ─── 4. Fixtures ───────────────────────────────────────────────────────────
  //
  // The workflows this host can run are the conformance fixtures whose
  // semantics it honours end to end, read from OPENWOP_FIXTURES_DIR or the
  // installed @openwop/openwop-conformance package.

  const HONOURED = new Set(['conformance-noop', 'conformance-delay', 'conformance-cancellable', 'conformance-multi-node', 'conformance-failure', 'conformance-approval', 'conformance-clarification', 'conformance-interrupt-external-event', 'conformance-idempotent']);
  const EXECUTABLE = new Set(['core.noop', 'core.identity', 'core.delay', 'core.fail', 'core.approvalGate', 'core.clarificationGate', 'core.interrupt']);
  const workflows = new Map<string, Workflow>();
  const fixtureDirs: string[] = [];
  if (opts.fixturesDir) fixtureDirs.push(opts.fixturesDir);
  try { fixtureDirs.push(join(dirname(pkgRequire.resolve('@openwop/openwop-conformance/package.json')), 'fixtures')); } catch { /* optional dev dependency */ }
  for (const dir of fixtureDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const def = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Workflow;
        if (!HONOURED.has(def.id) || workflows.has(def.id) || !def.nodes.every((n) => EXECUTABLE.has(n.typeId))) continue;
        workflows.set(def.id, def);
      } catch { /* skip an unreadable file */ }
    }
  }
  if (!workflows.has('conformance-noop')) workflows.set('conformance-noop', { id: 'conformance-noop', nodes: [{ id: 'noop', typeId: 'core.noop' }] });
  const approval = workflows.get('conformance-approval');
  if (approval) {
    // approver enforcement: the same gate, eligible only to a principal the caller is not.
    const gate = approval.nodes[0] as WorkflowNode;
    workflows.set('conformance-approval-approvers', { ...approval, id: 'conformance-approval-approvers', nodes: [{ ...gate, config: { ...(gate.config ?? {}), approversList: ['urn:conformance:listed-approver'] } }] });
  }

  // ─── 5. Claims ─────────────────────────────────────────────────────────────
  //
  // A process executes a run only while it holds the run's claim. The claim is
  // a lease: `claim_expires_at` is renewed every heartbeat, and a claim that is
  // not renewed lapses, so the next process to look can take the run over.

  const active = new Map<string, Promise<void>>();
  let closing = false;
  const heartbeats = new Map<string, NodeJS.Timeout>();
  const tryClaim = (runId: string): boolean => q.claim.run(processId, Date.now() + opts.claimTtlMs, runId, processId, Date.now()).changes === 1;
  const startHeartbeat = (runId: string): void => {
    const h = setInterval(() => { q.renew.run(Date.now() + opts.claimTtlMs, runId, processId); }, opts.heartbeatMs);
    h.unref();
    heartbeats.set(runId, h);
  };
  const releaseClaim = (runId: string): void => {
    const h = heartbeats.get(runId);
    if (h) clearInterval(h);
    heartbeats.delete(runId);
    q.release.run(runId, processId);
  };
  /** Whether another live process holds the run's claim. */
  const claimedElsewhere = (run: RunRow): boolean => run.claim_holder_id !== null && run.claim_holder_id !== processId && (run.claim_expires_at ?? 0) >= Date.now();

  // ─── 6. Executor ───────────────────────────────────────────────────────────
  //
  // The log is the executor's only state: every step re-folds the run's events,
  // so a restart, a resumed interrupt and a fork all continue from what is
  // recorded. Nodes run in topological order; any node failure ends the run.

  interface Folded {
    started: boolean;
    startedAt: string | null;
    completed: Set<string>;
    outputs: Map<string, Record<string, unknown>>;
    attempts: Map<string, number>;
    starts: number;
    requested: Map<string, string>;
    resolved: Map<string, Record<string, unknown>>;
    resumed: Map<string, unknown>;
    resolvedCount: Map<string, number>;
  }

  const fold = (events: RunEventDoc[]): Folded => {
    const st: Folded = { started: false, startedAt: null, completed: new Set(), outputs: new Map(), attempts: new Map(), starts: 0, requested: new Map(), resolved: new Map(), resumed: new Map(), resolvedCount: new Map() };
    for (const e of events) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const n = e.nodeId ?? (typeof p['nodeId'] === 'string' ? p['nodeId'] : undefined);
      if (e.type === 'run.started') { st.started = true; st.startedAt = e.timestamp; }
      if (n === undefined) continue;
      switch (e.type) {
        case 'node.started': st.starts++; st.attempts.set(n, (st.attempts.get(n) ?? 0) + 1); st.requested.delete(n); st.resolved.delete(n); st.resumed.delete(n); break;
        case 'interrupt.requested': if (typeof p['key'] === 'string') st.requested.set(n, p['key']); break;
        case 'interrupt.resolved': st.requested.delete(n); st.resolved.set(n, p); st.resolvedCount.set(n, (st.resolvedCount.get(n) ?? 0) + 1); break;
        case 'node.resumed': st.resolved.delete(n); st.resumed.set(n, p['resumeValue']); break;
        case 'node.completed': st.completed.add(n); st.outputs.set(n, (p['outputs'] ?? {}) as Record<string, unknown>); st.resumed.delete(n); st.resolved.delete(n); st.requested.delete(n); break;
        default: break;
      }
    }
    return st;
  };

  const edgesOf = (def: Workflow): Array<{ from: string; to: string }> => (def.edges ?? []).map((e) => ({
    from: String(e['sourceNodeId'] ?? e['source'] ?? e['from'] ?? ''),
    to: String(e['targetNodeId'] ?? e['target'] ?? e['to'] ?? ''),
  }));
  const order = (def: Workflow): WorkflowNode[] => {
    const indeg = new Map(def.nodes.map((n) => [n.id, 0] as [string, number]));
    const next = new Map<string, string[]>();
    for (const { from, to } of edgesOf(def)) {
      if (!indeg.has(from) || !indeg.has(to)) continue;
      next.set(from, [...(next.get(from) ?? []), to]);
      indeg.set(to, (indeg.get(to) ?? 0) + 1);
    }
    const ready = def.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const out: WorkflowNode[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as string;
      out.push(def.nodes.find((n) => n.id === id) as WorkflowNode);
      for (const t of next.get(id) ?? []) { indeg.set(t, (indeg.get(t) ?? 1) - 1); if (indeg.get(t) === 0) ready.push(t); }
    }
    return out;
  };

  const optionsOf = (run: RunRow): { configurable?: { run?: { recursionLimit?: number; runTimeoutMs?: number } }; tags?: string[]; metadata?: Record<string, unknown> } =>
    JSON.parse(run.options_json ?? '{}') as ReturnType<typeof optionsOf>;
  const recursionLimit = (run: RunRow): number => {
    const asked = optionsOf(run).configurable?.run?.recursionLimit;
    return typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_NODE_EXECUTIONS) : MAX_NODE_EXECUTIONS;
  };
  const runDeadlineMs = (run: RunRow): number => Math.min(optionsOf(run).configurable?.run?.runTimeoutMs ?? opts.maxRunDurationMs, opts.maxRunDurationMs);

  const inputOf = (run: RunRow, def: Workflow, node: WorkflowNode, name: string): unknown => {
    const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
    const binding = node.inputs?.[name] as { type?: string; variableName?: string; value?: unknown } | undefined;
    if (binding && binding.type === 'variable' && binding.variableName) {
      return inputs[binding.variableName] ?? def.variables?.find((v) => v.name === binding.variableName)?.defaultValue;
    }
    if (binding && 'value' in binding) return binding.value;
    return inputs[name] ?? node.config?.[name];
  };

  /**
   * A replay fork keys its interrupts on its source (replay.md §Suppression), so
   * K is the source chain's root run; every other run keys on itself.
   */
  const keyRunId = (run: RunRow): string => {
    let r = run;
    while (r.fork_mode === 'replay' && r.parent_run_id !== null) {
      const src = loadRunRow(r.parent_run_id);
      if (!src) break;
      r = src;
    }
    return wireId(r);
  };

  /** interrupt.md §Re-entry — K derives from the run, the node and the node's visit index. */
  const interruptFor = (run: RunRow, node: WorkflowNode, visit: number): InterruptPayload => {
    const key = `${keyRunId(run)}:${node.id}:${visit}`;
    const c = node.config ?? {};
    if (node.typeId === 'core.approvalGate') {
      const data: Record<string, unknown> = { artifactId: node.id, artifactType: 'conformance-artifact', title: String(c['title'] ?? `Approve ${node.id}`), actions: Array.isArray(c['actions']) ? c['actions'] : ['accept', 'reject'] };
      if (typeof c['description'] === 'string') data['description'] = c['description'];
      if (Array.isArray(c['approversList'])) data['approversList'] = c['approversList'];
      return { kind: 'approval', key, data };
    }
    if (node.typeId === 'core.clarificationGate') {
      const questions = Array.isArray(c['questions']) ? c['questions'] : [{ id: 'q1', question: String(c['question'] ?? 'Please clarify') }];
      return { kind: 'clarification', key, data: { questions } };
    }
    const payload: InterruptPayload = { kind: String(c['kind'] ?? 'custom'), key, data: (c['data'] as Record<string, unknown> | undefined) ?? { customKind: node.id } };
    if (typeof c['timeoutMs'] === 'number') payload.timeoutMs = c['timeoutMs'];
    if (c['resumeSchema'] !== null && typeof c['resumeSchema'] === 'object') payload.resumeSchema = c['resumeSchema'] as Record<string, unknown>;
    return payload;
  };

  /** Sleep, checking the durable flags — a cancel or an immediate pause may come from any process. */
  const sleepChecked = async (run: RunRow, ms: number, deadline: number): Promise<'done' | 'cancelled' | 'paused' | 'timeout'> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (closing) throw new HostClosing();
      const fresh = loadRunRow(run.run_id);
      if (!fresh || fresh.cancel_requested === 1 || TERMINAL.has(fresh.status)) return 'cancelled';
      if (fresh.status === 'paused') return 'paused';
      if (Date.now() > deadline) return 'timeout';
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, until - Date.now()))));
    }
    return 'done';
  };

  const executeNode = async (run: RunRow, def: Workflow, node: WorkflowNode, visit: number, deadline: number): Promise<NodeResult> => {
    switch (node.typeId) {
      case 'core.noop': return { outputs: {} };
      case 'core.identity': return { outputs: Object.fromEntries(Object.keys(node.inputs ?? {}).map((k) => [k, inputOf(run, def, node, k)])) };
      case 'core.delay': {
        const ms = Math.max(0, Math.min(60_000, Number(inputOf(run, def, node, 'delayMs') ?? 1000) || 0));
        const r = await sleepChecked(run, ms, deadline);
        return r === 'done' ? { outputs: { sleptMs: ms } } : r;
      }
      // fixtures.md §core.fail: a vendor code under the reserved `example` org.
      case 'core.fail': throw new NodeFailure('example.conformance_failure', String(node.config?.['message'] ?? 'Intentional conformance failure'));
      case 'core.approvalGate':
      case 'core.clarificationGate':
      case 'core.interrupt': return { suspend: interruptFor(run, node, visit) };
      default: throw new NodeFailure('capability_required', `node type ${node.typeId} is not executed by this host`);
    }
  };

  const durationSince = (startedAt: string | null): number => (startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0);

  const finish = (run: RunRow, status: 'completed' | 'failed' | 'cancelled', error: Record<string, unknown> | null): void => {
    q.invalidateInterrupts.run(run.run_id);
    update(run.run_id, { status, ended_at: nowIso(), error_json: error ? JSON.stringify(error) : null, current_node_id: null, cancel_requested: 0, pause_requested: null });
    run.status = status;
  };
  const failRun = (run: RunRow, error: Record<string, unknown>, startedAt: string | null, failedNodeId?: string): void => {
    const payload: Record<string, unknown> = { error, durationMs: durationSince(startedAt) };
    if (failedNodeId !== undefined) payload['failedNodeId'] = failedNodeId;
    appendEvent(run, 'run.failed', payload);
    finish(run, 'failed', error);
  };
  const cancelNow = (run: RunRow, reason: string, startedAt: string | null): void => {
    appendEvent(run, 'run.cancelled', { reason, cancelledBy: 'caller', durationMs: durationSince(startedAt) });
    finish(run, 'cancelled', null);
  };

  /** Look up the recorded resolution of K in the run's log, then each replay source's. */
  const recordedResolution = (run: RunRow, key: string): Record<string, unknown> | null => {
    for (let r: RunRow | null = run; r !== null; r = r.fork_mode === 'replay' && r.parent_run_id !== null ? loadRunRow(r.parent_run_id) : null) {
      const events = readEvents(r);
      const suspended = events.find((e) => e.type === 'node.suspended' && (e.payload as { key?: unknown }).key === key);
      if (!suspended) continue;
      const interruptId = (suspended.payload as { interruptId?: unknown }).interruptId;
      const resolved = events.find((e) => e.type === 'interrupt.resolved' && (e.payload as { interruptId?: unknown }).interruptId === interruptId);
      if (resolved) return resolved.payload as Record<string, unknown>;
    }
    return null;
  };

  /** What a recorded `interrupt.resolved` does to its node: resume and complete, or fail the run on a rejection. */
  const applyResolution = (run: RunRow, nodeId: string, resolved: Record<string, unknown>, startedAt: string | null): 'resumed' | 'failed' => {
    if (resolved['decision'] === 'rejected') {
      const error = { code: 'approval_rejected', message: 'the approval was rejected', retryable: false };
      appendEvent(run, 'node.failed', { nodeId, error, attempts: 1 }, nodeId);
      failRun(run, error, startedAt, nodeId);
      return 'failed';
    }
    const resumeValue = resolved['resumeValue'];
    const resumed: Record<string, unknown> = { nodeId, resumeValue };
    if (typeof resolved['interruptId'] === 'string') resumed['interruptId'] = resolved['interruptId'];
    appendEvent(run, 'node.resumed', resumed, nodeId);
    appendEvent(run, 'node.completed', { nodeId, outputs: { resumeValue } }, nodeId);
    return 'resumed';
  };

  const waitingStatus = (kind: string): string => (kind === 'external-event' ? 'waiting-external' : kind === 'clarification' ? 'waiting-input' : 'waiting-approval');

  const mintToken = (interruptId: string, runId: string, expiresAt: number): string => {
    const payload = Buffer.from(JSON.stringify({ i: interruptId, r: runId, e: expiresAt, t: 'resolve' })).toString('base64url');
    const mac = createHmac('sha256', tokenSecret).update(`hs256.${TOKEN_KID}.${payload}`).digest('hex');
    return `ow2.hs256.${TOKEN_KID}.${payload}.${mac}`;
  };

  const suspend = (run: RunRow, node: WorkflowNode, payload: InterruptPayload): void => {
    const interruptId = tenantBound(run.tenant);
    const ttl = payload.timeoutMs !== undefined && payload.timeoutMs > 0 ? Math.min(payload.timeoutMs, TOKEN_DEFAULT_TTL_MS) : TOKEN_DEFAULT_TTL_MS;
    const expiresAt = Date.now() + ttl;
    q.insertInterrupt.run(interruptId, run.run_id, node.id, payload.key, JSON.stringify(payload), expiresAt, nowIso());
    appendEvent(run, 'interrupt.requested', payload as unknown as Record<string, unknown>, node.id);
    appendEvent(run, 'node.suspended', { nodeId: node.id, interruptId, kind: payload.kind, key: payload.key }, node.id);
    update(run.run_id, { status: waitingStatus(payload.kind), current_node_id: node.id });
    if (opts.logResumeTokens) console.log(`[${HOST_NAME}] ${interruptId} awaits resolution; resume token ${mintToken(interruptId, wireId(run), expiresAt)}`);
  };

  /** Enter (or re-enter) the loop for a run, if this process can claim it. One loop per run per process. */
  const rewake = new Set<string>();
  const scheduleRun = (runId: string): void => {
    if (closing) return;
    // A loop that is still unwinding (a pause, say, that a resume overtook) re-enters once it exits.
    if (active.has(runId)) { rewake.add(runId); return; }
    if (!tryClaim(runId)) return;
    startHeartbeat(runId);
    const loop = new Promise<void>((ok) => setImmediate(ok))
      .then(() => continueRun(runId))
      .catch((e: unknown) => { if (!(e instanceof HostClosing)) console.error(`[${HOST_NAME}] executor ${runId}:`, e); })
      .finally(() => {
        active.delete(runId);
        releaseClaim(runId);
        if (rewake.delete(runId)) scheduleRun(runId);
      });
    active.set(runId, loop);
  };

  const continueRun = async (runId: string): Promise<void> => {
    let run = loadRunRow(runId);
    if (!run || TERMINAL.has(run.status) || run.status === 'paused' || WAITING.has(run.status)) return;
    const def = workflows.get(run.workflow_id);
    let st = fold(readEvents(run));
    if (!def) { failRun(run, { code: 'not_found', message: `workflow ${run.workflow_id} is not registered on this host` }, st.startedAt); return; }
    let startedAt = st.startedAt;
    if (!st.started) {
      const options = optionsOf(run);
      const payload: Record<string, unknown> = { workflowId: run.workflow_id, inputs: JSON.parse(run.inputs_json), transport: 'rest', engineVersion: ENGINE_VERSION, owner: ownerOf(run) };
      if (options.tags) payload['tags'] = options.tags;
      if (options.metadata) payload['metadata'] = options.metadata;
      startedAt = appendEvent(run, 'run.started', payload).timestamp;
      update(run.run_id, { status: 'running', started_at: startedAt });
    } else if (run.status === 'pending') {
      update(run.run_id, { status: 'running' });
    }
    // A fork's copied prefix carries its source's `run.started`; the child's own clock starts when it was created.
    if (run.fork_mode !== null && run.created_at !== null && (startedAt === null || run.created_at > startedAt)) startedAt = run.created_at;
    const deadline = Date.parse(startedAt ?? nowIso()) + runDeadlineMs(run);
    const limit = recursionLimit(run);
    const nodes = order(def);
    for (;;) {
      if (closing) throw new HostClosing();
      run = loadRunRow(runId) as RunRow;
      if (TERMINAL.has(run.status) || run.status === 'paused') return;
      st = fold(readEvents(run));
      if (run.cancel_requested === 1) { cancelNow(run, run.cancel_reason ?? 'caller-requested', startedAt); return; }
      if (run.pause_requested !== null) {
        appendEvent(run, 'run.paused', { reason: 'operator', drainPolicy: run.pause_requested });
        update(run.run_id, { status: 'paused', pause_requested: null });
        return;
      }
      const node = nodes.find((n) => !st.completed.has(n.id));
      if (!node) break;
      // A fork cut between `node.resumed` and `node.completed` finishes the node from the log.
      if (st.resumed.has(node.id)) { appendEvent(run, 'node.completed', { nodeId: node.id, outputs: { resumeValue: st.resumed.get(node.id) } }, node.id); continue; }
      let recorded = st.resolved.get(node.id);
      const requestedKey = st.requested.get(node.id);
      if (recorded === undefined && requestedKey !== undefined && run.fork_mode === 'replay') {
        const replayed = recordedResolution(run, requestedKey);
        if (replayed) { appendEvent(run, 'interrupt.resolved', replayed, node.id); recorded = replayed; }
      }
      if (recorded !== undefined) { if (applyResolution(run, node.id, recorded, startedAt) === 'failed') return; continue; }
      if (st.starts >= limit) {
        appendEvent(run, 'cap.breached', { kind: 'node-executions', limit, observed: st.starts + 1 });
        failRun(run, { code: 'recursion_limit_exceeded', message: `starting ${node.id} would exceed recursionLimit ${limit}` }, startedAt);
        return;
      }
      if (Date.now() > deadline) {
        const observed = Math.max(durationSince(startedAt), runDeadlineMs(run) + 1);
        appendEvent(run, 'cap.breached', { kind: 'run-duration', limit: runDeadlineMs(run), observed });
        failRun(run, { code: 'run_timeout', message: `the run exceeded its ${runDeadlineMs(run)} ms deadline` }, startedAt);
        return;
      }
      const attempt = st.attempts.get(node.id) ?? 0;
      const nodeStart = Date.now();
      appendEvent(run, 'node.started', { nodeId: node.id, typeId: node.typeId, attempt }, node.id);
      let result: NodeResult;
      try {
        result = await executeNode(run, def, node, st.resolvedCount.get(node.id) ?? 0, deadline);
      } catch (e) {
        const error = e instanceof NodeFailure ? { code: e.code, message: e.message } : { code: 'internal_error', message: 'the node failed unexpectedly' };
        run = loadRunRow(runId) as RunRow;
        appendEvent(run, 'node.failed', { nodeId: node.id, error, attempts: attempt + 1 }, node.id);
        failRun(run, error, startedAt, node.id);
        return;
      }
      run = loadRunRow(runId) as RunRow;
      // An immediate pause was recorded by the request (section 11) and cut this attempt: record nothing more.
      if (TERMINAL.has(run.status) || run.status === 'paused') return;
      if (result === 'cancelled') { appendEvent(run, 'node.cancelled', { nodeId: node.id, reason: 'run-cancelled' }, node.id); cancelNow(run, run.cancel_reason ?? 'caller-requested', startedAt); return; }
      if (result === 'paused') return;
      if (result === 'timeout') continue; // the deadline check above records the breach
      if ('suspend' in result) {
        const replayed = run.fork_mode === 'replay' ? recordedResolution(run, result.suspend.key) : null;
        if (replayed) {
          appendEvent(run, 'interrupt.resolved', replayed, node.id);
          if (applyResolution(run, node.id, replayed, startedAt) === 'failed') return;
          continue;
        }
        suspend(run, node, result.suspend);
        return;
      }
      appendEvent(run, 'node.completed', { nodeId: node.id, outputs: result.outputs, durationMs: Date.now() - nodeStart }, node.id);
    }
    run = loadRunRow(runId) as RunRow;
    if (TERMINAL.has(run.status)) return;
    const sources = new Set(edgesOf(def).map((e) => e.from));
    const outputs: Record<string, unknown> = {};
    for (const n of def.nodes) if (!sources.has(n.id)) Object.assign(outputs, st.outputs.get(n.id) ?? {});
    appendEvent(run, 'run.completed', { outputs, durationMs: durationSince(startedAt) });
    finish(run, 'completed', null);
  };

  /** runs.md §Cancel — terminal now when nothing is executing; otherwise the executing process finishes it. */
  const requestCancel = (run: RunRow, reason: string): string => {
    if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be cancelled`, { runStatus: run.status });
    if (active.has(run.run_id) || claimedElsewhere(run)) {
      update(run.run_id, { status: 'cancelling', cancel_requested: 1, cancel_reason: reason });
      return 'cancelling';
    }
    const st = fold(readEvents(run));
    if (run.current_node_id !== null) appendEvent(run, 'node.cancelled', { nodeId: run.current_node_id, reason: 'run-cancelled' }, run.current_node_id);
    cancelNow(run, reason, st.startedAt);
    return 'cancelled';
  };

  // ─── 7. Interrupts ─────────────────────────────────────────────────────────

  const principalRef = (s: Subject): string => `${s.issuer}#${s.subjectId}`;

  const validateResume = (payload: InterruptPayload, resumeValue: unknown, subject: Subject | null): { exits: boolean; decision?: string; action?: string } => {
    if (payload.kind === 'approval') {
      const rv = resumeValue as { action?: unknown; refineFeedback?: unknown; editedArtifactData?: unknown } | null;
      const actions = (payload.data['actions'] as string[] | undefined) ?? ['accept', 'reject'];
      const action = rv !== null && typeof rv === 'object' ? rv.action : undefined;
      if (typeof action !== 'string' || action === 'timeout' || !actions.includes(action)) throw err('validation_error', `resumeValue.action MUST be one of the gate's actions [${actions.join(', ')}]`, { field: 'resumeValue.action' });
      if (action === 'refine' && (rv?.refineFeedback === null || typeof rv?.refineFeedback !== 'object')) throw err('validation_error', 'refine requires refineFeedback', { field: 'resumeValue.refineFeedback' });
      if (action === 'edit-accept' && rv?.editedArtifactData === undefined) throw err('validation_error', 'edit-accept requires editedArtifactData', { field: 'resumeValue.editedArtifactData' });
      const approvers = payload.data['approversList'];
      if (Array.isArray(approvers) && (subject === null || !approvers.includes(principalRef(subject)))) throw err('forbidden', 'the resolver is not in the gate\'s approversList');
      if (action === 'ask') return { exits: false, action };
      return { exits: true, action, decision: action === 'reject' ? 'rejected' : 'granted' };
    }
    if (payload.kind === 'clarification' && resumeValue !== null && typeof resumeValue === 'object' && Array.isArray((resumeValue as { answers?: unknown }).answers)) {
      const ids = new Set(((payload.data['questions'] as Array<{ id?: unknown }> | undefined) ?? []).map((x) => String(x.id)));
      for (const a of (resumeValue as { answers: Array<{ id?: unknown }> }).answers) {
        if (a === null || typeof a !== 'object' || !ids.has(String(a.id))) throw err('validation_error', 'every answer id MUST be a question id', { field: 'resumeValue.answers' });
      }
    }
    const required = payload.resumeSchema?.['required'];
    if (Array.isArray(required)) {
      if (resumeValue === null || typeof resumeValue !== 'object' || required.some((k) => !(String(k) in (resumeValue as object)))) throw err('validation_error', 'resumeValue fails the interrupt\'s resumeSchema', { required });
    }
    return { exits: true };
  };

  /** Both resolve surfaces converge here: validate, claim the interrupt atomically, record, resume. */
  const resolve = (run: RunRow, row: InterruptRow, resumeValue: unknown, subject: Subject | null): { runId: string; nodeId: string; status: string } => {
    if (TERMINAL.has(run.status)) throw err('interrupt_already_resolved', `the run is ${run.status}`);
    const payload = JSON.parse(row.payload_json) as InterruptPayload;
    const v = validateResume(payload, resumeValue, subject);
    if (!v.exits) return { runId: wireId(run), nodeId: row.node_id, status: run.status };
    if (q.claimInterrupt.run(row.interrupt_id).changes !== 1) throw err('interrupt_already_resolved', 'the interrupt is already resolved');
    const resolved: Record<string, unknown> = { nodeId: row.node_id, interruptId: row.interrupt_id, kind: payload.kind, resumeValue };
    if (subject !== null) resolved['resolvedBy'] = subject;
    if (v.decision !== undefined) resolved['decision'] = v.decision;
    if (v.action !== undefined) resolved['action'] = v.action;
    const rv = resumeValue as { refineFeedback?: unknown; editedArtifactData?: unknown } | null;
    if (v.action === 'refine') resolved['refineFeedback'] = rv?.refineFeedback;
    if (v.action === 'edit-accept') resolved['editedArtifactData'] = rv?.editedArtifactData;
    appendEvent(run, 'interrupt.resolved', resolved, row.node_id);
    const startedAt = fold(readEvents(run)).startedAt;
    if (applyResolution(run, row.node_id, resolved, startedAt) === 'failed') return { runId: wireId(run), nodeId: row.node_id, status: 'failed' };
    update(run.run_id, { status: 'running', current_node_id: null });
    scheduleRun(run.run_id);
    return { runId: wireId(run), nodeId: row.node_id, status: 'running' };
  };

  /** identity.md §4 — `ow2.<alg>.<kid>.<payload>.<mac>`; one registered code per refusal. */
  const verifyToken = (token: string): InterruptRow => {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'ow2') throw err('interrupt_token_invalid', 'the token is outside the ow2.<alg>.<kid>.<payload>.<mac> grammar');
    const [, alg, kid, payload, given] = parts as [string, string, string, string, string];
    if (alg !== 'hs256') throw err('interrupt_token_invalid', `alg ${alg} is not in interrupt.tokenAlgs`);
    if (kid !== TOKEN_KID) throw err('interrupt_token_invalid', `kid ${kid} is not held by this host`);
    const expected = Buffer.from(createHmac('sha256', tokenSecret).update(`hs256.${kid}.${payload}`).digest('hex'));
    const presented = Buffer.from(given);
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) throw err('interrupt_token_invalid', 'the token MAC does not verify');
    let claims: { i?: unknown; e?: unknown };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims; } catch { throw err('interrupt_token_invalid', 'the token payload is unreadable'); }
    const row = typeof claims.i === 'string' ? (q.interruptById.get(claims.i) as InterruptRow | undefined) : undefined;
    if (!row) throw err('interrupt_token_invalid', 'the token names no interrupt on this host');
    if (typeof claims.e === 'number' && Date.now() > claims.e) throw err('interrupt_expired', 'the token is past its expiresAt');
    if (row.state !== 'open') throw err('interrupt_already_resolved', 'the interrupt is already resolved, or its run ended');
    return row;
  };

  /**
   * persistence.md §Runs pinned to v1 — a run suspended on an interrupt at the
   * cut continues. The v1 host recorded the suspension only in its own
   * `interrupts` table and as a v1 `node.suspended`; the first v2 resolve
   * adopts it into `interrupts_v2` from the (translated) log, and the run goes
   * on under the writer rule: its era-2 log keeps v1 vocabulary.
   */
  const legacySuspension = (run: RunRow): { nodeId: string; data: Record<string, unknown> } | null => {
    if (eraOf(run) >= 3 || !WAITING.has(run.status)) return null;
    let open: { nodeId: string; data: Record<string, unknown> } | null = null;
    for (const e of readEvents(run)) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const n = e.nodeId ?? (typeof p['nodeId'] === 'string' ? p['nodeId'] : undefined);
      if (e.type === 'node.suspended' && n !== undefined) open = { nodeId: n, data: p };
      if ((e.type === 'node.resumed' || e.type === 'node.completed' || e.type === 'node.failed') && n === open?.nodeId) open = null;
    }
    return open;
  };
  const adoptLegacyInterrupt = (run: RunRow, nodeId: string): InterruptRow | undefined => {
    const legacy = legacySuspension(run);
    if (legacy === null || legacy.nodeId !== nodeId) return undefined;
    const config = (legacy.data['config'] ?? {}) as Record<string, unknown>;
    const kind = String(legacy.data['kind'] ?? 'custom');
    const typeId = kind === 'approval' ? 'core.approvalGate' : kind === 'clarification' ? 'core.clarificationGate' : 'core.interrupt';
    const payload = interruptFor(run, { id: nodeId, typeId, config: kind === 'approval' || kind === 'clarification' ? config : { kind, data: { customKind: nodeId } } }, 0);
    q.insertInterrupt.run(tenantBound(run.tenant), run.run_id, nodeId, payload.key, JSON.stringify(payload), Date.now() + TOKEN_DEFAULT_TTL_MS, nowIso());
    return q.openInterrupt.get(run.run_id, nodeId) as InterruptRow;
  };

  // ─── 8. Projections ────────────────────────────────────────────────────────

  const snapshot = (run: RunRow): Record<string, unknown> => {
    const options = optionsOf(run);
    const snap: Record<string, unknown> = { runId: wireId(run), workflowId: run.workflow_id, status: run.status, owner: ownerOf(run), eventLogSchemaVersion: eraOf(run), inputs: JSON.parse(run.inputs_json) as unknown };
    if (run.engine_version !== null) snap['engineVersion'] = run.engine_version;
    if (run.status !== 'pending') snap['startedAt'] = run.started_at;
    if (run.ended_at !== null) snap['completedAt'] = run.ended_at;
    const currentNodeId = run.current_node_id ?? legacySuspension(run)?.nodeId ?? null;
    if (WAITING.has(run.status) && currentNodeId !== null) snap['currentNodeId'] = currentNodeId;
    if (run.status === 'failed' && run.error_json !== null) {
      const e = JSON.parse(run.error_json) as { code?: unknown; message?: unknown };
      snap['error'] = { code: String(e.code ?? 'internal_error'), message: String(e.message ?? 'the run failed') };
    }
    if (options.configurable !== undefined) snap['configurable'] = options.configurable;
    if (options.tags !== undefined) snap['tags'] = options.tags;
    if (options.metadata !== undefined) snap['metadata'] = options.metadata;
    if (run.parent_run_id !== null) {
      const parent = loadRunRow(run.parent_run_id);
      snap['parentRunId'] = parent ? wireId(parent) : run.parent_run_id;
    }
    return snap;
  };

  /** events.md §Stream modes — the one grammar; this host serves all four modes. */
  const STREAM_MODE = /^(values|(updates|messages|debug)(,(updates|messages|debug))*)$/;
  const parseStreamModes = (raw: string | null): string[] => {
    const value = raw === null || raw === '' ? 'updates' : raw;
    if (!STREAM_MODE.test(value)) throw err('unsupported_stream_mode', `streamMode ${value} is outside the grammar`, { supported: ['updates', 'values', 'messages', 'debug'] });
    return value.split(',');
  };
  const DEBUG_ONLY = new Set(['log.appended', 'variable.changed', 'version.pinned', 'lease.acquired', 'lease.renewed', 'lease.lost', 'lease.handed-off', 'node.retried']);
  /** events.md §Stream modes — which mode admits an event, or null. */
  const admittedBy = (modes: string[], type: string): string | null => {
    for (const mode of modes) {
      if (mode === 'debug') return 'debug';
      if ((mode === 'updates' || mode === 'values') && !DEBUG_ONLY.has(type)) return mode;
      if (mode === 'messages' && type === 'output.chunk') return 'messages';
    }
    return null;
  };

  // ─── 9. The front door ─────────────────────────────────────────────────────
  //
  // versioning.md §1.3: one major is served, 2. No header, `2` or `2.<n>` is
  // served under it; any other major is 406; a malformed header is 400. Every
  // protocol response carries `OpenWOP-Version: 2.0` (§1.4), refusals included.

  interface Reply { status: number; body?: unknown; headers?: Record<string, string> }
  interface Ctx {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    params: Record<string, string>;
    subject: Subject | null;
    baseUrl: string;
    body(): Promise<Record<string, unknown>>;
    rawBody(): Promise<string>;
    header(name: string): string | null;
  }
  type Handler = (ctx: Ctx) => Promise<Reply | 'streamed'>;
  interface Route { method: string; pattern: RegExp; auth: boolean; handler: Handler }

  const routes: Route[] = [];
  const route = (method: string, path: string, auth: boolean, handler: Handler): void => {
    const re = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, pattern: re, auth, handler });
  };

  const BOUND_PARAMS = new Set(['runId']);
  const send = (res: ServerResponse, reply: Reply): void => {
    const headers: Record<string, string> = { 'OpenWOP-Version': PROTOCOL_VERSION, ...(reply.headers ?? {}) };
    if (reply.body === undefined) { res.writeHead(reply.status, headers); res.end(); return; }
    headers['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(reply.status, headers);
    res.end(JSON.stringify(reply.body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const raw = req.headers['openwop-version'];
      const version = typeof raw === 'string' ? raw.trim() : '';
      if (version !== '') {
        const m = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/.exec(version);
        if (!m) throw err('validation_error', 'OpenWOP-Version MUST be <major> or <major>.<minor>', { header: 'OpenWOP-Version' });
        if (m[1] !== '2') throw err('protocol_version_unsupported', `major ${m[1]} is not served by this host`, { protocolVersions: [PROTOCOL_VERSION] });
      }
      const method = (req.method ?? 'GET').toUpperCase();
      let matched: Route | undefined;
      let groups: Record<string, string> = {};
      let pathSeen = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        pathSeen = true;
        if (r.method !== method) continue;
        matched = r;
        groups = m.groups ?? {};
        break;
      }
      if (!matched) throw err('not_found', pathSeen ? `${method} is not served at ${url.pathname}` : `no operation at ${url.pathname}`);
      const params = Object.fromEntries(Object.entries(groups).map(([k, v]) => {
        const decoded = decodeURIComponent(v);
        return [k, BOUND_PARAMS.has(k) ? unprojectBoundId(decoded) : decoded];
      }));
      const subject = matched.auth ? authenticate(req) : null;
      let cached: string | null = null;
      const rawBody = async (): Promise<string> => {
        if (cached !== null) return cached;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          total += (c as Buffer).length;
          if (total > MAX_REQUEST_BODY_BYTES) throw err('validation_error', 'the request body exceeds limits.maxRequestBodyBytes', { maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES });
          chunks.push(c as Buffer);
        }
        cached = Buffer.concat(chunks).toString('utf8');
        return cached;
      };
      const ctx: Ctx = {
        req, res, url, params, subject,
        baseUrl: `${(req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'}://${req.headers['host'] ?? `${opts.host}:${opts.port}`}`,
        rawBody,
        body: async () => {
          const text = await rawBody();
          if (text.trim() === '') return {};
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw err('validation_error', 'the request body is not JSON'); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('validation_error', 'the request body MUST be a JSON object');
          return parsed as Record<string, unknown>;
        },
        header: (name) => { const v = req.headers[name.toLowerCase()]; return typeof v === 'string' ? v : null; },
      };
      const reply = await matched.handler(ctx);
      if (reply !== 'streamed') send(res, reply);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HostError) { send(res, { status: e.status, body: e.body(), headers: e.headers }); return; }
      console.error(`[${HOST_NAME}] unhandled error:`, e);
      send(res, { status: 500, body: { error: 'internal_error', message: 'the host failed to serve the request' } });
    }
  };

  /**
   * idempotency.md §Layer 1 — keyed (tenant, endpoint, key); a final outcome is
   * replayed with `OpenWOP-Idempotent-Replay: true`; another digest under the
   * key is 409 idempotency_key_mismatch; a concurrent duplicate is 409
   * idempotency_in_flight; 400/401/403/429/5xx are never cached.
   */
  const withIdempotency = async (ctx: Ctx, endpoint: string, fn: () => Promise<Reply>): Promise<Reply> => {
    const key = ctx.header('idempotency-key');
    if (key === null || ctx.subject === null) return fn();
    if (!IDEMPOTENCY_KEY.test(key)) throw err('idempotency_key_invalid', 'Idempotency-Key MUST match ^[A-Za-z0-9._~-]{22,128}$');
    const tenant = ctx.subject.tenant;
    const digest = createHash('sha256').update(`${ctx.url.pathname}\n${await ctx.rawBody()}`).digest('hex');
    q.pruneIdem.run(Date.now() - 24 * 3_600_000);
    const existing = q.getIdem.get(tenant, endpoint, key) as { digest: string; status: number | null; headers_json: string | null; body: string | null } | undefined;
    if (existing) {
      if (existing.digest !== digest) throw err('idempotency_key_mismatch', 'a different request was presented under the same Idempotency-Key');
      if (existing.status === null) throw err('idempotency_in_flight', 'a request under this Idempotency-Key is in flight', undefined, { 'Retry-After': '1' });
      const replay: Reply = { status: existing.status, headers: { ...(JSON.parse(existing.headers_json ?? '{}') as Record<string, string>), 'OpenWOP-Idempotent-Replay': 'true' } };
      if (existing.body !== null) replay.body = JSON.parse(existing.body);
      return replay;
    }
    if (q.claimIdem.run(tenant, endpoint, key, digest, Date.now()).changes !== 1) throw err('idempotency_in_flight', 'a concurrent request under this Idempotency-Key is in flight', undefined, { 'Retry-After': '1' });
    const cacheable = (status: number): boolean => status < 500 && status !== 429 && status !== 400 && status !== 401 && status !== 403;
    let reply: Reply;
    try {
      reply = await fn();
    } catch (e) {
      if (e instanceof HostError && cacheable(e.status)) q.completeIdem.run(e.status, JSON.stringify(e.headers), JSON.stringify(e.body()), tenant, endpoint, key);
      else q.releaseIdem.run(tenant, endpoint, key);
      throw e;
    }
    if (cacheable(reply.status)) q.completeIdem.run(reply.status, JSON.stringify(reply.headers ?? {}), reply.body === undefined ? null : JSON.stringify(reply.body), tenant, endpoint, key);
    else q.releaseIdem.run(tenant, endpoint, key);
    return reply;
  };

  const subjectOf = (ctx: Ctx): Subject => ctx.subject as Subject;
  const links = (ctx: Ctx, run: RunRow): { eventsUrl: string; statusUrl: string } => {
    const id = projectBoundId(wireId(run));
    return { eventsUrl: `${ctx.baseUrl}/runs/${id}/events`, statusUrl: `${ctx.baseUrl}/runs/${id}` };
  };
  const etagOf = (text: string): string => `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`;
  /** RFC 9110 §13.1.2 — `*` or any listed tag, under weak comparison. */
  const ifNoneMatch = (ctx: Ctx, etag: string): boolean => {
    const h = ctx.header('if-none-match');
    if (h === null) return false;
    const strip = (t: string): string => t.trim().replace(/^W\//, '');
    return h.split(',').some((t) => t.trim() === '*' || strip(t) === strip(etag));
  };

  // ─── 10. Discovery ─────────────────────────────────────────────────────────
  //
  // capabilities.md — the closed v2 root: metadata keys plus one record per
  // family, `{ status, since, until?, witness, ...facets }`. A family is
  // advertised only when this host serves it end to end.

  const record = (witness: string, facets: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'experimental', since: SINCE, until: EXPERIMENTAL_UNTIL, witness, ...facets });
  const discoveryDocument = (): Record<string, unknown> => ({
    protocolVersions: [PROTOCOL_VERSION],
    preferredVersion: PROTOCOL_VERSION,
    implementation: { name: HOST_NAME, version: HOST_VERSION, vendor: 'openwop (reference example)' },
    engineVersion: ENGINE_VERSION,
    eventLogSchemaVersion: ERA,
    fixtures: [...workflows.keys()].sort(),
    limits: { status: 'stable', since: SINCE, witness: 'witnessable-gated', clarificationRounds: 0, maxNodeExecutions: MAX_NODE_EXECUTIONS, maxRunDurationMs: opts.maxRunDurationMs, maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES },
    auth: record('seam-gated', { lanes: [{ lane: 'api-key', issuers: [API_KEY_ISSUER], revocation: 'next-request', minimumAssurance: 'bearer' }] }),
    eventLog: record('claims-check'),
    idempotency: record('witnessable-gated', { crossRegion: 'single-region' }),
    interrupt: record('witnessable-gated', { tokenAlgs: ['hs256'], refKinds: ['principal'] }),
    replay: record('witnessable-gated', { modes: ['replay', 'branch'], effectSeamsManifest: '/host/effect-seams' }),
    runList: record('witnessable-gated', { maxPageSize: RUN_LIST_MAX_PAGE, filters: ['workflowId', 'status'] }),
  });

  const hostBuild = { kind: 'artifact-sha256', id: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };

  route('GET', '/.well-known/openwop', false, async (ctx) => {
    const text = JSON.stringify(discoveryDocument());
    const etag = etagOf(text);
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=60' };
    if (ifNoneMatch(ctx, etag)) return { status: 304, headers };
    return { status: 200, body: JSON.parse(text) as unknown, headers };
  });

  // replay.md §The effect-seam manifest — this host's node runtime reaches no outbound effect path.
  route('GET', '/host/effect-seams', true, async () => ({ status: 200, body: { manifestVersion: '1', host: { name: HOST_NAME, build: hostBuild }, seams: [] } }));

  // ─── 11. Runs ──────────────────────────────────────────────────────────────

  const CREATE_KEYS = new Set(['workflowId', 'inputs', 'residency', 'tenantId', 'scopeId', 'callbackUrl', 'mode', 'evalSuiteRef', 'agentId', 'runSecrets', 'configurable', 'tags', 'metadata']);
  const CONFIGURABLE_SECTIONS: Record<string, Set<string>> = {
    run: new Set(['recursionLimit', 'runTimeoutMs', 'maxLoopIterations', 'escalationThreshold']),
    ai: new Set(['provider', 'model', 'temperature', 'maxTokens', 'credentialRef', 'promptOverrides', 'mockProvider', 'reasoningVerbosity', 'maxRefusals']),
    distillation: new Set(['tokenBudget']),
  };

  /** runs.md §Run options — `configurable` is closed, nested and versioned. */
  const validateConfigurable = (c: unknown): void => {
    if (c === undefined) return;
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw err('validation_error', 'configurable MUST be an object', { path: 'configurable' });
    const obj = c as Record<string, unknown>;
    if (obj['version'] !== 1) throw err('validation_error', 'configurable.version is REQUIRED and MUST be 1', { path: 'configurable.version' });
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'version') continue;
      if (k === 'budget') throw err('capability_not_provided', 'this host does not advertise budget', { path: 'configurable.budget' });
      if (k === 'extensions') { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw err('validation_error', 'configurable.extensions MUST be an object'); continue; }
      const section = CONFIGURABLE_SECTIONS[k];
      if (section === undefined) throw err('validation_error', `unknown configurable key ${k}`, { path: `configurable.${k}` });
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw err('validation_error', `configurable.${k} MUST be an object`, { path: `configurable.${k}` });
      for (const inner of Object.keys(v as object)) if (!section.has(inner)) throw err('validation_error', `unknown key ${inner} in configurable.${k}`, { path: `configurable.${k}.${inner}` });
      const s = v as Record<string, unknown>;
      if (k === 'ai' && s['provider'] !== undefined) throw err('validation_error', 'ai.provider MUST be in aiProviders.providers; this host advertises none', { path: 'configurable.ai.provider' });
      if (k === 'ai' && s['temperature'] !== undefined && (typeof s['temperature'] !== 'number' || s['temperature'] < 0 || s['temperature'] > 2)) throw err('validation_error', 'ai.temperature is 0..2', { path: 'configurable.ai.temperature' });
      const int = (name: string, max: number): void => {
        const x = s[name];
        if (x !== undefined && (!Number.isInteger(x) || (x as number) < 1 || (x as number) > max)) throw err('validation_error', `run.${name} is out of range (1..${max})`, { path: `configurable.run.${name}` });
      };
      if (k === 'run') { int('recursionLimit', MAX_NODE_EXECUTIONS); int('runTimeoutMs', opts.maxRunDurationMs); }
    }
  };

  const validateOptions = (body: Record<string, unknown>): Record<string, unknown> => {
    validateConfigurable(body['configurable']);
    const tags = body['tags'];
    if (tags !== undefined && (!Array.isArray(tags) || tags.length > 100 || !tags.every((t) => typeof t === 'string' && t.length <= 256))) throw err('validation_error', 'tags: at most 100 strings of at most 256 characters', { field: 'tags' });
    const metadata = body['metadata'];
    if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))) throw err('validation_error', 'metadata MUST be an object', { field: 'metadata' });
    const options: Record<string, unknown> = {};
    if (body['configurable'] !== undefined) options['configurable'] = body['configurable'];
    if (tags !== undefined) options['tags'] = tags;
    if (metadata !== undefined) options['metadata'] = metadata;
    return options;
  };

  const insertRun = (row: { run_id: string; tenant: string; workflow_id: string; inputs: unknown; options: unknown; owner: Owner; parent_run_id?: string; fork_mode?: string; from_seq?: number; scope_id?: string | null }): RunRow => {
    const now = nowIso();
    q.insertRun.run({
      run_id: row.run_id, tenant: row.tenant, workflow_id: row.workflow_id, status: 'pending',
      inputs_json: JSON.stringify(row.inputs), options_json: JSON.stringify(row.options), owner_json: JSON.stringify(row.owner),
      created_at: now, started_at: now, parent_run_id: row.parent_run_id ?? null, fork_mode: row.fork_mode ?? null,
      from_seq: row.from_seq ?? null, scope_id: row.scope_id ?? null,
    });
    return loadRunRow(row.run_id) as RunRow;
  };

  route('POST', '/runs', true, async (ctx) => withIdempotency(ctx, 'createRun', async () => {
    const body = await ctx.body();
    const subject = subjectOf(ctx);
    for (const k of Object.keys(body)) if (!CREATE_KEYS.has(k)) throw err('validation_error', `unknown key ${k}; the createRun body is closed`, { field: k });
    if (body['mode'] === 'eval') throw err('capability_not_provided', 'mode: eval needs agents.evalSuite, which this host does not advertise', { capability: 'agents.evalSuite' });
    if (body['mode'] !== undefined) throw err('validation_error', 'mode MUST be eval when present', { field: 'mode' });
    const workflowId = body['workflowId'];
    if (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId)) throw err('validation_error', 'workflowId is REQUIRED', { field: 'workflowId' });
    if (body['tenantId'] !== undefined && body['tenantId'] !== subject.tenant) throw err('forbidden', 'tenantId MUST be the credential\'s tenant');
    if (body['callbackUrl'] !== undefined) throw err('validation_error', 'callbackUrl is refused: this host does not advertise interrupt.callbackDelivery', { field: 'callbackUrl' });
    if (body['runSecrets'] !== undefined) throw err('validation_error', 'runSecrets is refused: this host does not advertise secrets.runSecrets', { field: 'runSecrets' });
    if (body['inputs'] !== undefined && (body['inputs'] === null || typeof body['inputs'] !== 'object' || Array.isArray(body['inputs']))) throw err('validation_error', 'inputs MUST be an object', { field: 'inputs' });
    const options = validateOptions(body);
    const def = workflows.get(workflowId);
    if (!def) throw err('not_found', `workflow ${workflowId} is not registered on this host`, { workflowId });
    const scopeId = typeof body['scopeId'] === 'string' ? body['scopeId'] : null;
    if (ctx.header('openwop-dedup') === 'enforce' && scopeId !== null) {
      const live = q.activeForScope.get(subject.tenant, scopeId) as { run_id: string } | undefined;
      if (live) throw err('run_already_active', `a run for scopeId ${scopeId} is active`, { scopeId }, { 'Retry-After': '5' });
    }
    const inputs: Record<string, unknown> = { ...Object.fromEntries((def.variables ?? []).filter((v) => v.defaultValue !== undefined).map((v) => [v.name, v.defaultValue])), ...((body['inputs'] as Record<string, unknown> | undefined) ?? {}) };
    for (const v of def.variables ?? []) if (v.required === true && inputs[v.name] === undefined) throw err('validation_error', `input ${v.name} is required by the workflow`, { field: `inputs.${v.name}` });
    const run = insertRun({ run_id: tenantBound(subject.tenant), tenant: subject.tenant, workflow_id: workflowId, inputs, options, owner: { tenant: subject.tenant, subject: { ...subject } }, scope_id: scopeId });
    scheduleRun(run.run_id);
    return { status: 201, body: { runId: wireId(run), status: 'pending', ...links(ctx, run) } };
  }));

  /** RFC 0182 listRuns — newest first; the cursor is MAC'd so a cursor this host did not mint is refused. */
  const STATUSES = new Set(['pending', 'running', 'paused', 'waiting-approval', 'waiting-input', 'waiting-external', 'completed', 'failed', 'cancelling', 'cancelled']);
  route('GET', '/runs', true, async (ctx) => {
    const tenant = subjectOf(ctx).tenant;
    const sp = ctx.url.searchParams;
    const limitRaw = sp.get('limit');
    if (limitRaw !== null && !/^[1-9]\d*$/.test(limitRaw)) throw err('validation_error', 'limit MUST be an integer >= 1', { field: 'limit' });
    const limit = Math.min(limitRaw === null ? RUN_LIST_MAX_PAGE : Number(limitRaw), RUN_LIST_MAX_PAGE);
    const where = ['tenant = @tenant'];
    const args: Record<string, unknown> = { tenant, limit: limit + 1 };
    const workflowId = sp.get('workflowId');
    if (workflowId !== null) { if (!WORKFLOW_ID.test(workflowId)) throw err('validation_error', 'workflowId does not match its grammar', { field: 'workflowId' }); where.push('workflow_id = @workflowId'); args['workflowId'] = workflowId; }
    const status = sp.get('status');
    if (status !== null) { if (!STATUSES.has(status)) throw err('validation_error', 'status is not a run status', { field: 'status' }); where.push('status = @status'); args['status'] = status; }
    const cursor = sp.get('cursor');
    if (cursor !== null) {
      const [createdAt, runId, mac] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      const expect = createHmac('sha256', cursorSecret).update(`${createdAt}|${runId}`).digest('base64url');
      if (createdAt === undefined || runId === undefined || mac === undefined || mac.length !== expect.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) throw err('validation_error', 'the cursor is not one this host minted', { field: 'cursor' });
      where.push('(COALESCE(created_at, started_at) < @createdAt OR (COALESCE(created_at, started_at) = @createdAt AND run_id < @runId))');
      args['createdAt'] = createdAt; args['runId'] = runId;
    }
    const rows = db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY COALESCE(created_at, started_at) DESC, run_id DESC LIMIT @limit`).all(args) as RunRow[];
    const page = rows.slice(0, limit);
    const body: Record<string, unknown> = { runs: page.map(snapshot) };
    const last = page[page.length - 1];
    if (rows.length > limit && last) {
      const payload = `${last.created_at ?? last.started_at}|${last.run_id}`;
      body['nextCursor'] = Buffer.from(`${payload}|${createHmac('sha256', cursorSecret).update(payload).digest('base64url')}`).toString('base64url');
    }
    return { status: 200, body };
  });

  route('GET', '/runs/{runId}', true, async (ctx) => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const etag = `"seq-${lastSequence(run.run_id)}-${run.status}"`;
    if (ifNoneMatch(ctx, etag)) return { status: 304, headers: { ETag: etag } };
    return { status: 200, body: snapshot(run), headers: { ETag: etag } };
  });

  // events.md §Poll — `afterSequence` is an exclusive cursor; long-polls up to `timeout` seconds.
  route('GET', '/runs/{runId}/events/poll', true, async (ctx) => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const rawAfter = ctx.url.searchParams.get('afterSequence');
    if (rawAfter !== null && !/^(0|[1-9]\d*)$/.test(rawAfter)) throw err('validation_error', 'afterSequence MUST be an integer >= 0', { field: 'afterSequence' });
    const rawTimeout = ctx.url.searchParams.get('timeout');
    const timeout = rawTimeout === null ? 30 : Number(rawTimeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw err('validation_error', 'timeout is 1..60 seconds', { field: 'timeout' });
    const after = rawAfter === null ? -1 : Number(rawAfter);
    const until = Date.now() + timeout * 1000;
    let events = readEvents(run, after);
    let fresh = loadRunRow(run.run_id) as RunRow;
    while (events.length === 0 && !TERMINAL.has(fresh.status) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      events = readEvents(run, after);
      fresh = loadRunRow(run.run_id) as RunRow;
    }
    return { status: 200, body: { runId: wireId(run), events, lastSequence: lastSequence(run.run_id), status: fresh.status, isTerminal: TERMINAL.has(fresh.status) } };
  });

  /**
   * events.md §SSE frames — `id:` is the sequence, `event:` the type (single
   * mode) or the admitting mode (mixed), `data:` the RunEventDoc. The tail
   * reads the durable log, so an event another process appends reaches the
   * stream too; the in-process bus only wakes it sooner.
   */
  route('GET', '/runs/{runId}/events', true, async (ctx) => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const modes = parseStreamModes(ctx.url.searchParams.get('streamMode'));
    const lastRaw = ctx.header('last-event-id');
    if (lastRaw !== null && !/^(0|[1-9]\d*)$/.test(lastRaw.trim())) throw err('validation_error', 'Last-Event-ID MUST be a non-negative integer', { header: 'Last-Event-ID' });
    const bufferRaw = ctx.url.searchParams.get('bufferMs');
    const bufferMs = bufferRaw === null ? 0 : Number(bufferRaw);
    if (!Number.isInteger(bufferMs) || bufferMs < 0 || bufferMs > 5000) throw err('validation_error', 'bufferMs is 0..5000', { field: 'bufferMs' });
    let delivered = lastRaw === null ? -1 : Number(lastRaw.trim());
    const backlog = readEvents(run, delivered);
    const res = ctx.res;
    res.writeHead(200, { 'OpenWOP-Version': PROTOCOL_VERSION, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let closed = false;
    let batch: RunEventDoc[] = [];
    const frame = (id: number, event: string, data: unknown): void => { if (!closed) res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const flush = (): void => { if (batch.length > 0) { frame((batch[batch.length - 1] as RunEventDoc).sequence, 'batch', batch); batch = []; } };
    const values = modes.includes('values');
    const isTerminalEvent = (t: string): boolean => t === 'run.completed' || t === 'run.failed' || t === 'run.cancelled';
    const end = (): void => {
      if (closed) return;
      flush();
      closed = true;
      clearInterval(keepAlive);
      clearInterval(tail);
      bus.off(`run:${run.run_id}`, wake);
      res.end();
    };
    const emit = (doc: RunEventDoc): void => {
      delivered = doc.sequence;
      const mode = admittedBy(modes, doc.type);
      if (mode !== null) {
        if (bufferMs > 0) { batch.push(doc); if (doc.type === 'node.suspended' || isTerminalEvent(doc.type)) flush(); }
        else frame(doc.sequence, modes.length === 1 ? doc.type : mode, doc);
        if (values && mode === 'values') frame(doc.sequence, 'state.snapshot', snapshot(loadRunRow(run.run_id) as RunRow));
      }
      if (isTerminalEvent(doc.type)) end();
    };
    const pump = (): void => {
      if (closed) return;
      for (const doc of readEvents(run, delivered)) { emit(doc); if (closed) return; }
      if (bufferMs > 0) flush();
      if (TERMINAL.has((loadRunRow(run.run_id) as RunRow).status)) end();
    };
    const wake = (): void => { setImmediate(pump); };
    const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
    const tail = setInterval(pump, bufferMs > 0 ? bufferMs : 250);
    res.on('close', end);
    if (values && lastRaw !== null) frame(delivered, 'state.snapshot', snapshot(run));
    for (const doc of backlog) { emit(doc); if (closed) return 'streamed'; }
    if (bufferMs > 0) flush();
    if (TERMINAL.has((loadRunRow(run.run_id) as RunRow).status)) { end(); return 'streamed'; }
    bus.on(`run:${run.run_id}`, wake);
    return 'streamed';
  });

  route('POST', '/runs/{runId}/cancel', true, async (ctx) => withIdempotency(ctx, 'cancelRun', async () => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const body = await ctx.body();
    const reason = typeof body['reason'] === 'string' ? body['reason'] : 'caller-requested';
    return { status: 200, body: { runId: wireId(run), status: requestCancel(run, reason) } };
  }));

  route('POST', '/runs:bulk-cancel', true, async (ctx) => withIdempotency(ctx, 'bulkCancelRuns', async () => {
    const body = await ctx.body();
    for (const k of Object.keys(body)) if (k !== 'runIds' && k !== 'reason') throw err('validation_error', `unknown key ${k}`, { field: k });
    const ids = body['runIds'];
    if (!Array.isArray(ids) || ids.length === 0) throw err('validation_error', 'runIds MUST be a non-empty array', { field: 'runIds', maxRunIds: 100 });
    if (ids.length > 100) throw err('validation_error', 'runIds exceeds the host cap', { maxRunIds: 100 });
    const reason = typeof body['reason'] === 'string' ? body['reason'] : 'caller-requested';
    const results = ids.map((id) => {
      try {
        if (typeof id !== 'string') throw err('validation_error', 'a runId MUST be a string');
        const run = runFor(subjectOf(ctx), unprojectBoundId(id));
        return { runId: id, ok: true, status: requestCancel(run, reason) };
      } catch (e) {
        const he = e instanceof HostError ? e : err('internal_error', 'the cancel failed');
        return { runId: typeof id === 'string' && id !== '' ? id : '?', ok: false, error: he.body() };
      }
    });
    return { status: 200, body: { results } };
  }));

  route('POST', '/runs/{runId}:pause', true, async (ctx) => withIdempotency(ctx, 'pauseRun', async () => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const body = await ctx.body();
    const drainPolicy = body['drainPolicy'] ?? 'drain-current-node';
    if (drainPolicy !== 'immediate' && drainPolicy !== 'drain-current-node') throw err('validation_error', 'drainPolicy is immediate | drain-current-node', { field: 'drainPolicy' });
    if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be paused`, { runStatus: run.status });
    if ((run.status !== 'running' && run.status !== 'pending') || run.pause_requested !== null) throw err('run_state_conflict', `a run in status ${run.status} cannot be paused${run.pause_requested !== null ? ' (a pause is already pending)' : ''}`, { runStatus: run.status });
    const reason = typeof body['reason'] === 'string' ? body['reason'] : 'operator';
    const executing = active.has(run.run_id) || claimedElsewhere(run);
    if (executing && drainPolicy === 'drain-current-node') {
      // The executing process pauses the run when the current node reaches its terminal.
      update(run.run_id, { pause_requested: drainPolicy });
      return { status: 202, body: { runId: wireId(run), status: 'paused' } };
    }
    // Nothing executing, or `immediate`: the pause is recorded here and now. An
    // executing attempt is cut between events (no terminal node event for it);
    // the loop, in whichever process holds the claim, sees `paused` and stops.
    const payload: Record<string, unknown> = { reason, drainPolicy };
    if (executing) {
      let open: { nodeId: string; attempt: number } | null = null;
      for (const e of readEvents(run)) {
        const n = e.nodeId;
        if (e.type === 'node.started' && n !== undefined) open = { nodeId: n, attempt: Number((e.payload as { attempt?: unknown }).attempt ?? 0) + 1 };
        if ((e.type === 'node.completed' || e.type === 'node.failed' || e.type === 'node.suspended' || e.type === 'node.cancelled') && n === open?.nodeId) open = null;
      }
      if (open !== null) { payload['interruptedNodeId'] = open.nodeId; payload['interruptedAttempt'] = open.attempt; }
    }
    appendEvent(run, 'run.paused', payload);
    update(run.run_id, { status: 'paused', pause_requested: null });
    return { status: 202, body: { runId: wireId(run), status: 'paused', pausedAt: nowIso() } };
  }));

  route('POST', '/runs/{runId}:resume', true, async (ctx) => withIdempotency(ctx, 'resumeRun', async () => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const body = await ctx.body();
    if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be resumed`, { runStatus: run.status });
    if (run.status !== 'paused') throw err('run_state_conflict', `a run in status ${run.status} is not paused`, { runStatus: run.status });
    appendEvent(run, 'run.resumed', typeof body['reason'] === 'string' ? { reason: body['reason'] } : {});
    update(run.run_id, { status: 'running' });
    scheduleRun(run.run_id);
    return { status: 202, body: { runId: wireId(run), status: 'running', resumedAt: nowIso() } };
  }));

  // idempotency.md §Witness — no node executor here performs an external effect, so the ledger is empty.
  route('GET', '/runs/{runId}/effects', true, async (ctx) => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    return { status: 200, body: { runId: wireId(run), effects: [] } };
  });

  /**
   * replay.md — events `< fromSeq` are copied as fixed history (read through the
   * storage boundary, so an era-2 parent is copied translated); the child then
   * re-executes. A replay keys its interrupts on its source and takes the
   * source's recorded resolution; a branch is an independent run.
   */
  route('POST', '/runs/{runId}:fork', true, async (ctx) => withIdempotency(ctx, 'forkRun', async () => {
    const source = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const body = await ctx.body();
    for (const k of Object.keys(body)) if (k !== 'mode' && k !== 'fromSeq' && k !== 'runOptionsOverlay') throw err('validation_error', `unknown key ${k}`, { field: k });
    const mode = body['mode'];
    if (mode !== 'replay' && mode !== 'branch') throw err('validation_error', 'mode is replay | branch', { field: 'mode' });
    const rawFrom = body['fromSeq'];
    if (rawFrom === undefined && mode === 'branch') throw err('validation_error', 'fromSeq is REQUIRED for branch', { field: 'fromSeq' });
    if (rawFrom !== undefined && (!Number.isInteger(rawFrom) || (rawFrom as number) < 0)) throw err('validation_error', 'fromSeq MUST be an integer >= 0', { field: 'fromSeq' });
    const fromSeq = (rawFrom as number | undefined) ?? 0;
    const overlay = body['runOptionsOverlay'];
    if (overlay !== undefined && (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay))) throw err('validation_error', 'runOptionsOverlay MUST be an object', { field: 'runOptionsOverlay' });
    if (mode === 'replay' && overlay !== undefined && Object.keys(overlay).length > 0) throw err('validation_error', 'runOptionsOverlay is branch-only', { field: 'runOptionsOverlay' });
    const events = readEvents(source);
    if (fromSeq > 0 && !events.some((e) => e.sequence === fromSeq)) throw err('fork_point_invalid', `fromSeq ${fromSeq} is not in the source log`, { fromSeq });
    const terminal = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled');
    if (terminal && fromSeq > terminal.sequence) throw err('fork_point_invalid', `fromSeq ${fromSeq} is past the source's terminal event`, { fromSeq });
    const options = { ...optionsOf(source), ...(overlay !== undefined ? validateOptions(overlay as Record<string, unknown>) : {}) };
    const child = insertRun({
      run_id: tenantBound(source.tenant), tenant: source.tenant, workflow_id: source.workflow_id, inputs: JSON.parse(source.inputs_json) as unknown,
      options, owner: ownerOf(source), parent_run_id: source.run_id, fork_mode: mode, from_seq: fromSeq,
    });
    for (const e of events.filter((x) => x.sequence < fromSeq)) {
      q.insertEvent.run(child.run_id, e.sequence, e.type, e.nodeId ?? null, JSON.stringify(e.payload ?? {}), e.timestamp, e.causationId ?? null, opaque(), e.schemaVersion, e.engineVersion ?? null);
    }
    scheduleRun(child.run_id);
    return { status: 201, body: { runId: wireId(child), sourceRunId: wireId(source), fromSeq, mode, status: 'pending', eventsUrl: links(ctx, child).eventsUrl } };
  }));

  // ─── 12. Interrupt surfaces ────────────────────────────────────────────────

  route('POST', '/runs/{runId}/interrupts/{nodeId}', true, async (ctx) => withIdempotency(ctx, 'resolveInterruptByRun', async () => {
    const run = runFor(subjectOf(ctx), ctx.params['runId'] as string);
    const nodeId = ctx.params['nodeId'] as string;
    if (!NODE_ID.test(nodeId)) throw err('not_found', 'no such node');
    const body = await ctx.body();
    for (const k of Object.keys(body)) if (k !== 'resumeValue') throw err('validation_error', `unknown key ${k}; the body is { resumeValue }`, { field: k });
    if (!('resumeValue' in body)) throw err('validation_error', 'resumeValue is REQUIRED', { field: 'resumeValue' });
    const row = (q.openInterrupt.get(run.run_id, nodeId) as InterruptRow | undefined) ?? adoptLegacyInterrupt(run, nodeId);
    if (!row) {
      if (TERMINAL.has(run.status) || q.anyInterrupt.get(run.run_id, nodeId)) throw err('interrupt_already_resolved', 'the interrupt is already resolved, or its run ended');
      throw err('not_found', `node ${nodeId} holds no interrupt`);
    }
    return { status: 200, body: resolve(run, row, body['resumeValue'], subjectOf(ctx)) };
  }));

  route('GET', '/interrupts/{token}', false, async (ctx) => {
    const row = verifyToken(ctx.params['token'] as string);
    return { status: 200, body: JSON.parse(row.payload_json) as unknown };
  });

  route('POST', '/interrupts/{token}', false, async (ctx) => {
    const row = verifyToken(ctx.params['token'] as string);
    const run = loadRunRow(row.run_id) as RunRow;
    const body = await ctx.body();
    for (const k of Object.keys(body)) if (k !== 'resumeValue') throw err('validation_error', `unknown key ${k}; the body is { resumeValue }`, { field: k });
    if (!('resumeValue' in body)) throw err('validation_error', 'resumeValue is REQUIRED', { field: 'resumeValue' });
    return { status: 200, body: resolve(run, row, body['resumeValue'], null) };
  });

  // ─── 13. Bootstrap ─────────────────────────────────────────────────────────
  //
  // Resume on startup: a run left pending or running with no live claim was
  // being executed by a process that died. Claim it and re-enter its loop; the
  // fold picks up after the last recorded event.

  const resumeOrphans = (): number => {
    const rows = q.orphans.all(Date.now()) as Array<{ run_id: string }>;
    for (const { run_id } of rows) scheduleRun(run_id);
    return rows.length;
  };
  const resumed = resumeOrphans();
  const sweep = setInterval(resumeOrphans, opts.claimTtlMs);
  sweep.unref();

  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((ok) => server.listen(opts.port, opts.host, ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  console.log(`[${HOST_NAME}] listening on http://${opts.host}:${port} (OpenWOP ${PROTOCOL_VERSION}; db ${opts.dbPath}; ${workflows.size} fixtures; process ${processId}${resumed > 0 ? `; resumed ${resumed} orphaned run(s)` : ''})`);

  return {
    port,
    server,
    processId,
    close: async () => {
      closing = true;
      clearInterval(sweep);
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      // Let every loop stop at its next check; each releases its claim on the way
      // out, so another process can take the run over at once.
      await Promise.allSettled([...active.values()]);
      db.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startHost().then((running) => {
    const stop = (): void => { void running.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e: unknown) => { console.error(e); process.exit(1); });
}
