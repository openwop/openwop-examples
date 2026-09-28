/**
 * Host-internal tamper-detection test for the audit-log integrity profile.
 *
 * Why this lives here and not in the conformance suite:
 *   The black-box conformance suite (`conformance/src/scenarios/audit-log-
 *   integrity.test.ts`) cannot mutate the host's audit store — by design,
 *   the profile's threat model assumes admin access is required to tamper.
 *   So conformance covers the chainValid happy path; this host-internal
 *   test covers the tamper-detection negative path.
 *
 * Run with: tsx test/audit-tamper.test.ts (or `npm test`).
 *
 * @see spec/v1/auth-profiles.md §"Audit-log integrity"
 * @see src/audit.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Simulate admin-bypass: install the audit schema without the
// append-only triggers so the test can `UPDATE audit_log` directly to
// emulate a privileged attacker. Production hosts run with the triggers
// in place; the verify endpoint is the audit's correctness check.
process.env.OPENWOP_AUDIT_ALLOW_TAMPER = 'true';

import {
  setupAuditSchema,
  loadOrCreateSigningKey,
  logAudit,
  createCheckpoint,
  verifyAuditChain,
} from '../src/audit.js';

/**
 * The member set `audit-verify-result.schema.json` `$defs/Anomaly` allows for
 * each `kind` (RFC 0218 §C). The schema closes the object, so an extra or a
 * missing member is a non-conforming anomaly, not a harmless one.
 */
const ANOMALY_MEMBERS: Record<string, readonly string[]> = {
  'chain-break': ['actualPrevHash', 'atSeq', 'detail', 'expectedPrevHash', 'kind'],
  'hash-mismatch': ['atSeq', 'detail', 'kind'],
  'missing-entry': ['atSeq', 'detail', 'kind'],
  'merkle-mismatch': ['atSeq', 'checkpoint', 'detail', 'kind'],
  'signature-invalid': ['atSeq', 'checkpoint', 'detail', 'kind'],
};

function assertSchemaShaped(anomalies: ReadonlyArray<object>, chainValid: boolean): void {
  assert.equal(chainValid, anomalies.length === 0, 'chainValid MUST be false exactly when anomalies is non-empty');
  for (const a of anomalies as ReadonlyArray<Record<string, unknown>>) {
    const expected = ANOMALY_MEMBERS[String(a.kind)];
    assert.ok(expected !== undefined, `unknown anomaly kind: ${JSON.stringify(a)}`);
    assert.deepEqual(Object.keys(a).sort(), expected, `anomaly members for ${String(a.kind)}: ${JSON.stringify(a)}`);
    assert.ok(Number.isInteger(a.atSeq) && (a.atSeq as number) >= 0, `atSeq is a sequence number: ${JSON.stringify(a)}`);
    if ('checkpoint' in a) assert.ok(typeof a.checkpoint === 'string' && a.checkpoint.length > 0, `checkpoint is an id: ${JSON.stringify(a)}`);
    if (a.kind === 'chain-break') {
      assert.ok(typeof a.expectedPrevHash === 'string' || a.expectedPrevHash === null, `expectedPrevHash: ${JSON.stringify(a)}`);
      assert.ok(typeof a.actualPrevHash === 'string' || a.actualPrevHash === null, `actualPrevHash: ${JSON.stringify(a)}`);
    }
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'openwop-audit-tamper-'));
try {
  const dbPath = join(workdir, 'audit.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  setupAuditSchema(db);

  const signingKey = loadOrCreateSigningKey(
    join(workdir, 'audit-signing-key.pem'),
    join(workdir, 'audit-signing-key.pub'),
  );

  // Seed five audit entries.
  for (let i = 1; i <= 5; i++) {
    logAudit(db, {
      actor: 'system',
      action: 'host.started',
      target: `process-${i}`,
      details: { ordinal: i },
    });
  }
  createCheckpoint(db, signingKey);

  // Verify clean chain WITH signing key (validates checkpoint signature + merkle).
  const cleanResult = verifyAuditChain(db, 0, 100, signingKey);
  assert.equal(cleanResult.chainValid, true, 'pre-tamper chain MUST be valid');
  assert.equal(cleanResult.checkpointsValid, true, 'pre-tamper checkpoints MUST be valid');
  assert.equal(cleanResult.anomalies.length, 0, 'pre-tamper chain MUST have zero anomalies');
  assertSchemaShaped(cleanResult.anomalies, cleanResult.chainValid);
  assert.ok(cleanResult.checkpoints.length >= 1, 'pre-tamper checkpoint MUST be present');
  assert.equal(
    cleanResult.checkpoints[0]?.verified,
    true,
    'pre-tamper checkpoint MUST be marked verified',
  );

  // TAMPER 1: mutate entry seq=3's details in place. This simulates a privileged
  // attacker rewriting a single audit row without touching the chain links.
  db.prepare("UPDATE audit_log SET details_json = ? WHERE seq = 3").run(
    JSON.stringify({ ordinal: 999, tampered: true }),
  );

  const tamperedResult = verifyAuditChain(db, 0, 100, signingKey);
  assert.equal(tamperedResult.chainValid, false, 'tampered chain MUST report chainValid: false');
  assert.ok(
    tamperedResult.anomalies.length >= 1,
    `tampered chain MUST report ≥1 anomaly; got ${tamperedResult.anomalies.length}`,
  );

  // Entry-level: hash-mismatch at seq=3 + chain-break at seq=4 (downstream propagation).
  const hashMismatch = tamperedResult.anomalies.find(
    (a) => a.kind === 'hash-mismatch' && a.atSeq === 3,
  );
  assert.ok(
    hashMismatch !== undefined,
    `expected hash-mismatch anomaly at seq=3, got: ${JSON.stringify(tamperedResult.anomalies)}`,
  );
  const chainBreak = tamperedResult.anomalies.find(
    (a) => a.kind === 'chain-break' && a.atSeq === 4,
  );
  assert.ok(
    chainBreak !== undefined,
    `expected chain-break anomaly at seq=4 (downstream of tamper), got: ${JSON.stringify(tamperedResult.anomalies)}`,
  );
  // Checkpoint-level: merkle root recomputed from tampered entries no longer
  // matches the stored root, so the checkpoint MUST flip to invalid.
  assert.equal(
    tamperedResult.checkpointsValid,
    false,
    'tampered chain MUST flip checkpointsValid to false (merkle root changes when an entry hash changes)',
  );
  const merkleMismatch = tamperedResult.anomalies.find((a) => a.kind === 'merkle-mismatch');
  assert.ok(
    merkleMismatch !== undefined,
    `expected merkle-mismatch anomaly, got: ${JSON.stringify(tamperedResult.anomalies)}`,
  );
  assertSchemaShaped(tamperedResult.anomalies, tamperedResult.chainValid);

  // TAMPER 2: mutate the checkpoint's signature directly. Reset entries first
  // so the entry chain is clean; the only tamper is on audit_checkpoints.
  db.prepare("UPDATE audit_log SET details_json = ? WHERE seq = 3").run(
    JSON.stringify({ ordinal: 3 }),
  );
  const originalSig = (db.prepare('SELECT signature FROM audit_checkpoints ORDER BY at_sequence LIMIT 1').get() as { signature: string }).signature;
  db.prepare(
    "UPDATE audit_checkpoints SET signature = 'AAAA' || substr(signature, 5)",
  ).run();

  const sigTampered = verifyAuditChain(db, 0, 100, signingKey);
  assert.equal(
    sigTampered.chainValid,
    false,
    'a forged checkpoint signature MUST make chainValid false even with every entry linked (RFC 0218 §C)',
  );
  assert.equal(
    sigTampered.checkpointsValid,
    false,
    'forged checkpoint signature MUST flip checkpointsValid to false',
  );
  const sigInvalid = sigTampered.anomalies.find((a) => a.kind === 'signature-invalid');
  assert.ok(
    sigInvalid !== undefined,
    `expected signature-invalid anomaly, got: ${JSON.stringify(sigTampered.anomalies)}`,
  );
  assert.deepEqual(
    sigTampered.anomalies.map((a) => a.kind),
    ['signature-invalid'],
    'only the signature was forged, so it is the only anomaly',
  );
  assertSchemaShaped(sigTampered.anomalies, sigTampered.chainValid);

  // TAMPER 3: restore the signature and delete a middle entry. The gap is a
  // missing-entry, the entry after it no longer links, and the checkpoint's
  // root no longer recomputes.
  db.prepare("UPDATE audit_checkpoints SET signature = ? ").run(originalSig);
  db.prepare('DELETE FROM audit_log WHERE seq = 2').run();
  const deleted = verifyAuditChain(db, 0, 100, signingKey);
  assert.deepEqual(
    deleted.anomalies.map((a) => `${a.kind}@${a.atSeq}`).sort(),
    ['chain-break@3', 'merkle-mismatch@5', 'missing-entry@2'],
    `a deleted entry: ${JSON.stringify(deleted.anomalies)}`,
  );
  assertSchemaShaped(deleted.anomalies, deleted.chainValid);

  db.close();

  // Separate phase: storage-layer trigger check. Open a fresh DB
  // WITHOUT the bypass env so the append-only triggers install.
  delete process.env.OPENWOP_AUDIT_ALLOW_TAMPER;
  const dbProd = new Database(join(workdir, 'audit-prod.sqlite'));
  dbProd.pragma('journal_mode = WAL');
  setupAuditSchema(dbProd);
  logAudit(dbProd, { actor: 'test', action: 'host.started', target: 'p', details: {} });

  let updateRejected = false;
  try {
    dbProd.prepare("UPDATE audit_log SET details_json = '{}' WHERE seq = 1").run();
  } catch (err) {
    updateRejected = (err as Error).message.includes('append-only');
  }
  assert.ok(updateRejected, 'audit_log_no_update trigger MUST reject in-place UPDATEs');

  let deleteRejected = false;
  try {
    dbProd.prepare('DELETE FROM audit_log WHERE seq = 1').run();
  } catch (err) {
    deleteRejected = (err as Error).message.includes('append-only');
  }
  assert.ok(deleteRejected, 'audit_log_no_delete trigger MUST reject DELETEs');

  dbProd.close();
  console.log('audit-tamper test: PASS');
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
