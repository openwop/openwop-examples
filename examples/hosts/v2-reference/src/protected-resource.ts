/**
 * RFC 0200 §A–§B — this host as an OAuth protected resource.
 *
 * §A: the metadata is a PROJECTION of `auth.lanes[]`, never a second declaration. Every
 * field below is read off the discovery document the host already serves, so the two
 * cannot drift: adding an issuer to the lane adds it here, and nothing else can.
 *
 * §B: the challenge. `WWW-Authenticate` is attached to a response that is ALREADY 401 or
 * 403 — it never changes a status. That is the whole of the anti-oracle rule
 * (`auth-challenge-no-oracle`): the `404` `tool-catalog.md`, the RFC 0074 inventory and
 * `capabilities-change-detection.md` require for an unknown OR unauthorized resource stays
 * a `404` and carries nothing, and a `403` that failed RESOURCE binding (`run_forbidden`,
 * `id_tenant_mismatch`) carries no `insufficient_scope`, because no scope would cure it.
 *
 * This host is mounted at the root, so the well-known URI RFC 9728 §3 forms from its
 * resource identifier has no path inserted. A host serving the API under `/api` would
 * serve `/.well-known/oauth-protected-resource/api` instead (§3.1); the resource
 * identifier is what `resource` echoes either way.
 */
import { v2Document } from './discovery.js';
import { scopesEnforced } from './scopes.js';
import type { Host } from './host.js';

export const PRM_PATH = '/.well-known/oauth-protected-resource';

interface Lane { lane?: unknown; issuers?: unknown; minimumAssurance?: unknown; delegationProofs?: unknown }

function oauthLanes(host: Host, baseUrl: string): Lane[] {
  const auth = (v2Document(host, baseUrl) as { auth?: { lanes?: unknown } }).auth;
  const lanes = Array.isArray(auth?.lanes) ? (auth.lanes as Lane[]) : [];
  return lanes.filter((l) => l.lane === 'oauth2' || l.lane === 'oidc');
}

/** Does §A.1 bind this host — i.e. does it advertise an `oauth2` or `oidc` lane? */
export function boundByPrm(host: Host, baseUrl: string): boolean {
  return oauthLanes(host, baseUrl).length > 0;
}

/**
 * The RFC 9728 document. §A.1 makes it a MUST on a host with an oauth2/oidc lane and
 * RECOMMENDS it otherwise where it can be derived truthfully — this host serves it
 * always, because it can: `authorization_servers` is simply empty when no such lane is
 * advertised, which is the truthful projection rather than a 404.
 */
export function prmDocument(host: Host, baseUrl: string): Record<string, unknown> {
  const lanes = oauthLanes(host, baseUrl);
  const servers = [...new Set(lanes.flatMap((l) => (Array.isArray(l.issuers) ? l.issuers.map(String) : [])).filter((i) => /^https?:\/\//.test(i)))];
  const scopes = scopesEnforced();
  const doc: Record<string, unknown> = {
    resource: baseUrl,
    bearer_methods_supported: ['header'],
  };
  if (servers.length > 0) doc['authorization_servers'] = servers;
  if (scopes.length > 0) doc['scopes_supported'] = [...scopes];
  // §A.3: a binding claim MAY be true only where EVERY such lane requires it. This host's
  // oidc lane is `bearer`, so neither is ever claimed — a bearer lane advertised as
  // sender-constrained is the `sender-constraint-no-bearer-downgrade` violation.
  const everyLaneSenderConstrained = lanes.length > 0 && lanes.every((l) => l.minimumAssurance === 'sender-constrained' || l.minimumAssurance === 'key-bound');
  const proofs = new Set(lanes.flatMap((l) => (Array.isArray(l.delegationProofs) ? l.delegationProofs.map(String) : [])));
  if (everyLaneSenderConstrained && proofs.has('dpop')) doc['dpop_bound_access_tokens_required'] = true;
  if (everyLaneSenderConstrained && proofs.has('mtls-key-binding')) doc['tls_client_certificate_bound_access_tokens'] = true;
  doc['resource_documentation'] = 'https://openwop.dev/spec/v2/core/identity/';
  return doc;
}

/**
 * The §B.1 challenge for a refusal, or null where none is owed. `credentialPresented`
 * distinguishes the two 401 forms RFC 6750 §3.1 separates: an error code is added only
 * when a credential was presented and refused, never when none was.
 */
export function challengeFor(
  host: Host,
  baseUrl: string,
  status: number,
  code: string,
  scopeRequired: string | null,
  credentialPresented: boolean,
): string | null {
  // §B.3, the whole anti-oracle rule: only an already-401/403 response is challenged.
  if (status !== 401 && status !== 403) return null;
  if (!boundByPrm(host, baseUrl)) {
    // §B.2 — every other host SHOULD still challenge a 401, and MAY add the parameters.
    return status === 401 ? 'Bearer' : null;
  }
  const rm = `resource_metadata="${baseUrl}${PRM_PATH}"`;
  if (status === 401) {
    const invalid = credentialPresented || code === 'key_expired' || code === 'key_revoked' || code === 'credential_revoked';
    return invalid ? `Bearer error="invalid_token", ${rm}` : `Bearer ${rm}`;
  }
  // A 403 carries `insufficient_scope` ONLY when a scope would cure it. A resource-binding
  // refusal (run_forbidden, id_tenant_mismatch, delegation_scope_amplified) reaches here
  // with scopeRequired === null and gets the bare challenge.
  if (scopeRequired === null) return `Bearer ${rm}`;
  return `Bearer error="insufficient_scope", scope="${scopeRequired}", ${rm}`;
}
