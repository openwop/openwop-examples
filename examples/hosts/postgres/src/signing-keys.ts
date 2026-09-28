/**
 * RFC 0168 §E.2 — the keys this host signs certification bundles with.
 *
 * A certification bundle is v3 regardless of major, and a v3 bundle's
 * signature names a `keyId` that a verifier resolves in the host's discovery
 * document. This host serves only the v1 root, so `signingKeys[]` lives there
 * (spec/v1/capabilities.md; capabilities.schema.json §signingKeys). Without it
 * the signature attests integrity only and attributes to nobody.
 *
 * The public key is DERIVED from `keys/host.pub.pem` — the same file keygen
 * wrote beside the private half — rather than pasted in as a constant, so the
 * published value can only be wrong if the key itself is. The private half is
 * `~/.openwop-keys/postgres-reference-1.host.pem` and never enters the repo.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_SIGNING_KEY_ID = 'postgres-reference-1';
export const SIGNING_PUBLIC_KEY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'keys', 'host.pub.pem');

export interface SigningKey {
  readonly keyId: string;
  readonly alg: 'ed25519';
  readonly publicKey: string;
  readonly use: 'certification-bundle';
  readonly retiredAt?: string;
}

/** Raw 32-byte Ed25519 point, base64url unpadded (43 chars) — NOT PEM. */
function publicKeyB64u(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64url');
}

let cached: ReadonlyArray<SigningKey> | null = null;

/** The `signingKeys[]` discovery member. Read once; the key file does not change under a running host. */
export function signingKeys(): ReadonlyArray<SigningKey> {
  if (cached === null) {
    cached = Object.freeze([
      Object.freeze({
        keyId: BUNDLE_SIGNING_KEY_ID,
        alg: 'ed25519' as const,
        publicKey: publicKeyB64u(readFileSync(SIGNING_PUBLIC_KEY_PATH, 'utf8')),
        use: 'certification-bundle' as const,
      }),
    ]);
  }
  return cached;
}
