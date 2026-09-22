/**
 * identity.md — the Subject is the owner; every lane is one binding pipeline
 * (verify → bind → audience → resolve → fail closed).
 *
 * Lanes this host advertises:
 *   api-key   trust root `urn:<host>:api-key`; revocation next-request
 *   session   trust root `urn:<host>:session`; revocation next-request
 *   workload  trust root = the configured SPIFFE trust domains; key-bound floor;
 *             delegation-expiry; resolved through the §20 seam (seam-gated witness)
 *   oidc      trust root = OPENWOP_OIDC_ISSUER_URL, when the operator configures one
 *             (RFC 0200); a compact-JWS bearer is verified against its JWKS, its `aud`
 *             MUST equal the configured audience (§D), and the lane is advertised only
 *             while the issuer is configured
 *
 * A credential is bound to the request by being presented on it, never by an
 * asserted header; a revoked credential is refused on the very next request
 * with 401 credential_revoked.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { API_KEY_ISSUER, SESSION_ISSUER } from './config.js';
import { err } from './errors.js';
import { nowIso, opaque } from './ids.js';
import { JWT_SHAPE, verifyOidcBearer } from './oidc-lane.js';
import { scopesEnforced, scopesOfCredential } from './scopes.js';
import type { Host, Subject } from './host.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] as string).trim() : null;
}

export function ensureDefaultCredential(host: Host): void {
  const hash = sha256(host.config.apiKey);
  if (host.store.credentialByHash(hash) === undefined) {
    host.store.insertCredential({ id: 'default', secret_hash: hash, tenant: host.config.tenant, lane: 'api-key', subject_id: 'default', created_at: nowIso(), revoked_at: null });
  }
  // OPENWOP_TENANT_B_API_KEY: a second api-key credential bound to a SECOND
  // tenant, so the cross-tenant legs (isolation, ListTasks scoping, per-caller
  // cache scope) have a real other caller rather than a soft-skip.
  // RFC 0200 §B.1 — a real credential that holds only `lowScopeScopes`, so the
  // insufficient_scope challenge has a caller that can provoke it on the wire.
  const low = host.config.lowScopeApiKey;
  if (low !== null && low !== host.config.apiKey) {
    const lowHash = sha256(low);
    if (host.store.credentialByHash(lowHash) === undefined) {
      host.store.insertCredential({ id: 'low-scope', secret_hash: lowHash, tenant: host.config.tenant, lane: 'api-key', subject_id: 'low-scope', created_at: nowIso(), revoked_at: null });
    }
  }
  const b = host.config.tenantBApiKey;
  if (b !== null && b !== host.config.apiKey) {
    if (host.config.tenantB === host.config.tenant) throw new Error('OPENWOP_TENANT_B MUST differ from OPENWOP_TENANT: the second credential exists to be another tenant');
    const bHash = sha256(b);
    if (host.store.credentialByHash(bHash) === undefined) {
      host.store.insertCredential({ id: 'tenant-b', secret_hash: bHash, tenant: host.config.tenantB, lane: 'api-key', subject_id: 'tenant-b', created_at: nowIso(), revoked_at: null });
    }
  }
}

/**
 * identity.md §2 — resolve the presented credential to a Subject or fail closed, and
 * report the scopes it holds (RFC 0200 §B.1: `runs:cancel` does not imply `runs:read`,
 * so the scope set travels with the Subject and the router checks it per operation).
 */
export async function authenticate(host: Host, req: IncomingMessage): Promise<{ subject: Subject; scopes: ReadonlySet<string> }> {
  const token = bearerOf(req);
  if (token === null) throw err('unauthenticated', 'Authorization: Bearer <credential> is required');
  // RFC 0200: a compact JWS is a claim on the `oidc` lane, and is only ever tried there.
  // An unconfigured lane means no JWT verifies — a bearer that is not a stored credential
  // is refused with the same 401 as before, never with a hint that a lane exists.
  if (host.config.oidcIssuerUrl !== null && JWT_SHAPE.test(token)) {
    return { subject: await verifyOidcBearer(host, token), scopes: scopesOfCredential(ALL_SCOPES(), host.config.lowScopeScopes, false) };
  }
  const hash = sha256(token);
  const row = host.store.credentialByHash(hash);
  if (row === undefined) throw err('unauthenticated', 'the credential does not verify against any lane trust root');
  // constant-time confirmation of the hash match (the lookup is by hash; compare the bytes once more)
  if (!timingSafeEqual(Buffer.from(row.secret_hash), Buffer.from(hash))) throw err('unauthenticated', 'credential mismatch');
  if (row.revoked_at !== null) throw err('credential_revoked', `the ${row.lane} credential was revoked at ${row.revoked_at}`);
  const lane = row.lane === 'session' ? 'session' : 'api-key';
  const subject: Subject = { issuer: lane === 'session' ? SESSION_ISSUER : API_KEY_ISSUER, subjectId: row.subject_id, tenant: row.tenant, lane, kind: 'user' };
  const low = host.config.lowScopeApiKey !== null && host.config.lowScopeApiKey !== host.config.apiKey && sha256(host.config.lowScopeApiKey) === hash;
  return { subject, scopes: scopesOfCredential(ALL_SCOPES(), host.config.lowScopeScopes, low) };
}

/** The full scope vocabulary this host enforces — what a normal credential holds. */
function ALL_SCOPES(): readonly string[] { return scopesEnforced(); }

export function principalRef(subject: Subject): string {
  return `${subject.issuer}#${subject.subjectId}`;
}

/** The seam mint: a fresh next-request credential for `lane` (api-key | session). */
export function mintCredential(host: Host, lane: string, tenant: string): { credential: string; subjectId: string } {
  if (lane !== 'api-key' && lane !== 'session') throw err('validation_error', `lane ${lane} is not a next-request lane this host mints`, { lane });
  const prefix = lane === 'session' ? 'ow2s_' : 'ow2k_';
  const credential = `${prefix}${randomBytes(24).toString('base64url')}`;
  const subjectId = `${lane}-${opaque()}`;
  host.store.insertCredential({ id: subjectId, secret_hash: sha256(credential), tenant, lane, subject_id: subjectId, created_at: nowIso(), revoked_at: null });
  return { credential, subjectId };
}

export function revokeCredential(host: Host, credential: string): boolean {
  return host.store.revokeCredential(sha256(credential));
}

export interface WorkloadIdentity {
  scheme?: unknown;
  subject?: unknown;
  issuer?: unknown;
  audience?: unknown;
  keyBinding?: unknown;
  delegation?: unknown;
}

/**
 * identity.md §2.2–§2.4 for the `workload` lane, driven by the §20 seam: verify
 * the trust root, check audience, enforce the advertised `key-bound` floor
 * (sender_constraint_missing), honour delegation expiry and chain bounds, and
 * record the assurance actually used.
 */
export function resolveWorkloadIdentity(host: Host, identity: WorkloadIdentity, expectedAudience: string | undefined): { principalId: string; resolved: true; assurance: 'key-bound' | 'sender-constrained' | 'bearer' } {
  if (identity === null || typeof identity !== 'object') throw err('validation_error', 'identity MUST be a WorkloadIdentity object');
  const issuer = typeof identity.issuer === 'string' ? identity.issuer : '';
  const subject = typeof identity.subject === 'string' ? identity.subject : '';
  if (identity.scheme !== 'spiffe' && identity.scheme !== 'x509-svid' && identity.scheme !== 'jwt-svid') throw err('identity_unverified', `scheme ${String(identity.scheme)} has no trust root on this host`);
  if (!host.config.workloadTrustRoots.some((root) => issuer === root || subject.startsWith(`${root.replace(/\/$/, '')}/`))) {
    throw err('identity_unverified', 'the workload issuer is not a configured trust root');
  }
  if (typeof identity.audience === 'string' && expectedAudience !== undefined && identity.audience !== expectedAudience) throw err('audience_mismatch', 'the credential audience is not this host');
  const delegation = identity.delegation as { expiresAt?: unknown; chain?: Array<{ subject?: unknown; scopes?: unknown }> } | undefined;
  if (delegation && typeof delegation === 'object') {
    if (typeof delegation.expiresAt === 'string' && Date.parse(delegation.expiresAt) < Date.now()) throw err('delegation_expired', 'the delegation is past its lifetime');
    const chain = Array.isArray(delegation.chain) ? delegation.chain : [];
    if (chain.length > 4) throw err('delegation_chain_too_long', 'the actor chain exceeds depth 4');
    const seen = new Set<string>();
    let prev: Set<string> | null = null;
    for (const hop of chain) {
      const s = String(hop.subject ?? '');
      if (seen.has(s)) throw err('delegation_chain_cyclic', 'the actor chain repeats a subject');
      seen.add(s);
      const scopes = new Set(Array.isArray(hop.scopes) ? hop.scopes.map(String) : []);
      if (prev !== null && [...scopes].some((sc) => !prev!.has(sc))) throw err('delegation_scope_amplified', 'a delegated link claims more scope than its delegator');
      prev = scopes;
    }
  }
  // The advertised floor is key-bound: a presentation without a key binding is below it.
  const binding = identity.keyBinding as { method?: unknown } | undefined;
  if (binding === undefined || binding === null || typeof binding !== 'object') throw err('sender_constraint_missing', 'the workload lane floor is key-bound; the identity was presented without a key binding');
  const assurance: 'key-bound' | 'sender-constrained' = binding.method === 'mtls' ? 'key-bound' : 'sender-constrained';
  if (assurance !== 'key-bound') throw err('sender_constraint_missing', `the workload lane floor is key-bound; ${String(binding.method)} binding is ${assurance}`);
  return { principalId: `workload:${sha256(`${issuer}|${subject}`).slice(0, 32)}`, resolved: true, assurance };
}
