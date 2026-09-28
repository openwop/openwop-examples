#!/usr/bin/env node
/**
 * Generate the Postgres host's Ed25519 certification-bundle signing keypair
 * (RFC 0168 §E.2; spec/v2/core/conformance.md §Bundle v3):
 *
 *   ~/.openwop-keys/<keyId>.host.pem   PKCS8 private key, mode 0600 — OUTSIDE the repo
 *   keys/host.pub.pem                  SPKI public key — committed; discovery derives
 *                                      its `signingKeys[].publicKey` from this file
 *
 *   node scripts/keygen.mjs [--key-id postgres-reference-1] [--force]
 *
 * The private half never enters the repository or a worktree: the v2 reference
 * host lost three keys that lived only in a (later deleted) worktree, and had to
 * rotate each time. Rotating here means a NEW key id — update
 * BUNDLE_SIGNING_KEY_ID in src/signing-keys.ts, and keep the old key listed with
 * `retiredAt` so the bundles it signed stay verifiable.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const i = argv.indexOf('--key-id');
const keyId = i >= 0 ? argv[i + 1] : 'postgres-reference-1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const privDir = process.env.OPENWOP_KEYS_DIR ?? join(homedir(), '.openwop-keys');
const priv = join(privDir, `${keyId}.host.pem`);
const pub = join(root, 'keys', 'host.pub.pem');
if (existsSync(priv) && !argv.includes('--force')) {
  process.stderr.write(`${priv} exists; pass --force only if you mean to destroy it (rotate under a NEW key id instead)\n`);
  process.exit(1);
}
mkdirSync(privDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(pub), { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
process.stdout.write(`wrote ${priv} (private, 0600, outside the repo) and ${pub} (public)\n`);
