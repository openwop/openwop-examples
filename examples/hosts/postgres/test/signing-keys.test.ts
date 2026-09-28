/**
 * RFC 0168 §E.2 — the v1 discovery root carries a well-formed
 * `signingKeys[]` entry for `postgres-reference-1`.
 *
 * A certification bundle is v3 regardless of major, so a bundle this host's
 * cut script signs at `--target-major 1` is attributable only if a verifier
 * can resolve its `signature.keyId` HERE (conformance
 * `v2-bundle-signature-attributable`). Asserts the shape the capabilities
 * schema pins (keyId pattern, alg const, 43-char base64url raw key, closed
 * `use`), that the key imports as a real Ed25519 point, that it is the key in
 * the committed `keys/host.pub.pem`, and that a signature made by the matching
 * private half verifies under the PUBLISHED value (round-trip with a throwaway
 * pair is impossible here — the real private half is outside the repo — so
 * the last leg runs only when OPENWOP_BUNDLE_SIGNING_KEY names it).
 *
 * @see spec/v1/capabilities.md §signingKeys
 * @see schemas/capabilities.schema.json §signingKeys
 */
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const workdir = mkdtempSync(join(tmpdir(), 'openwop-pg-signing-keys-'));
process.env.OPENWOP_AUDIT_KEY_DIR = workdir;

import { setQuerier, start } from '../src/server.js';
import { SIGNING_PUBLIC_KEY_PATH } from '../src/signing-keys.js';
import type { Querier, QueryResult } from '../src/db.js';

function pgliteQuerier(db: PGlite): Querier {
  return {
    async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult<T>> {
      const res = await db.query<T>(sql, params as unknown[]);
      return { rows: res.rows, rowCount: res.affectedRows };
    },
  };
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

async function main(): Promise<void> {
  const db = new PGlite('memory://');
  setQuerier(pgliteQuerier(db));
  const { close } = await start();
  try {
    const port = process.env.OPENWOP_PORT ?? '3839';
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/openwop`);
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { protocolVersion?: string; signingKeys?: unknown };
    assert.equal(doc.protocolVersion, '1.0', 'this is the v1 root');

    assert.ok(Array.isArray(doc.signingKeys), 'v1 discovery root MUST carry signingKeys[] (RFC 0168 §E.2)');
    const keys = doc.signingKeys as Array<Record<string, unknown>>;
    const ids = keys.map((k) => k['keyId']);
    assert.equal(new Set(ids).size, ids.length, 'keyId is unique within signingKeys[]');
    const entry = keys.find((k) => k['keyId'] === 'postgres-reference-1');
    assert.ok(entry, 'signingKeys[] carries postgres-reference-1');

    // Closed item shape per capabilities.schema.json §signingKeys.
    const allowed = new Set(['keyId', 'alg', 'publicKey', 'use', 'retiredAt']);
    for (const k of Object.keys(entry)) assert.ok(allowed.has(k), `unexpected member ${k}`);
    assert.match(String(entry['keyId']), /^[A-Za-z0-9._~-]{1,128}$/);
    assert.equal(entry['alg'], 'ed25519');
    assert.equal(entry['use'], 'certification-bundle');
    assert.equal(entry['retiredAt'], undefined, 'the signing key is live, not retired');
    const pub = String(entry['publicKey']);
    assert.match(pub, /^[A-Za-z0-9_-]{43}$/, 'publicKey is raw 32 bytes, base64url unpadded — not PEM');

    // It imports as a real Ed25519 point, and it is the committed key.
    const raw = Buffer.from(pub, 'base64url');
    assert.equal(raw.length, 32);
    const published = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
    assert.equal(published.asymmetricKeyType, 'ed25519');
    const committed = createPublicKey(readFileSync(SIGNING_PUBLIC_KEY_PATH, 'utf8'));
    assert.ok(
      published.export({ type: 'spki', format: 'der' }).equals(committed.export({ type: 'spki', format: 'der' })),
      'published key equals keys/host.pub.pem',
    );

    // Optional: the private half (outside the repo) signs what the published key verifies.
    const privPath = process.env.OPENWOP_BUNDLE_SIGNING_KEY;
    if (privPath && existsSync(privPath)) {
      const msg = Buffer.from('postgres-reference-1 attribution probe');
      const sig = sign(null, msg, createPrivateKey(readFileSync(privPath, 'utf8')));
      assert.ok(verify(null, msg, published, sig), 'the private half pairs with the published key');
      console.log('  private half pairs with the published key');
    }
    console.log('signing-keys: PASS');
  } finally {
    await close();
    await db.close();
    rmSync(workdir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
