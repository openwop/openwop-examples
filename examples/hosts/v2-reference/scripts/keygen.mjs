#!/usr/bin/env node
/**
 * Generate the host's Ed25519 bundle-signing keypair (conformance.md §Bundle v3):
 *   keys/host.pem      PKCS8 private key — gitignored, never committed
 *   keys/host.pub.pem  SPKI public key  — committed beside the bundle
 * The key id the host publishes for it is `v2-reference-1` (ids.schema.json keyId).
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'keys');
mkdirSync(dir, { recursive: true });
const priv = join(dir, 'host.pem');
const pub = join(dir, 'host.pub.pem');
if (existsSync(priv) && !process.argv.includes('--force')) {
  process.stderr.write(`${priv} exists; pass --force to rotate (and re-sign the bundle under a new key id)\n`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
process.stdout.write(`wrote ${priv} (private, gitignored) and ${pub} (public)\n`);
