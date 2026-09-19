/**
 * The durable stores (persistence.md §Per-store disposition, one table each):
 *
 *   runs                  legacy-stamped  — `era` NULL reads as 2 (v1 era); v2 writes 3
 *   events                translated      — UNIQUE (run_id, sequence); era-2 rows kept verbatim
 *   interrupts            drained         — tokens carry `kid`; `legacy` resolves v1 two-segment tokens
 *   webhooks/deliveries   unchanged/drained
 *   idempotency/effects   unchanged       — Layer-1 and Layer-2 records
 *   packs                 unchanged       — the isolated test catalog
 *   credentials           host-internal   — api-key / session lanes (next-request revocation)
 *   annotations           host-internal   — a side-store, never the event log (runs.md §Annotations)
 *   workspace_files       host-internal   — the minimal RFC 0059 seam
 *
 * `better-sqlite3` is the one runtime dependency; every read that crosses the
 * storage boundary for era-2 rows goes through `codemap.ts`, not through this file.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RunRow {
  run_id: string;
  tenant: string;
  workflow_id: string;
  status: string;
  era: number | null;
  owner_json: string | null;
  options_json: string;
  inputs_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  current_node_id: string | null;
  error_json: string | null;
  source_run_id: string | null;
  fork_mode: string | null;
  from_seq: number | null;
  compensation_json: string | null;
  pause_requested: number;
  cancel_requested: number;
  pin_checked: number;
  scope_id: string | null;
}

export interface EventRow {
  run_id: string;
  sequence: number;
  event_id: string;
  type: string;
  payload_json: string;
  timestamp: string;
  node_id: string | null;
  causation_id: string | null;
  schema_version: number;
  engine_version: number | null;
}

export interface IdempotencyRow {
  tenant: string;
  endpoint: string;
  key: string;
  digest: string;
  status: number | null;
  headers_json: string | null;
  body: string | null;
  created_at: string;
}

export interface CredentialRow {
  id: string;
  secret_hash: string;
  tenant: string;
  lane: string;
  subject_id: string;
  created_at: string;
  revoked_at: string | null;
}

export interface InterruptRow {
  interrupt_id: string;
  run_id: string;
  node_id: string;
  key: string;
  kind: string;
  payload_json: string;
  expires_at: string;
  resolved_at: string | null;
  resume_json: string | null;
  created_at: string;
}

export interface WebhookRow {
  webhook_id: string;
  tenant: string;
  url: string;
  events_json: string;
  secret: string;
  tags_json: string | null;
  /** The contract major the subscriber registered under (webhooks.md §Delivery): the rendering it receives. Rows from before the column default to 1 — the wire they always received. */
  contract_major: 1 | 2;
  created_at: string;
}

export interface DeliveryRow {
  delivery_id: string;
  webhook_id: string;
  tenant: string;
  run_id: string;
  sequence: number;
  event_type: string;
  body: string;
  attempts: number;
  next_at: number;
  state: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EffectRow {
  effect_id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  keying: string;
  state: string;
  provider_key: string | null;
  invocation_id: string | null;
  at: string;
  business_key: string;
  outcome_json: string | null;
}

export interface PackRow {
  catalog: string;
  name: string;
  version: string;
  kind: string;
  manifest_json: string;
  tarball: Buffer;
  sha256: string;
  published_at: string;
}

export interface AnnotationRow {
  annotation_id: string;
  run_id: string;
  json: string;
  created_at: string;
}

export interface WorkspaceFileRow {
  tenant: string;
  workspace: string;
  path: string;
  content: string;
  content_type: string;
  version: number;
  etag: string;
  updated_at: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  era INTEGER NULL,
  owner_json TEXT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL,
  current_node_id TEXT NULL,
  error_json TEXT NULL,
  source_run_id TEXT NULL,
  fork_mode TEXT NULL,
  from_seq INTEGER NULL,
  compensation_json TEXT NULL,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  pin_checked INTEGER NOT NULL DEFAULT 0,
  scope_id TEXT NULL
);
CREATE INDEX IF NOT EXISTS runs_tenant_scope ON runs(tenant, scope_id);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  node_id TEXT NULL,
  causation_id TEXT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  engine_version INTEGER NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE TABLE IF NOT EXISTS idempotency (
  tenant TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  status INTEGER NULL,
  headers_json TEXT NULL,
  body TEXT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, endpoint, key)
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  lane TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NULL
);
CREATE TABLE IF NOT EXISTS interrupts (
  interrupt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  resume_json TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, key)
);
CREATE TABLE IF NOT EXISTS webhooks (
  webhook_id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret TEXT NOT NULL,
  tags_json TEXT NULL,
  contract_major INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  last_status INTEGER NULL,
  last_error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, next_at);
CREATE TABLE IF NOT EXISTS effects (
  effect_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  keying TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_key TEXT NULL,
  invocation_id TEXT NULL,
  at TEXT NOT NULL,
  business_key TEXT NOT NULL,
  outcome_json TEXT NULL,
  PRIMARY KEY (run_id, effect_id, attempt)
);
CREATE INDEX IF NOT EXISTS effects_business ON effects(business_key);
CREATE INDEX IF NOT EXISTS effects_run ON effects(run_id);
CREATE TABLE IF NOT EXISTS packs (
  catalog TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  tarball BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (catalog, name, version)
);
CREATE TABLE IF NOT EXISTS chain_workflows (
  workflow_id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL
);
-- workflow-chain-packs.md §Co-registered children: one row per (parent, child)
-- carrying the RESOLVED reference, so the count is the number of parents and a
-- re-instantiation reproduces the same child.
CREATE TABLE IF NOT EXISTS chain_ownership (
  parent_chain_id TEXT NOT NULL,
  child_workflow_id TEXT NOT NULL,
  resolved_ref TEXT NOT NULL,
  PRIMARY KEY (parent_chain_id, child_workflow_id)
);
CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_files (
  tenant TEXT NOT NULL,
  workspace TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  etag TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, workspace, path)
);
`;

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(DDL);
    // A database created before subscriptions recorded their contract: add the column, defaulting to the major-1 rendering those rows always received.
    const webhookColumns = (this.db.prepare('PRAGMA table_info(webhooks)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!webhookColumns.includes('contract_major')) this.db.exec('ALTER TABLE webhooks ADD COLUMN contract_major INTEGER NOT NULL DEFAULT 1');
  }

  close(): void {
    this.db.close();
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  insertRun(row: RunRow): void {
    this.db.prepare(`INSERT INTO runs (run_id, tenant, workflow_id, status, era, owner_json, options_json, inputs_json, created_at, updated_at, started_at, completed_at, current_node_id, error_json, source_run_id, fork_mode, from_seq, compensation_json, pause_requested, cancel_requested, pin_checked, scope_id)
      VALUES (@run_id, @tenant, @workflow_id, @status, @era, @owner_json, @options_json, @inputs_json, @created_at, @updated_at, @started_at, @completed_at, @current_node_id, @error_json, @source_run_id, @fork_mode, @from_seq, @compensation_json, @pause_requested, @cancel_requested, @pin_checked, @scope_id)`).run(row);
  }
  getRun(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  }
  /**
   * RFC 0182 §A.2–§A.4 — the caller's runs, newest first, keyset-paginated.
   * `after` is the (created_at, run_id) of the last row of the previous page;
   * the cursor that carries it is minted and checked in runs.ts, never here.
   * Tenant is a WHERE clause, not a post-filter: the list is scoped by construction.
   */
  listRuns(tenant: string, opts: { limit: number; after?: { createdAt: string; runId: string }; workflowId?: string; status?: string }): RunRow[] {
    const where = ['tenant = @tenant'];
    const params: Record<string, unknown> = { tenant, limit: opts.limit };
    if (opts.workflowId !== undefined) { where.push('workflow_id = @workflow_id'); params['workflow_id'] = opts.workflowId; }
    if (opts.status !== undefined) { where.push('status = @status'); params['status'] = opts.status; }
    if (opts.after) { where.push('(created_at < @after_created OR (created_at = @after_created AND run_id < @after_run))'); params['after_created'] = opts.after.createdAt; params['after_run'] = opts.after.runId; }
    return this.db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, run_id DESC LIMIT @limit`).all(params) as RunRow[];
  }
  updateRun(runId: string, patch: Partial<RunRow>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE runs SET ${sets}, updated_at = @updated_at WHERE run_id = @run_id`).run({ ...patch, updated_at: new Date().toISOString(), run_id: runId });
  }
  activeRunForScope(tenant: string, scopeId: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE tenant = ? AND scope_id = ? AND status NOT IN ('completed','failed','cancelled') LIMIT 1`).get(tenant, scopeId) as RunRow | undefined;
  }
  nonTerminalRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs WHERE status NOT IN ('completed','failed','cancelled')`).all() as RunRow[];
  }

  // ── events ────────────────────────────────────────────────────────────────
  insertEvent(row: EventRow): void {
    this.db.prepare(`INSERT INTO events (run_id, sequence, event_id, type, payload_json, timestamp, node_id, causation_id, schema_version, engine_version)
      VALUES (@run_id, @sequence, @event_id, @type, @payload_json, @timestamp, @node_id, @causation_id, @schema_version, @engine_version)`).run(row);
  }
  listEventRows(runId: string, afterSequence = -1): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC').all(runId, afterSequence) as EventRow[];
  }
  lastSequence(runId: string): number {
    const r = this.db.prepare('SELECT MAX(sequence) AS s FROM events WHERE run_id = ?').get(runId) as { s: number | null };
    return r.s ?? -1;
  }
  eventAt(runId: string, sequence: number): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE run_id = ? AND sequence = ?').get(runId, sequence) as EventRow | undefined;
  }

  // ── idempotency (Layer 1) ─────────────────────────────────────────────────
  getIdempotency(tenant: string, endpoint: string, key: string): IdempotencyRow | undefined {
    return this.db.prepare('SELECT * FROM idempotency WHERE tenant = ? AND endpoint = ? AND key = ?').get(tenant, endpoint, key) as IdempotencyRow | undefined;
  }
  claimIdempotency(tenant: string, endpoint: string, key: string, digest: string): boolean {
    try {
      this.db.prepare('INSERT INTO idempotency (tenant, endpoint, key, digest, created_at) VALUES (?, ?, ?, ?, ?)').run(tenant, endpoint, key, digest, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }
  completeIdempotency(tenant: string, endpoint: string, key: string, status: number, headers: Record<string, string>, body: string): void {
    this.db.prepare('UPDATE idempotency SET status = ?, headers_json = ?, body = ? WHERE tenant = ? AND endpoint = ? AND key = ?').run(status, JSON.stringify(headers), body, tenant, endpoint, key);
  }
  releaseIdempotency(tenant: string, endpoint: string, key: string): void {
    this.db.prepare('DELETE FROM idempotency WHERE tenant = ? AND endpoint = ? AND key = ?').run(tenant, endpoint, key);
  }

  // ── credentials ───────────────────────────────────────────────────────────
  insertCredential(row: CredentialRow): void {
    this.db.prepare('INSERT INTO credentials (id, secret_hash, tenant, lane, subject_id, created_at, revoked_at) VALUES (@id, @secret_hash, @tenant, @lane, @subject_id, @created_at, @revoked_at)').run(row);
  }
  credentialByHash(hash: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE secret_hash = ?').get(hash) as CredentialRow | undefined;
  }
  revokeCredential(hash: string): boolean {
    const r = this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE secret_hash = ? AND revoked_at IS NULL').run(new Date().toISOString(), hash);
    return r.changes > 0;
  }

  // ── interrupts ────────────────────────────────────────────────────────────
  insertInterrupt(row: InterruptRow): void {
    this.db.prepare('INSERT INTO interrupts (interrupt_id, run_id, node_id, key, kind, payload_json, expires_at, resolved_at, resume_json, created_at) VALUES (@interrupt_id, @run_id, @node_id, @key, @kind, @payload_json, @expires_at, @resolved_at, @resume_json, @created_at)').run(row);
  }
  getInterrupt(interruptId: string): InterruptRow | undefined {
    return this.db.prepare('SELECT * FROM interrupts WHERE interrupt_id = ?').get(interruptId) as InterruptRow | undefined;
  }
  interruptByKey(runId: string, key: string): InterruptRow | undefined {
    return this.db.prepare('SELECT * FROM interrupts WHERE run_id = ? AND key = ?').get(runId, key) as InterruptRow | undefined;
  }
  pendingInterruptForNode(runId: string, nodeId: string): InterruptRow | undefined {
    return this.db.prepare('SELECT * FROM interrupts WHERE run_id = ? AND node_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1').get(runId, nodeId) as InterruptRow | undefined;
  }
  /** Atomic claim: exactly one of two concurrent resolves wins (interrupt.md §Resolve surfaces). */
  resolveInterrupt(interruptId: string, resumeJson: string): boolean {
    const r = this.db.prepare('UPDATE interrupts SET resolved_at = ?, resume_json = ? WHERE interrupt_id = ? AND resolved_at IS NULL').run(new Date().toISOString(), resumeJson, interruptId);
    return r.changes > 0;
  }
  invalidateInterruptsForRun(runId: string): void {
    this.db.prepare(`UPDATE interrupts SET resolved_at = ?, resume_json = COALESCE(resume_json, '{"invalidated":true}') WHERE run_id = ? AND resolved_at IS NULL`).run(new Date().toISOString(), runId);
  }

  // ── webhooks ──────────────────────────────────────────────────────────────
  insertWebhook(row: WebhookRow): void {
    this.db.prepare('INSERT INTO webhooks (webhook_id, tenant, url, events_json, secret, tags_json, contract_major, created_at) VALUES (@webhook_id, @tenant, @url, @events_json, @secret, @tags_json, @contract_major, @created_at)').run(row);
  }
  getWebhook(id: string): WebhookRow | undefined {
    return this.db.prepare('SELECT * FROM webhooks WHERE webhook_id = ?').get(id) as WebhookRow | undefined;
  }
  deleteWebhook(id: string): void {
    this.db.prepare('DELETE FROM webhooks WHERE webhook_id = ?').run(id);
  }
  webhooksForTenant(tenant: string): WebhookRow[] {
    return this.db.prepare('SELECT * FROM webhooks WHERE tenant = ?').all(tenant) as WebhookRow[];
  }
  insertDelivery(row: DeliveryRow): void {
    this.db.prepare(`INSERT INTO deliveries (delivery_id, webhook_id, tenant, run_id, sequence, event_type, body, attempts, next_at, state, last_status, last_error, created_at, updated_at)
      VALUES (@delivery_id, @webhook_id, @tenant, @run_id, @sequence, @event_type, @body, @attempts, @next_at, @state, @last_status, @last_error, @created_at, @updated_at)`).run(row);
  }
  dueDeliveries(now: number, limit = 20): DeliveryRow[] {
    return this.db.prepare(`SELECT * FROM deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at ASC LIMIT ?`).all(now, limit) as DeliveryRow[];
  }
  updateDelivery(id: string, patch: Partial<DeliveryRow>): void {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE deliveries SET ${sets}, updated_at = @updated_at WHERE delivery_id = @delivery_id`).run({ ...patch, updated_at: new Date().toISOString(), delivery_id: id });
  }
  /**
   * RFC 0188 §A.1 — newest first, keyset-paginated. `updated_at` is when the
   * delivery was dead-lettered (the exhausting attempt wrote it), which is what
   * the record's `deadLetteredAt` reports and what the retention purge measures,
   * so ordering on it keeps the page, the field and the expiry on one clock.
   */
  deadLetters(webhookId: string, opts?: { limit?: number; after?: { updatedAt: string; deliveryId: string } }): DeliveryRow[] {
    const limit = opts?.limit ?? -1;
    if (opts?.after) {
      return this.db.prepare(`SELECT * FROM deliveries WHERE webhook_id = ? AND state = 'dead-lettered' AND (updated_at < ? OR (updated_at = ? AND delivery_id < ?)) ORDER BY updated_at DESC, delivery_id DESC LIMIT ?`)
        .all(webhookId, opts.after.updatedAt, opts.after.updatedAt, opts.after.deliveryId, limit) as DeliveryRow[];
    }
    return this.db.prepare(`SELECT * FROM deliveries WHERE webhook_id = ? AND state = 'dead-lettered' ORDER BY updated_at DESC, delivery_id DESC LIMIT ?`).all(webhookId, limit) as DeliveryRow[];
  }
  purgeDeadLetters(olderThanIso: string): number {
    return this.db.prepare(`DELETE FROM deliveries WHERE state = 'dead-lettered' AND updated_at < ?`).run(olderThanIso).changes;
  }

  // ── effects (Layer 2) ─────────────────────────────────────────────────────
  /** The identity already assigned to this business key, if any (idempotency.md §Layer 2 Keying: assigned once per effect). */
  effectIdentity(businessKey: string): { effect_id: string; provider_key: string | null } | undefined {
    return this.db.prepare('SELECT effect_id, provider_key FROM effects WHERE business_key = ? ORDER BY attempt ASC LIMIT 1').get(businessKey) as { effect_id: string; provider_key: string | null } | undefined;
  }
  /**
   * The atomic claim that guards the effect: insert-if-absent on
   * (effect_id, attempt), so at most one executor performs a given attempt and
   * a retry of the same logical invocation records under the same identity.
   */
  claimEffect(row: EffectRow): { row: EffectRow; won: boolean } {
    try {
      this.db.prepare(`INSERT INTO effects (effect_id, run_id, node_id, attempt, keying, state, provider_key, invocation_id, at, business_key, outcome_json)
        VALUES (@effect_id, @run_id, @node_id, @attempt, @keying, @state, @provider_key, @invocation_id, @at, @business_key, @outcome_json)`).run(row);
      return { row, won: true };
    } catch {
      return { row: this.db.prepare('SELECT * FROM effects WHERE run_id = ? AND effect_id = ? AND attempt = ?').get(row.run_id, row.effect_id, row.attempt) as EffectRow, won: false };
    }
  }
  updateEffect(runId: string, effectId: string, attempt: number, patch: Partial<EffectRow>): void {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE effects SET ${sets} WHERE run_id = @run_id AND effect_id = @effect_id AND attempt = @attempt`).run({ ...patch, run_id: runId, effect_id: effectId, attempt });
  }
  /** A completed outcome already recorded for this business identity, in any run. */
  completedEffect(businessKey: string): EffectRow | undefined {
    return this.db.prepare(`SELECT * FROM effects WHERE business_key = ? AND state = 'completed' AND outcome_json IS NOT NULL ORDER BY attempt ASC LIMIT 1`).get(businessKey) as EffectRow | undefined;
  }
  effectsForRun(runId: string): EffectRow[] {
    return this.db.prepare('SELECT * FROM effects WHERE run_id = ? ORDER BY at ASC, attempt ASC').all(runId) as EffectRow[];
  }
  /** The terminal outcome a replay resolves from, keyed (sourceRunId, nodeId, nodeAttempt). */
  effectOutcome(runId: string, nodeId: string, attempt: number): EffectRow | undefined {
    return this.db.prepare('SELECT * FROM effects WHERE run_id = ? AND node_id = ? AND outcome_json IS NOT NULL ORDER BY attempt DESC LIMIT 1').get(runId, nodeId) as EffectRow | undefined;
  }

  // ── packs ─────────────────────────────────────────────────────────────────
  upsertChainChild(workflowId: string, definitionJson: string): void {
    this.db.prepare('INSERT INTO chain_workflows (workflow_id, definition_json) VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET definition_json = excluded.definition_json').run(workflowId, definitionJson);
  }
  deleteChainChild(workflowId: string): void {
    this.db.prepare('DELETE FROM chain_workflows WHERE workflow_id = ?').run(workflowId);
  }
  getChainWorkflow(workflowId: string): { workflow_id: string; definition_json: string } | undefined {
    return this.db.prepare('SELECT * FROM chain_workflows WHERE workflow_id = ?').get(workflowId) as { workflow_id: string; definition_json: string } | undefined;
  }
  recordChainOwnership(parentChainId: string, childWorkflowId: string, resolvedRef: string): void {
    this.db.prepare('INSERT INTO chain_ownership (parent_chain_id, child_workflow_id, resolved_ref) VALUES (?, ?, ?) ON CONFLICT(parent_chain_id, child_workflow_id) DO UPDATE SET resolved_ref = excluded.resolved_ref').run(parentChainId, childWorkflowId, resolvedRef);
  }
  dropChainOwnership(parentChainId: string, childWorkflowId: string): void {
    this.db.prepare('DELETE FROM chain_ownership WHERE parent_chain_id = ? AND child_workflow_id = ?').run(parentChainId, childWorkflowId);
  }
  chainChildrenOf(parentChainId: string): string[] {
    return (this.db.prepare('SELECT child_workflow_id FROM chain_ownership WHERE parent_chain_id = ?').all(parentChainId) as Array<{ child_workflow_id: string }>).map((r) => r.child_workflow_id);
  }
  chainParentCount(childWorkflowId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chain_ownership WHERE child_workflow_id = ?').get(childWorkflowId) as { n: number }).n;
  }

  getPack(catalog: string, name: string, version: string): PackRow | undefined {
    return this.db.prepare('SELECT * FROM packs WHERE catalog = ? AND name = ? AND version = ?').get(catalog, name, version) as PackRow | undefined;
  }
  insertPack(row: PackRow): void {
    this.db.prepare('INSERT INTO packs (catalog, name, version, kind, manifest_json, tarball, sha256, published_at) VALUES (@catalog, @name, @version, @kind, @manifest_json, @tarball, @sha256, @published_at)').run(row);
  }
  deletePack(catalog: string, name: string, version: string): boolean {
    return this.db.prepare('DELETE FROM packs WHERE catalog = ? AND name = ? AND version = ?').run(catalog, name, version).changes > 0;
  }
  listPacks(catalog: string): PackRow[] {
    return this.db.prepare('SELECT * FROM packs WHERE catalog = ? ORDER BY name, version').all(catalog) as PackRow[];
  }

  // ── annotations ───────────────────────────────────────────────────────────
  insertAnnotation(row: AnnotationRow): void {
    this.db.prepare('INSERT INTO annotations (annotation_id, run_id, json, created_at) VALUES (@annotation_id, @run_id, @json, @created_at)').run(row);
  }
  annotationsForRun(runId: string): AnnotationRow[] {
    return this.db.prepare('SELECT * FROM annotations WHERE run_id = ? ORDER BY created_at ASC').all(runId) as AnnotationRow[];
  }

  // ── workspace files ───────────────────────────────────────────────────────
  workspaceFile(tenant: string, workspace: string, path: string): WorkspaceFileRow | undefined {
    return this.db.prepare('SELECT * FROM workspace_files WHERE tenant = ? AND workspace = ? AND path = ?').get(tenant, workspace, path) as WorkspaceFileRow | undefined;
  }
  workspaceFiles(tenant: string, workspace: string, prefix: string): WorkspaceFileRow[] {
    return this.db.prepare('SELECT * FROM workspace_files WHERE tenant = ? AND workspace = ? AND path LIKE ? ORDER BY path').all(tenant, workspace, `${prefix.replace(/[%_]/g, '')}%`) as WorkspaceFileRow[];
  }
  upsertWorkspaceFile(row: WorkspaceFileRow): void {
    this.db.prepare(`INSERT INTO workspace_files (tenant, workspace, path, content, content_type, version, etag, updated_at) VALUES (@tenant, @workspace, @path, @content, @content_type, @version, @etag, @updated_at)
      ON CONFLICT(tenant, workspace, path) DO UPDATE SET content = excluded.content, content_type = excluded.content_type, version = excluded.version, etag = excluded.etag, updated_at = excluded.updated_at`).run(row);
  }
  deleteWorkspaceFile(tenant: string, workspace: string, path: string): boolean {
    return this.db.prepare('DELETE FROM workspace_files WHERE tenant = ? AND workspace = ? AND path = ?').run(tenant, workspace, path).changes > 0;
  }
}
