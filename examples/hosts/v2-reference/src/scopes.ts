/**
 * RFC 0200 §A.3 / §B.1 — the scopes this host enforces, and which operation needs which.
 *
 * `spec/v1/auth.md` §Scopes has always said a server "MUST enforce scope checks at the
 * endpoint level, not at the resource level — i.e. `runs:cancel` does not imply
 * `runs:read`", and until RFC 0200 this host enforced none of it: every credential was
 * full-privilege within its tenant. That made two things impossible at once — an honest
 * `scopes_supported` in the protected-resource metadata (a host that enforces no scope has
 * nothing to list) and any `403` with `error="insufficient_scope"` to challenge.
 *
 * The table below is the whole scope model. It is keyed by the LITERAL route pattern
 * `route()` is called with, so a route and its scope cannot drift apart silently: the
 * router refuses to boot when an authenticated route has no row here and is not one of the
 * exempt mounts below (`assertScopeTableComplete`).
 *
 * Exempt from the table, deliberately:
 *   - the conformance seams (`/conformance/seams/…`), which are a test surface, not a
 *     protocol operation with a `rest-endpoints.md` row;
 *   - the A2A and MCP mounts, where `mcp-integration.md` §E and `a2a-integration.md` put
 *     authorization at the OpenWOP boundary the mount crosses, per operation, rather than
 *     on the mount itself — no scope is specified for the mount and inventing one here
 *     would be a claim the corpus does not make;
 *   - the interrupt-token pages (`api/openapi.yaml`: "token is the auth").
 */

/** The scope vocabulary this host enforces — every distinct value of the table below. */
export function scopesEnforced(): readonly string[] {
  return [...new Set(Object.values(SCOPE_BY_ROUTE))].sort();
}

/** `${METHOD} ${pattern}` → the ONE scope that operation requires (`rest-endpoints.md` col 4). */
const SCOPE_BY_ROUTE: Readonly<Record<string, string>> = {
  'GET /workflows/{workflowId}': 'manifest:read',
  'POST /runs': 'runs:create',
  'POST /v1/runs': 'runs:create',
  'GET /runs': 'runs:read',
  'GET /runs/{runId}': 'runs:read',
  'GET /v1/runs/{runId}': 'runs:read',
  'GET /runs/{runId}/events': 'runs:read',
  'GET /v1/runs/{runId}/events': 'runs:read',
  'GET /runs/{runId}/events/poll': 'runs:read',
  'GET /v1/runs/{runId}/events/poll': 'runs:read',
  'GET /runs/{runId}/events/debug': 'runs:read',
  'GET /runs/{runId}/ancestry': 'runs:read',
  'GET /runs/{runId}/annotations': 'runs:read',
  'POST /runs/{runId}/annotations': 'runs:annotate',
  'GET /runs/{runId}/artifacts/{artifactId}': 'artifacts:read',
  'GET /v1/runs/{runId}/artifacts/{artifactId}': 'artifacts:read',
  'GET /runs/{runId}/compensation': 'runs:read',
  'GET /runs/{runId}/effects': 'runs:read',
  'GET /runs/{runId}/interrupts/{nodeId}': 'runs:read',
  'POST /runs/{runId}/interrupts/{nodeId}': 'approvals:respond',
  'POST /runs/{runId}/cancel': 'runs:cancel',
  'POST /v1/runs/{runId}/cancel': 'runs:cancel',
  'POST /runs:bulk-cancel': 'runs:cancel',
  'POST /runs/{runId}:pause': 'runs:cancel',
  'POST /runs/{runId}:resume': 'runs:cancel',
  'POST /runs/{runId}:fork': 'runs:create',
  'GET /agents': 'runs:read',
  'GET /agents/{agentId}': 'runs:read',
  'GET /tools': 'runs:read',
  'GET /tools/{toolId}': 'runs:read',
  'GET /packs': 'runs:read',
  'POST /webhooks': 'webhooks:manage',
  'POST /v1/webhooks': 'webhooks:manage',
  'DELETE /webhooks/{webhookId}': 'webhooks:manage',
  'DELETE /v1/webhooks/{webhookId}': 'webhooks:manage',
  'POST /webhooks/{webhookId}/rotate-secret': 'webhooks:manage',
  'POST /v1/webhooks/{webhookId}/rotate-secret': 'webhooks:manage',
  'GET /webhooks/{webhookId}/dead-letters': 'webhooks:manage',
  'GET /host/effect-seams': 'runs:read',
  'GET /host/events': 'runs:read',
};

/** Route patterns that carry no scope requirement — see the header for why each is exempt. */
const SCOPE_EXEMPT = [
  /^\/conformance\/seams\//,
  /^\/a2a(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/interrupt-pages\//,
  /^\/oauth\//,
  /^\/host\/durability\//,
];

export function scopeForRoute(method: string, pattern: string): string | null {
  const direct = SCOPE_BY_ROUTE[`${method} ${pattern}`];
  if (direct !== undefined) return direct;
  if (SCOPE_EXEMPT.some((re) => re.test(pattern))) return null;
  throw new Error(`RFC 0200: the authenticated route ${method} ${pattern} has no scope row in src/scopes.ts and is not exempt — add one, or the protected-resource metadata's scopes_supported is a claim the host does not honour`);
}

/**
 * The scopes a credential holds. Every credential is full-privilege except the one
 * `OPENWOP_LOW_SCOPE_API_KEY` names: that key exists so the suite can provoke a real
 * `403 insufficient_scope` and read the challenge, without any other scenario's key
 * changing behaviour.
 */
export function scopesOfCredential(all: readonly string[], low: readonly string[], isLowScope: boolean): ReadonlySet<string> {
  return new Set(isLowScope ? low : all);
}
