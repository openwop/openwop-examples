/**
 * The `auditLogIntegrity` family (RFC 0224; spec/v2/core/security-defaults.md
 * §Audit-log integrity). The construction is the SQLite and Postgres hosts'
 * `src/audit.ts`, unchanged, because RFC 0218 §A pinned exactly that one:
 *
 *   1. Append-only `audit_log` — triggers refuse UPDATE and DELETE.
 *   2. Hash chain — each entry carries `prevHash`, the lowercase-hex SHA-256 of
 *      the prior entry's JCS bytes; `null` for the first.
 *   3. Checkpoints — a Merkle root over the entries in (P, atSequence], pairs
 *      hashed as the ASCII of `left ‖ right`, an odd node promoted; Ed25519
 *      over the root's 32 bytes. One is minted when `checkpointIntervalEntries`
 *      entries have accrued or `checkpointIntervalSeconds` have passed, checked
 *      on every append, so no checkpoint anchors more than the advertised count.
 *   4. `GET /audit/verify` — re-walks the chain and every in-range checkpoint
 *      (root recomputed from the entries' current content, signature checked)
 *      and answers `schemas/v2/audit-verify-result.schema.json`.
 *
 * What is appended: every successful authenticated write the router serves
 * (`router.ts`), plus `host.started` at boot, which also forces a checkpoint so
 * a fresh host has one signed anchor. Seams are not audited — they are a test
 * surface, not an operation.
 *
 * The signing key is used for nothing else (not the bundle key in `keys/`). It
 * persists beside the database; an in-memory database gets an ephemeral key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

export interface AuditEntryInput {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly details: Record<string, unknown>;
}

interface EntryRow {
  readonly seq: number;
  readonly occurred_at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly details_json: string;
  readonly prev_hash: string | null;
  readonly entry_hash: string;
}

interface CheckpointRow {
  readonly checkpoint_id: string;
  readonly at_sequence: number;
  readonly merkle_root: string;
  readonly signature: string;
  readonly signed_at: string;
}

/** `$defs/Anomaly` (RFC 0218 §C): `kind` fixes the members; `chainValid` is false exactly when one is present. */
export type Anomaly =
  | { readonly atSeq: number; readonly kind: 'chain-break'; readonly expectedPrevHash: string | null; readonly actualPrevHash: string | null; readonly detail: string }
  | { readonly atSeq: number; readonly kind: 'hash-mismatch' | 'missing-entry'; readonly detail: string }
  | { readonly atSeq: number; readonly kind: 'merkle-mismatch' | 'signature-invalid'; readonly checkpoint: string; readonly detail: string };

export interface VerifyResult {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly chainValid: boolean;
  readonly checkpointsValid: boolean;
  readonly checkpoints: Array<{ readonly checkpoint: string; readonly atSequence: number; readonly merkleRoot: string; readonly signature: string }>;
  readonly anomalies: Anomaly[];
}

export interface AuditOptions {
  readonly checkpointIntervalEntries: number;
  readonly checkpointIntervalSeconds: number;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    seq INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details_json TEXT NOT NULL,
    prev_hash TEXT,
    entry_hash TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS audit_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    at_sequence INTEGER NOT NULL,
    merkle_root TEXT NOT NULL,
    signature TEXT NOT NULL,
    signed_at TEXT NOT NULL,
    signing_key_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_seq ON audit_checkpoints(at_sequence);
  CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(FAIL, 'audit_log is append-only (security-defaults.md §Audit-log integrity)'); END;
  CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(FAIL, 'audit_log is append-only (security-defaults.md §Audit-log integrity)'); END;
`;

/**
 * JCS for every I-JSON value (RFC 8785, RFC 0212): keys sorted by UTF-16 code
 * units, ECMAScript number and string serialization. An `undefined` member is
 * dropped so the pre-storage hash equals the post-round-trip one; callers pass
 * none.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function entryHash(row: { seq: number; occurredAt: string; actor: string; action: string; target: string; details: unknown; prevHash: string | null }): string {
  return sha256Hex(canonicalize({ action: row.action, actor: row.actor, atSequence: row.seq, details: row.details, occurredAt: row.occurredAt, prevHash: row.prevHash, target: row.target }));
}

function rowHash(r: EntryRow): string {
  return entryHash({ seq: r.seq, occurredAt: r.occurred_at, actor: r.actor, action: r.action, target: r.target, details: JSON.parse(r.details_json) as unknown, prevHash: r.prev_hash });
}

/** RFC 0218 §A.3 — pairwise, the ASCII of `left ‖ right`, the last odd node promoted unchanged. */
function merkleRoot(leaves: readonly string[]): string {
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      next.push(right === undefined ? level[i]! : sha256Hex(level[i]! + right));
    }
    level = next;
  }
  return level[0] ?? sha256Hex('');
}

interface SigningKey { readonly keyId: string; readonly privateKey: KeyObject; readonly publicKey: KeyObject; readonly spkiB64: string }

function loadOrCreateKey(dbPath: string): SigningKey {
  const ephemeral = dbPath === ':memory:';
  const privPath = join(dirname(dbPath), 'audit-signing-key.pem');
  const pubPath = join(dirname(dbPath), 'audit-signing-key.pub');
  let privatePem: string;
  let publicPem: string;
  if (!ephemeral && existsSync(privPath) && existsSync(pubPath)) {
    privatePem = readFileSync(privPath, 'utf8');
    publicPem = readFileSync(pubPath, 'utf8');
  } else {
    const pair = generateKeyPairSync('ed25519');
    privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    if (!ephemeral) {
      writeFileSync(privPath, privatePem, { mode: 0o600 });
      writeFileSync(pubPath, publicPem, { mode: 0o644 });
    }
  }
  const publicKey = createPublicKey(publicPem);
  return { keyId: sha256Hex(publicPem).slice(0, 16), privateKey: createPrivateKey(privatePem), publicKey, spkiB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

export class AuditLog {
  private readonly key: SigningKey;

  constructor(private readonly db: Database.Database, dbPath: string, readonly options: AuditOptions) {
    db.exec(DDL);
    this.key = loadOrCreateKey(dbPath);
  }

  /** The family record's facets (spec/v2/facets/auditLogIntegrity.schema.json). */
  facets(): Record<string, unknown> {
    return { checkpointSignatureAlgorithm: 'ed25519', checkpointPublicKey: this.key.spkiB64, checkpointIntervalEntries: this.options.checkpointIntervalEntries, checkpointIntervalSeconds: this.options.checkpointIntervalSeconds };
  }

  /** Append one entry, then mint a checkpoint if either interval is due. */
  append(input: AuditEntryInput): number {
    const occurredAt = new Date().toISOString();
    const seq = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; entry_hash: string } | undefined;
      const prevHash = prior?.entry_hash ?? null;
      const next = (prior?.seq ?? 0) + 1;
      const hash = entryHash({ seq: next, occurredAt, actor: input.actor, action: input.action, target: input.target, details: input.details, prevHash });
      this.db.prepare('INSERT INTO audit_log (seq, occurred_at, actor, action, target, details_json, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(next, occurredAt, input.actor, input.action, input.target, canonicalize(input.details), prevHash, hash);
      return next;
    })();
    this.checkpointIfDue();
    return seq;
  }

  /** Anchor every entry since the last checkpoint; null when there is none. */
  checkpoint(): CheckpointRow | null {
    const last = this.db.prepare('SELECT at_sequence FROM audit_checkpoints ORDER BY at_sequence DESC LIMIT 1').get() as { at_sequence: number } | undefined;
    const from = (last?.at_sequence ?? 0) + 1;
    const tip = (this.db.prepare('SELECT MAX(seq) AS max FROM audit_log').get() as { max: number | null }).max ?? 0;
    if (tip < from) return null;
    const leaves = (this.db.prepare('SELECT entry_hash FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq ASC').all(from, tip) as Array<{ entry_hash: string }>).map((e) => e.entry_hash);
    const root = merkleRoot(leaves);
    const row: CheckpointRow = { checkpoint_id: `cp-${randomUUID()}`, at_sequence: tip, merkle_root: root, signature: sign(null, Buffer.from(root, 'hex'), this.key.privateKey).toString('base64'), signed_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO audit_checkpoints (checkpoint_id, at_sequence, merkle_root, signature, signed_at, signing_key_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.checkpoint_id, row.at_sequence, row.merkle_root, row.signature, row.signed_at, this.key.keyId);
    return row;
  }

  private checkpointIfDue(): void {
    const last = this.db.prepare('SELECT at_sequence, signed_at FROM audit_checkpoints ORDER BY at_sequence DESC LIMIT 1').get() as { at_sequence: number; signed_at: string } | undefined;
    const tip = (this.db.prepare('SELECT MAX(seq) AS max FROM audit_log').get() as { max: number | null }).max ?? 0;
    if (tip === 0) return;
    const entries = tip - (last?.at_sequence ?? 0);
    const seconds = last ? (Date.now() - Date.parse(last.signed_at)) / 1000 : Number.POSITIVE_INFINITY;
    if (entries >= this.options.checkpointIntervalEntries || seconds >= this.options.checkpointIntervalSeconds) this.checkpoint();
  }

  /**
   * Re-walk [fromSeq, toSeq] clamped to the log, and every checkpoint in it.
   * `chainValid` is the aggregate verdict (RFC 0218 §C): false exactly when an
   * anomaly is present, including a forged or re-rooted checkpoint.
   */
  verify(fromSeq: number, toSeq: number): VerifyResult {
    const tip = (this.db.prepare('SELECT MAX(seq) AS max FROM audit_log').get() as { max: number | null }).max ?? 0;
    const lo = Math.max(1, fromSeq);
    const hi = Math.min(toSeq, tip);
    const anomalies: Anomaly[] = [];
    if (hi < lo) return { fromSeq, toSeq, chainValid: true, checkpointsValid: true, checkpoints: [], anomalies };

    const rows = this.db.prepare('SELECT * FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq ASC').all(lo, hi) as EntryRow[];
    let expectedPrev: string | null = lo > 1 ? ((this.db.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(lo - 1) as { entry_hash: string } | undefined)?.entry_hash ?? null) : null;
    let expectedSeq = lo;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        anomalies.push({ atSeq: expectedSeq, kind: 'missing-entry', detail: `expected seq ${expectedSeq}, found ${row.seq}` });
        expectedSeq = row.seq;
      }
      if (row.prev_hash !== expectedPrev) {
        anomalies.push({ atSeq: row.seq, kind: 'chain-break', expectedPrevHash: expectedPrev, actualPrevHash: row.prev_hash, detail: 'prevHash does not match the prior entry' });
      }
      const recomputed = rowHash(row);
      if (recomputed !== row.entry_hash) anomalies.push({ atSeq: row.seq, kind: 'hash-mismatch', detail: `recomputed ${recomputed} != stored ${row.entry_hash}` });
      // Advance on the RECOMPUTED hash so an in-place edit also breaks the next link.
      expectedPrev = recomputed;
      expectedSeq = row.seq + 1;
    }

    const cps = this.db.prepare('SELECT * FROM audit_checkpoints WHERE at_sequence BETWEEN ? AND ? ORDER BY at_sequence ASC').all(lo, hi) as CheckpointRow[];
    let checkpointsValid = true;
    cps.forEach((cp, i) => {
      const prior = i > 0 ? cps[i - 1]!.at_sequence : ((this.db.prepare('SELECT at_sequence FROM audit_checkpoints WHERE at_sequence < ? ORDER BY at_sequence DESC LIMIT 1').get(cp.at_sequence) as { at_sequence: number } | undefined)?.at_sequence ?? 0);
      // RFC 0218 §A.5 — the leaf count is held to atSequence − P.
      const anchored = this.db.prepare('SELECT * FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq ASC').all(prior + 1, cp.at_sequence) as EntryRow[];
      const recomputedRoot = anchored.length === cp.at_sequence - prior ? merkleRoot(anchored.map(rowHash)) : null;
      if (recomputedRoot !== cp.merkle_root) {
        anomalies.push({ atSeq: cp.at_sequence, kind: 'merkle-mismatch', checkpoint: cp.checkpoint_id, detail: recomputedRoot === null ? `${anchored.length} entries anchored, ${cp.at_sequence - prior} expected` : `recomputed ${recomputedRoot} != stored ${cp.merkle_root}` });
        checkpointsValid = false;
      }
      let signed = false;
      try { signed = verify(null, Buffer.from(cp.merkle_root, 'hex'), this.key.publicKey, Buffer.from(cp.signature, 'base64')); } catch { signed = false; }
      if (!signed) {
        anomalies.push({ atSeq: cp.at_sequence, kind: 'signature-invalid', checkpoint: cp.checkpoint_id, detail: `Ed25519 signature does not verify under ${this.key.keyId}` });
        checkpointsValid = false;
      }
    });

    return {
      fromSeq,
      toSeq,
      chainValid: anomalies.length === 0,
      checkpointsValid,
      checkpoints: cps.map((cp) => ({ checkpoint: cp.checkpoint_id, atSequence: cp.at_sequence, merkleRoot: cp.merkle_root, signature: cp.signature })),
      anomalies,
    };
  }
}
