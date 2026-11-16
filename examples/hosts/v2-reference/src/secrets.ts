/**
 * host-services.md §`secrets` — the host's own secret store, as far as this
 * reference host keeps one: the suite's store canary
 * `openwop-conformance-canary-secret` (fixtures.md §`openwop-smoke-byok-roundtrip`).
 *
 * The value is the operator's `OPENWOP_CANARY_SECRET_VALUE` when set (so the
 * suite's value detector can look for the plaintext as well as its digest), else
 * 32 random bytes drawn at boot. It lives in this process only: it is never
 * written to the store, a log, an event or a span. `conformance.secret.echo`
 * surfaces only `{secretSha256, secretLength}`, and a replay re-resolves it
 * (§`secrets`: "A replay re-resolves it").
 */
import { createHash, randomBytes } from 'node:crypto';

export const CANARY_SECRET_ID = 'openwop-conformance-canary-secret';
export const SECRET_ECHO_TYPE = 'conformance.secret.echo';

const canary = Buffer.from(process.env['OPENWOP_CANARY_SECRET_VALUE'] || randomBytes(32).toString('base64url'), 'utf8');

/** The resolved secret's bytes, or null for an id this store does not hold. */
export function resolveSecret(secretId: unknown): Buffer | null {
  return secretId === CANARY_SECRET_ID ? Buffer.from(canary) : null;
}

/** What `conformance.secret.echo` outputs: the digest and length, never the value. */
export function secretEcho(secretId: unknown): { secretSha256: string; secretLength: number } | null {
  const v = resolveSecret(secretId);
  if (v === null) return null;
  const out = { secretSha256: createHash('sha256').update(v).digest('hex'), secretLength: v.length };
  v.fill(0);
  return out;
}
