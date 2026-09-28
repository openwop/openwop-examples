/**
 * RFC 0224 — the `auditLogIntegrity` family's host-internal half (audit.ts).
 * The black-box suite witnesses the verify body, each checkpoint signature and
 * the cadence; it cannot recompute a root or tamper with the store, so those
 * are asserted here, against a real SQLite database:
 *   - the log is append-only at the storage layer;
 *   - checkpoints anchor at most `checkpointIntervalEntries` entries, and each
 *     signature is Ed25519 over the root's 32 bytes under the advertised key;
 *   - an in-place edit, a re-rooted checkpoint and a forged signature each
 *     turn `chainValid` false with the matching anomaly kind.
 */
import Database from 'better-sqlite3';
import { createPublicKey, createHash, sign, verify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';

function fresh(every = 3): { db: Database.Database; log: AuditLog } {
  const db = new Database(':memory:');
  const log = new AuditLog(db, ':memory:', { checkpointIntervalEntries: every, checkpointIntervalSeconds: 3600 });
  return { db, log };
}
const entry = (i: number) => ({ actor: 'api-key#t', action: 'POST /runs', target: `/runs/${i}`, details: { n: i } });
const keyOf = (log: AuditLog) => createPublicKey({ key: Buffer.from(String(log.facets()['checkpointPublicKey']), 'base64'), format: 'der', type: 'spki' });

describe('audit.ts — the auditLogIntegrity family, host-internal', () => {
  it('advertises the facet set the family schema requires', () => {
    const { log } = fresh();
    const f = log.facets();
    expect(f['checkpointSignatureAlgorithm']).toBe('ed25519');
    expect(String(f['checkpointPublicKey'])).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
    expect(f['checkpointIntervalEntries']).toBe(3);
    expect(f['checkpointIntervalSeconds']).toBe(3600);
  });

  it('checkpoints no more than checkpointIntervalEntries apart, each signed over the root bytes', () => {
    const { log } = fresh(3);
    for (let i = 1; i <= 10; i++) log.append(entry(i));
    const r = log.verify(0, 1_000_000);
    expect(r.chainValid).toBe(true);
    expect(r.anomalies).toEqual([]);
    const seqs = r.checkpoints.map((c) => c.atSequence);
    // The first append checkpoints at once (no prior anchor), then every 3.
    expect(seqs).toEqual([1, 4, 7, 10]);
    let prev = 0;
    for (const cp of r.checkpoints) {
      expect(cp.atSequence - prev).toBeLessThanOrEqual(3);
      prev = cp.atSequence;
      expect(verify(null, Buffer.from(cp.merkleRoot, 'hex'), keyOf(log), Buffer.from(cp.signature, 'base64'))).toBe(true);
      // Not over the hex text: the sabotage the suite's signature row refuses.
      expect(verify(null, Buffer.from(cp.merkleRoot, 'utf8'), keyOf(log), Buffer.from(cp.signature, 'base64'))).toBe(false);
    }
  });

  it('echoes the requested range and lists only in-range checkpoints', () => {
    const { log } = fresh(3);
    for (let i = 1; i <= 7; i++) log.append(entry(i));
    const r = log.verify(2, 5);
    expect([r.fromSeq, r.toSeq]).toEqual([2, 5]);
    expect(r.checkpoints.map((c) => c.atSequence)).toEqual([4]);
  });

  it('refuses UPDATE and DELETE at the storage layer', () => {
    const { db, log } = fresh();
    log.append(entry(1));
    expect(() => db.prepare("UPDATE audit_log SET actor = 'x' WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log WHERE seq = 1').run()).toThrow(/append-only/);
  });

  it('an in-place edit (triggers bypassed) is a hash-mismatch, a chain-break and a merkle-mismatch', () => {
    const { db, log } = fresh(3);
    for (let i = 1; i <= 6; i++) log.append(entry(i));
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare("UPDATE audit_log SET details_json = '{\"n\":99}' WHERE seq = 3").run();
    const r = log.verify(0, 1_000_000);
    expect(r.chainValid).toBe(false);
    expect(r.checkpointsValid).toBe(false);
    const kinds = r.anomalies.map((a) => `${a.kind}@${a.atSeq}`);
    expect(kinds).toContain('hash-mismatch@3');
    expect(kinds).toContain('chain-break@4');
    expect(kinds).toContain('merkle-mismatch@4');
  });

  it('a forged signature and a re-rooted checkpoint each fail the aggregate verdict', () => {
    const { db, log } = fresh(3);
    for (let i = 1; i <= 4; i++) log.append(entry(i));
    const other = generateKeyPairSync('ed25519').privateKey;
    const cp = db.prepare('SELECT checkpoint_id, merkle_root FROM audit_checkpoints WHERE at_sequence = 4').get() as { checkpoint_id: string; merkle_root: string };
    db.prepare('UPDATE audit_checkpoints SET signature = ? WHERE checkpoint_id = ?').run(sign(null, Buffer.from(cp.merkle_root, 'hex'), other).toString('base64'), cp.checkpoint_id);
    let r = log.verify(0, 100);
    expect(r.chainValid).toBe(false);
    expect(r.anomalies.map((a) => a.kind)).toEqual(['signature-invalid']);

    const root = createHash('sha256').update('not-the-root').digest('hex');
    db.prepare('UPDATE audit_checkpoints SET merkle_root = ? WHERE checkpoint_id = ?').run(root, cp.checkpoint_id);
    r = log.verify(0, 100);
    expect(r.anomalies.map((a) => a.kind)).toEqual(['merkle-mismatch', 'signature-invalid']);
  });
});
