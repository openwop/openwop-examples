/**
 * identity.md §2.1–§2.2 for the `oidc` lane, and RFC 0200 §D.
 *
 * The host trusts exactly one OIDC issuer, named by `OPENWOP_OIDC_ISSUER_URL`, and only
 * when the operator configures one: an advertised lane is a trust root the host really
 * verifies against, never a shape it cannot honour. The pipeline is the one §2.1 states —
 * verify the signature against the lane's trust root (the issuer's JWKS), bind the
 * verified identity to the request (the token was presented ON it), check audience,
 * resolve to a Subject, fail closed.
 *
 * RFC 0200 §D is the audience clause: an ID token MAY be the bearer only when its `aud`
 * equals the host's configured audience. That is what keeps a Firebase-style deployment
 * conforming — a project's own ID token passes — while an ID token minted for some other
 * relying party at the same IdP is `audience_mismatch`, which is the substitution attack
 * `SECURITY/threat-model-auth-profiles.md` A2 names.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { err } from './errors.js';
import { guardedRequest } from './egress.js';
import type { Host, Subject } from './host.js';

/** A compact JWS: three base64url segments. Anything else is not a token for this lane. */
export const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface Jwk { kty?: string; kid?: string; alg?: string; n?: string; e?: string; x?: string; y?: string; crv?: string }

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const JWKS_TTL_MS = 60_000;

async function jwks(host: Host, issuer: string): Promise<Jwk[]> {
  const hit = jwksCache.get(issuer);
  if (hit !== undefined && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  const res = await guardedRequest(new URL(`${issuer}/.well-known/jwks.json`), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: 5000,
    // The lane's trust root is an operator-configured URL, and in conformance it is the
    // suite's loopback issuer. This is the same relaxation the OAuth client already takes
    // for its own metadata fetches, under its own flag.
    allowPrivate: host.config.oauthAllowPrivate || host.config.webhookAllowPrivate,
  });
  if (res.status !== 200) throw err('identity_unverified', `the ${issuer} JWKS could not be fetched (${res.status})`);
  let parsed: { keys?: Jwk[] };
  try { parsed = JSON.parse(res.body) as { keys?: Jwk[] }; } catch { throw err('identity_unverified', 'the lane trust root served a JWKS that is not JSON'); }
  const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
  jwksCache.set(issuer, { at: Date.now(), keys });
  return keys;
}

function keyOf(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as never, format: 'jwk' });
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const VERIFY_ALG: Readonly<Record<string, { hash: string; dsa?: 'ieee-p1363' }>> = {
  RS256: { hash: 'RSA-SHA256' },
  ES256: { hash: 'sha256', dsa: 'ieee-p1363' },
};

/**
 * Resolve a JWT bearer on the `oidc` lane, or fail closed. The caller has already
 * established that the host advertises the lane.
 */
export async function verifyOidcBearer(host: Host, token: string): Promise<Subject> {
  const issuer = host.config.oidcIssuerUrl;
  if (issuer === null) throw err('unauthenticated', 'the credential does not verify against any lane trust root');
  const parts = token.split('.');
  if (parts.length !== 3) throw err('identity_unverified', 'the bearer is not a compact JWS');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0] as string);
    claims = decodeSegment(parts[1] as string);
  } catch { throw err('identity_unverified', 'the bearer is not a decodable JWS'); }

  const alg = String(header['alg'] ?? '');
  const spec = VERIFY_ALG[alg];
  // `alg: none` and an unlisted algorithm are refused before any key is chosen.
  if (spec === undefined) throw err('identity_unverified', `the oidc lane accepts ${Object.keys(VERIFY_ALG).join(', ')}; the token declares ${alg || 'no alg'}`);

  const candidates = (await jwks(host, issuer)).filter((k) => header['kid'] === undefined || k.kid === undefined || k.kid === header['kid']);
  if (candidates.length === 0) throw err('identity_unverified', 'no key in the issuer JWKS matches the token kid');
  const signed = `${parts[0]}.${parts[1]}`;
  const sig = Buffer.from(parts[2] as string, 'base64url');
  const verified = candidates.some((jwk) => {
    try {
      const v = createVerify(spec.hash);
      v.update(signed);
      v.end();
      return spec.dsa === undefined
        ? v.verify(keyOf(jwk), sig)
        : v.verify({ key: keyOf(jwk), dsaEncoding: 'ieee-p1363' }, sig);
    } catch { return false; }
  });
  if (!verified) throw err('identity_unverified', 'the token signature does not verify against the lane trust root');

  if (String(claims['iss'] ?? '').replace(/\/$/, '') !== issuer) throw err('identity_unverified', 'the token `iss` is not this lane trust root');
  const exp = typeof claims['exp'] === 'number' ? claims['exp'] : 0;
  if (exp * 1000 <= Date.now()) throw err('identity_unverified', 'the token is expired');

  // RFC 0200 §D / identity.md §2.1 — check audience. An ID token is admissible here only
  // because its `aud` IS this host's configured audience; any other `aud` is refused,
  // including one minted for another client of the same IdP.
  const audRaw = claims['aud'];
  const aud = Array.isArray(audRaw) ? audRaw.map(String) : typeof audRaw === 'string' ? [audRaw] : [];
  if (!aud.includes(host.config.oidcAudience)) {
    throw err('audience_mismatch', `the credential audience is not this host (aud=${aud.join(',') || 'absent'}, expected ${host.config.oidcAudience})`);
  }

  const sub = String(claims['sub'] ?? '');
  if (sub === '') throw err('identity_unresolvable', 'the verified token carries no `sub` to resolve');
  return { issuer, subjectId: sub, tenant: host.config.tenant, lane: 'oidc', kind: 'user' };
}
