/**
 * HITL interrupts for the SQLite reference host.
 *
 * Implements the baseline `interrupt.md` resolve surface
 * (`POST /v1/runs/{runId}/interrupts/{nodeId}`) plus the
 * `openwop-interrupt-quorum` profile (`interrupt-profiles.md`).
 *
 * Node types supported:
 *   - `core.approvalGate` — single-approver or quorum approval. Config:
 *     `{ actions: ['accept', 'reject'], requiredApprovals?: number,
 *        rejectionPolicy?: 'first'|'majority', approversList?: string[] }`.
 *   - `core.clarificationGate` — single-resolve clarification. Config:
 *     `{ questions: [{ id, question, kind? }] }`.
 *
 * Resolve semantics:
 *   - Approval: each POST adds one {action, voter, timestamp} vote. Resume
 *     fires when `accepts === requiredApprovals` (default 1). Termination
 *     fires when rejects satisfy the rejection policy (default 'first';
 *     'majority' terminates when rejects > floor(requiredApprovals / 2)).
 *   - Clarification: single POST with {answers: {questionId: string, ...}}.
 *     Each `id` declared in config.questions MUST appear in answers.
 *
 * @see spec/v1/interrupt.md
 * @see spec/v1/interrupt-profiles.md §openwop-interrupt-quorum
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export type InterruptKind = 'approval' | 'clarification' | 'external-event';

export interface ApprovalConfig {
  readonly actions: ReadonlyArray<string>;
  readonly requiredApprovals?: number;
  readonly rejectionPolicy?: 'first' | 'majority';
  readonly approversList?: ReadonlyArray<string>;
  readonly title?: string;
  readonly description?: string;
}

export interface ClarificationConfig {
  readonly questions: ReadonlyArray<{ id: string; question: string; kind?: string }>;
}

export interface ExternalEventConfig {
  readonly eventType?: string;
  readonly correlation?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

/**
 * `interrupt.md` §Approval `RefineFeedback`, as closed by
 * `schemas/v2/run-event-payloads.schema.json#/$defs/interruptResolved`
 * (RFC 0183 §A.2): `required: [scope]`, `additionalProperties: false`.
 */
export interface RefineFeedback {
  readonly scope: 'whole' | 'section' | 'items';
  readonly sectionPath?: string;
  readonly itemIds?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly text?: string;
}

const REFINE_SCOPES: ReadonlySet<string> = new Set(['whole', 'section', 'items']);
const REFINE_FEEDBACK_KEYS: ReadonlySet<string> = new Set(['scope', 'sectionPath', 'itemIds', 'tags', 'text']);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Returns an error message, or null when `v` is a well-formed RefineFeedback. */
function refineFeedbackError(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return "resumeValue.refineFeedback is REQUIRED for action 'refine' and MUST be an object (interrupt.md §Approval).";
  }
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!REFINE_FEEDBACK_KEYS.has(key)) return `resumeValue.refineFeedback.${key} is not a RefineFeedback field.`;
  }
  if (typeof o.scope !== 'string' || !REFINE_SCOPES.has(o.scope)) {
    return 'resumeValue.refineFeedback.scope MUST be one of [whole, section, items].';
  }
  if (o.sectionPath !== undefined && typeof o.sectionPath !== 'string') return 'resumeValue.refineFeedback.sectionPath MUST be a string.';
  if (o.itemIds !== undefined && !isStringArray(o.itemIds)) return 'resumeValue.refineFeedback.itemIds MUST be an array of strings.';
  if (o.tags !== undefined && !isStringArray(o.tags)) return 'resumeValue.refineFeedback.tags MUST be an array of strings.';
  if (o.text !== undefined && typeof o.text !== 'string') return 'resumeValue.refineFeedback.text MUST be a string.';
  return null;
}

export type InterruptConfig = ApprovalConfig | ClarificationConfig | ExternalEventConfig;

export interface Vote {
  readonly action: string;
  readonly voter?: string;
  readonly timestamp: string;
}

export interface InterruptRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly kind: InterruptKind;
  readonly config_json: string;
  readonly payload_json: string;
  readonly votes_json: string;
  readonly resolved_at: string | null;
  readonly outcome: string | null;
  readonly callback_token: string | null;
  readonly expires_at: string | null;
}

export type ResolveOutcome =
  | { kind: 'pending'; votes: Vote[] }
  | {
      kind: 'resumed';
      votes: Vote[];
      /** `accept` or `edit-accept` — the action that released the gate. */
      finalAction: string;
      /** Present iff `finalAction === 'edit-accept'` (RFC 0183 §A.2). */
      editedArtifactData?: unknown;
    }
  | { kind: 'rejected'; votes: Vote[] }
  /**
   * RFC 0183 — `refine` resolves THIS suspension with structured feedback and
   * sends the gate back for another pass. The SQLite executor has no generator
   * node to re-invoke with the feedback, so the caller re-enters the executor
   * at the gate itself, which re-suspends it as a fresh interrupt.
   */
  | { kind: 'refined'; votes: Vote[]; refineFeedback: RefineFeedback }
  | { kind: 'invalid'; status: 400 | 422; code: string; message: string }
  | { kind: 'expired' }
  | { kind: 'unknown' };

export function setupInterruptSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interrupts (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      config_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      votes_json TEXT NOT NULL DEFAULT '[]',
      resolved_at TEXT,
      outcome TEXT,
      callback_token TEXT,
      expires_at TEXT,
      PRIMARY KEY (run_id, node_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_interrupts_run ON interrupts(run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_interrupts_token ON interrupts(callback_token)
      WHERE callback_token IS NOT NULL;
  `);

  // Idempotent migration: older DBs may lack `callback_token` / `expires_at`.
  const cols = db
    .prepare("PRAGMA table_info('interrupts')")
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('callback_token')) {
    db.exec("ALTER TABLE interrupts ADD COLUMN callback_token TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_interrupts_token ON interrupts(callback_token) WHERE callback_token IS NOT NULL",
    );
  }
  if (!have.has('expires_at')) {
    db.exec("ALTER TABLE interrupts ADD COLUMN expires_at TEXT");
  }
}

/** Generate a 128-bit unguessable token for signed-callback resume. */
export function generateCallbackToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Persist a new interrupt when a node suspends. Returns the callback token for external-event kinds. */
export function createInterrupt(
  db: Database.Database,
  runId: string,
  nodeId: string,
  kind: InterruptKind,
  config: InterruptConfig,
  payload: Record<string, unknown>,
): string | null {
  const callbackToken = kind === 'external-event' ? generateCallbackToken() : null;
  // External-event interrupts honor `config.timeoutMs` from the fixture
  // (interrupt-profiles.md §"openwop-interrupt-external-event"). Other
  // kinds run unbounded — operators ratify approvals on their own
  // schedule, which the spec does not constrain at the protocol level.
  const timeoutMs =
    kind === 'external-event' ? (config as ExternalEventConfig).timeoutMs : undefined;
  const expiresAt =
    typeof timeoutMs === 'number' && timeoutMs > 0
      ? new Date(Date.now() + timeoutMs).toISOString()
      : null;
  // A node can suspend more than once in one run (an approval gate sent back
  // by `refine`, RFC 0183). The (run_id, node_id) key is reused: a RESOLVED
  // prior row is replaced by the fresh suspension; an ACTIVE one is left alone.
  db.prepare(
    `INSERT INTO interrupts (run_id, node_id, kind, config_json, payload_json, callback_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, node_id) DO UPDATE SET
       kind = excluded.kind, config_json = excluded.config_json, payload_json = excluded.payload_json,
       votes_json = '[]', resolved_at = NULL, outcome = NULL,
       callback_token = excluded.callback_token, expires_at = excluded.expires_at
     WHERE interrupts.resolved_at IS NOT NULL`,
  ).run(
    runId,
    nodeId,
    kind,
    JSON.stringify(config),
    JSON.stringify(payload),
    callbackToken,
    expiresAt,
  );
  return callbackToken;
}

/** Look up an interrupt by its signed callback token. */
export function getInterruptByToken(
  db: Database.Database,
  token: string,
): InterruptRow | undefined {
  return db
    .prepare(
      'SELECT * FROM interrupts WHERE callback_token = ? AND resolved_at IS NULL',
    )
    .get(token) as InterruptRow | undefined;
}

/** True iff the interrupt's `expires_at` is in the past. */
export function isInterruptExpired(row: InterruptRow): boolean {
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() <= Date.now();
}

/**
 * Mark an interrupt as expired. Idempotent — re-marking is a no-op.
 * Returns true if a row was actually flipped (the interrupt was active
 * up to this call); false if it was already resolved or didn't exist.
 */
export function markExpired(
  db: Database.Database,
  runId: string,
  nodeId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE interrupts SET resolved_at = ?, outcome = 'expired'
       WHERE run_id = ? AND node_id = ? AND resolved_at IS NULL`,
    )
    .run(new Date().toISOString(), runId, nodeId);
  return result.changes > 0;
}

/**
 * Apply an external-event resolve via signed callback token. The resume
 * value MUST shallow-match every key in the fixture's `config.correlation`
 * map; mismatches return `invalid` (caller MUST return 422).
 */
export function resolveExternalEvent(
  db: Database.Database,
  runId: string,
  nodeId: string,
  resumeValue: unknown,
): ResolveOutcome {
  const row = getInterrupt(db, runId, nodeId);
  if (!row || row.kind !== 'external-event') return { kind: 'unknown' };
  if (isInterruptExpired(row)) {
    markExpired(db, runId, nodeId);
    return { kind: 'expired' };
  }

  if (typeof resumeValue !== 'object' || resumeValue === null) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: 'resumeValue MUST be an object.',
    };
  }

  const config = JSON.parse(row.config_json) as ExternalEventConfig;
  const correlation = config.correlation ?? {};
  const rv = resumeValue as Record<string, unknown>;
  for (const [key, expected] of Object.entries(correlation)) {
    if (!deepEqual(rv[key], expected)) {
      return {
        kind: 'invalid',
        status: 422,
        code: 'correlation_mismatch',
        message: `External event correlation key "${key}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(rv[key])}.`,
      };
    }
  }

  const vote: Vote = { action: 'external-event', timestamp: new Date().toISOString() };
  markResolved(db, runId, nodeId, 'resolved', [vote]);
  return { kind: 'resumed', votes: [vote], finalAction: 'external-event' };
}

/**
 * Structural-equality check for correlation values. Handles nested
 * objects by comparing key sets + recursive value equality (key order
 * doesn't matter, so two objects that differ only in declaration order
 * compare equal). Sufficient for any JSON-deserialized value —
 * `undefined`, `Symbol`, function values etc. can't appear here.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export function getInterrupt(
  db: Database.Database,
  runId: string,
  nodeId: string,
): InterruptRow | undefined {
  return db
    .prepare('SELECT * FROM interrupts WHERE run_id = ? AND node_id = ? AND resolved_at IS NULL')
    .get(runId, nodeId) as InterruptRow | undefined;
}

/** Most-recent unresolved interrupt for the run, if any. */
export function getActiveInterrupt(
  db: Database.Database,
  runId: string,
): InterruptRow | undefined {
  return db
    .prepare(
      'SELECT * FROM interrupts WHERE run_id = ? AND resolved_at IS NULL ORDER BY rowid DESC LIMIT 1',
    )
    .get(runId) as InterruptRow | undefined;
}

function markResolved(
  db: Database.Database,
  runId: string,
  nodeId: string,
  outcome: string,
  votes: Vote[],
): void {
  db.prepare(
    `UPDATE interrupts SET resolved_at = ?, outcome = ?, votes_json = ?
     WHERE run_id = ? AND node_id = ?`,
  ).run(new Date().toISOString(), outcome, JSON.stringify(votes), runId, nodeId);
}

/** Update vote ledger without resolving (partial quorum). */
function updateVotes(
  db: Database.Database,
  runId: string,
  nodeId: string,
  votes: Vote[],
): void {
  db.prepare('UPDATE interrupts SET votes_json = ? WHERE run_id = ? AND node_id = ?').run(
    JSON.stringify(votes),
    runId,
    nodeId,
  );
}

/**
 * Apply an approval-gate resolve. Returns the outcome:
 *   - `pending`  — vote recorded; quorum not yet met
 *   - `resumed`  — accept-quorum reached, executor SHOULD continue
 *   - `rejected` — reject-policy triggered, run SHOULD terminate
 *   - `invalid`  — payload fails schema (caller MUST return 400/422)
 *   - `unknown`  — no active interrupt at (run, node) (caller MUST return 404)
 */
export function resolveApproval(
  db: Database.Database,
  runId: string,
  nodeId: string,
  resumeValue: unknown,
): ResolveOutcome {
  const row = getInterrupt(db, runId, nodeId);
  if (!row || row.kind !== 'approval') return { kind: 'unknown' };
  if (isInterruptExpired(row)) {
    markExpired(db, runId, nodeId);
    return { kind: 'expired' };
  }

  if (typeof resumeValue !== 'object' || resumeValue === null) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: 'resumeValue MUST be an object.',
    };
  }

  const rv = resumeValue as {
    action?: unknown;
    voter?: unknown;
    refineFeedback?: unknown;
    editedArtifactData?: unknown;
  };
  const action = rv.action;
  const config = JSON.parse(row.config_json) as ApprovalConfig;
  if (typeof action !== 'string' || !config.actions.includes(action)) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: `resumeValue.action MUST be one of [${config.actions.join(', ')}]`,
    };
  }

  // interrupt.md §Approval — the per-action required field. RFC 0183 §A.2:
  // `refine` and `edit-accept` are incomplete without their payload, so a
  // resolution missing it is refused rather than recorded half-formed.
  if (action === 'refine') {
    const err = refineFeedbackError(rv.refineFeedback);
    if (err !== null) {
      return { kind: 'invalid', status: 400, code: 'validation_error', message: err };
    }
  }
  if (action === 'edit-accept' && rv.editedArtifactData === undefined) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: "resumeValue.editedArtifactData is REQUIRED for action 'edit-accept' (interrupt.md §Approval).",
    };
  }

  const votes = JSON.parse(row.votes_json) as Vote[];
  const newVote: Vote = {
    action,
    timestamp: new Date().toISOString(),
    ...(typeof rv.voter === 'string' ? { voter: rv.voter } : {}),
  };

  // Per-voter last-write-wins semantics (NOT classical idempotency).
  // A second vote from the same voter REPLACES their prior vote —
  // this supports the revote-after-discussion UX common in quorum
  // approval gates. Anonymous votes (no voter id) always append.
  // See interrupt-profiles.md §"openwop-interrupt-quorum" — the spec's
  // "duplicate decisions … are idempotent and auditable" applies to
  // strict-duplicate (same voter, same action) where the resulting
  // vote ledger is functionally unchanged.
  const updatedVotes = newVote.voter
    ? [...votes.filter((v) => v.voter !== newVote.voter), newVote]
    : [...votes, newVote];

  // `refine` sends the artifact back: one approver's refine request resolves
  // this suspension (the vote ledger is closed out with it) — it is neither an
  // accept toward quorum nor a veto.
  if (action === 'refine') {
    markResolved(db, runId, nodeId, 'refined', updatedVotes);
    return { kind: 'refined', votes: updatedVotes, refineFeedback: rv.refineFeedback as RefineFeedback };
  }

  const required = config.requiredApprovals ?? 1;
  // `edit-accept` is an accept carrying the approver's edits.
  const accepts = updatedVotes.filter((v) => v.action === 'accept' || v.action === 'edit-accept').length;
  const rejects = updatedVotes.filter((v) => v.action === 'reject').length;
  const rejectionPolicy = config.rejectionPolicy ?? 'first';

  // Resume condition: enough accepts. The action recorded is the one applied
  // by the vote that released the gate.
  if (accepts >= required) {
    markResolved(db, runId, nodeId, 'accepted', updatedVotes);
    return action === 'edit-accept'
      ? { kind: 'resumed', votes: updatedVotes, finalAction: action, editedArtifactData: rv.editedArtifactData }
      : { kind: 'resumed', votes: updatedVotes, finalAction: 'accept' };
  }

  // Reject condition: per-policy.
  const rejectThreshold = rejectionPolicy === 'majority' ? Math.floor(required / 2) + 1 : 1;
  if (rejects >= rejectThreshold) {
    markResolved(db, runId, nodeId, 'rejected', updatedVotes);
    return { kind: 'rejected', votes: updatedVotes };
  }

  // Still waiting.
  updateVotes(db, runId, nodeId, updatedVotes);
  return { kind: 'pending', votes: updatedVotes };
}

/**
 * Apply a clarification-gate resolve. Returns `resumed` on success or
 * `invalid` on a payload that doesn't match the config's question set.
 */
export function resolveClarification(
  db: Database.Database,
  runId: string,
  nodeId: string,
  resumeValue: unknown,
): ResolveOutcome {
  const row = getInterrupt(db, runId, nodeId);
  if (!row || row.kind !== 'clarification') return { kind: 'unknown' };

  if (typeof resumeValue !== 'object' || resumeValue === null) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: 'resumeValue MUST be an object.',
    };
  }

  const rv = resumeValue as { answers?: unknown };
  if (typeof rv.answers !== 'object' || rv.answers === null) {
    return {
      kind: 'invalid',
      status: 400,
      code: 'validation_error',
      message: "resumeValue.answers MUST be an object keyed by question id.",
    };
  }

  const config = JSON.parse(row.config_json) as ClarificationConfig;
  const answers = rv.answers as Record<string, unknown>;
  for (const q of config.questions) {
    if (typeof answers[q.id] !== 'string') {
      return {
        kind: 'invalid',
        status: 422,
        code: 'validation_error',
        message: `Answer for question "${q.id}" MUST be a string.`,
      };
    }
  }

  // Single-vote resume.
  const vote: Vote = { action: 'resolve', timestamp: new Date().toISOString() };
  markResolved(db, runId, nodeId, 'resolved', [vote]);
  return { kind: 'resumed', votes: [vote], finalAction: 'resolve' };
}

/** Invalidate any active interrupt on a run (cancel cascade, parent-cancel, etc.). */
export function invalidateInterrupts(
  db: Database.Database,
  runId: string,
  reason: string,
): number {
  const result = db
    .prepare(
      `UPDATE interrupts SET resolved_at = ?, outcome = ?
       WHERE run_id = ? AND resolved_at IS NULL`,
    )
    .run(new Date().toISOString(), `invalidated:${reason}`, runId);
  return result.changes;
}
