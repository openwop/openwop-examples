/**
 * RFC 0199 — the host as an OAuth 2.0 authorization-code CLIENT
 * (`spec/v2/core/oauth.md`), and the `credential` interrupt.
 *
 * ONE authorization-URL builder, `beginGrant`, is used by every path that
 * starts a grant: a credential interrupt's `connectUrl`, and the conformance
 * seam `authorize-start` (which only points a provider at the suite's
 * authorization-server double, then calls this same builder). ONE callback,
 * `GET /oauth/callback/{provider}`, completes every grant. Neither has a
 * seam-only variant, so what the suite measures through the seam is the
 * production path (RFC 0199 Implementation notes; `review/arch-impl.md` R9).
 *
 * The client rules (oauth.md §The authorization-code client):
 *   1. PKCE S256 on every grant (verifier: 32 CSPRNG bytes; `plain` never);
 *   2. `state`: 32 CSPRNG bytes, bound to the initiating Subject and the
 *      provider, consumed once, dead after 10 minutes; an absent, unknown,
 *      consumed or expired state is refused BEFORE any token request;
 *   3. the callback completes only for the Subject bound to `state`;
 *   4. RFC 9207 `iss` checked where the issuer is known (a missing `iss` is
 *      refused when the provider's metadata sets
 *      `authorization_response_iss_parameter_supported`); every provider has
 *      its own redirect URI, so an issuer-less provider shares none;
 *   5. the redirect URI is fixed per provider (`<publicBase>/oauth/callback/<id>`)
 *      and never read from request input.
 * A provider reached as an MCP server (a connection pack with `reach.mcp`)
 * additionally gets `resource` (RFC 8707) on both requests and
 * verify-not-select discovery (RFC 9728 PRM → RFC 8414 metadata), pinned at
 * registration and re-checked before every grant.
 *
 * Tokens never leave the host: the node receives nothing on the wire, events
 * carry a credential REFERENCE, and the code / state / verifier are never
 * written to a run-visible surface.
 */
import { createHash, randomBytes } from 'node:crypto';
import { err } from './errors.js';
import { guardedRequest, validateEgressUrl } from './egress.js';
import { opaque } from './ids.js';
import { principalRef } from './identity.js';
import { appendEvent, ownerOf } from './events.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import { TERMINAL, type Host, type Subject } from './host.js';
import type { RunRow } from './store.js';

export const OAUTH_USE_TYPE = 'conformance.oauth.use';
export const STATE_TTL_MS = 10 * 60_000;
const CLIENT_ID = 'openwop-v2-reference';

/** The closed resume schema of a `credential` interrupt (suspend-request.schema.json binding). */
export const CREDENTIAL_RESUME_SCHEMA = { type: 'object', additionalProperties: false, required: ['outcome'], properties: { outcome: { enum: ['authorized', 'declined'] } } } as const;

/** The advertised provider catalog: the suite's synthetic provider and two issuer-less ones. */
export const CATALOG: ReadonlyArray<{ id: string; scopesSupported: string[] }> = [
  { id: 'synthetic', scopesSupported: ['openwop.read', 'openwop.write'] },
  { id: 'synthetic-noiss', scopesSupported: ['openwop.read', 'openwop.write'] },
  { id: 'synthetic-noiss-b', scopesSupported: ['openwop.read', 'openwop.write'] },
];
const DEFAULT_ENDPOINTS = { authUrl: 'https://oauth.synthetic.openwop.test/authorize', tokenUrl: 'https://oauth.synthetic.openwop.test/token' };

export interface ProviderRow {
  id: string;
  auth_url: string;
  token_url: string;
  issuer: string | null;
  pkce: string | null;
  /** RFC 8707 resource — set only for a provider reached as an MCP server. */
  resource: string | null;
  source: 'catalog' | 'seam' | 'pack';
  /** The verified (resource, issuer, authorize, token) tuple, pinned at registration (§B.4). */
  pin_json: string | null;
  /** The provider's AS metadata said authorization_response_iss_parameter_supported. */
  iss_required: number;
}

/** Is the installed contract one that carries RFC 0199 (the two codes and the credential kind)? */
export function oauthSupported(host: Host): boolean {
  return host.artifacts.errors.has('connector_auth_declined') && host.artifacts.errors.has('connection_auth_metadata_mismatch');
}

/** Where a user agent reaches this host. connectUrl MUST be https, so the facet needs an https base. */
export function publicBase(host: Host): string {
  return (host.config.publicBaseUrl ?? `http://${host.config.host}:${host.config.port}`).replace(/\/+$/, '');
}
export function credentialInterruptAdvertised(host: Host): boolean {
  return oauthSupported(host) && host.config.oauthCredentialInterrupt && publicBase(host).startsWith('https://');
}

const subjectKey = (s: { tenant: string } & Subject): string => `${s.tenant}|${principalRef(s)}`;
const b64u = (n: number): string => randomBytes(n).toString('base64url');
const S256 = (v: string): string => createHash('sha256').update(v).digest('base64url');

// ── the provider registry ───────────────────────────────────────────────────

export function provider(host: Host, id: string): ProviderRow | undefined {
  const row = host.store.db.prepare('SELECT * FROM oauth_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  if (row) return row;
  if (!CATALOG.some((p) => p.id === id)) return undefined;
  return { id, auth_url: DEFAULT_ENDPOINTS.authUrl, token_url: DEFAULT_ENDPOINTS.tokenUrl, issuer: null, pkce: null, resource: null, source: 'catalog', pin_json: null, iss_required: 0 };
}
function upsertProvider(host: Host, row: ProviderRow): void {
  host.store.db.prepare(`INSERT INTO oauth_providers (id, auth_url, token_url, issuer, pkce, resource, source, pin_json, iss_required) VALUES (@id, @auth_url, @token_url, @issuer, @pkce, @resource, @source, @pin_json, @iss_required)
    ON CONFLICT(id) DO UPDATE SET auth_url = excluded.auth_url, token_url = excluded.token_url, issuer = excluded.issuer, pkce = excluded.pkce, resource = excluded.resource, source = excluded.source, pin_json = excluded.pin_json, iss_required = excluded.iss_required`).run(row);
}

async function getJson(host: Host, url: string): Promise<Record<string, unknown> | null> {
  let u: URL;
  try { u = validateEgressUrl(url, host.config.oauthAllowPrivate); } catch { return null; }
  const r = await guardedRequest(u, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 5000, allowPrivate: host.config.oauthAllowPrivate });
  if (r.status !== 200) return null;
  try { const j = JSON.parse(r.body) as unknown; return j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null; } catch { return null; }
}

/** RFC 8414 §3.1 — metadata URL for an issuer (path-inserted form). */
function asMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

/** Point a catalog provider at given endpoints (the authorize-start seam). The issuer's metadata decides whether iss is required. */
export async function configureProvider(host: Host, id: string, v: { authUrl?: string; tokenUrl?: string; issuer?: string; pkce?: string }): Promise<ProviderRow> {
  const base = provider(host, id);
  if (!base || base.source === 'pack') throw err('oauth_provider_unsupported', `provider ${id} is not in oauth.providers`, { provider: id });
  let issRequired = 0;
  if (typeof v.issuer === 'string') {
    const md = await getJson(host, asMetadataUrl(v.issuer));
    if (md && md['issuer'] === v.issuer && md['authorization_response_iss_parameter_supported'] === true) issRequired = 1;
  }
  const row: ProviderRow = { ...base, auth_url: v.authUrl ?? base.auth_url, token_url: v.tokenUrl ?? base.token_url, issuer: v.issuer ?? null, pkce: v.pkce ?? null, resource: null, source: 'seam', pin_json: null, iss_required: issRequired };
  upsertProvider(host, row);
  return row;
}

// ── §B: a provider reached as an MCP server ─────────────────────────────────

interface PackAuth { kind?: string; issuer?: string; pkce?: string; endpoints?: { authorize?: string; token?: string } }
interface PackProvider { id?: string; auth?: PackAuth; reach?: { mcp?: { server?: { url?: string } } } }

const mismatch = (why: string, details: Record<string, unknown> = {}): Error => err('connection_auth_metadata_mismatch', why, details);

/** RFC 8707 / MCP §Canonical Server URI: lowercase scheme and host, no fragment, no trailing slash unless the path is `/`. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
}

/**
 * RFC 0199 §B.3 — discovery VERIFIES the manifest; it never selects an
 * endpoint. Returns the verified tuple, or throws connection_auth_metadata_mismatch.
 * Only URLs derived from the manifest's server URL and issuer are fetched.
 */
async function verifyReach(host: Host, p: PackProvider): Promise<{ resource: string; issuer: string; authorize: string; token: string; issRequired: boolean }> {
  const serverUrl = p.reach?.mcp?.server?.url;
  const issuer = p.auth?.issuer;
  const authorize = p.auth?.endpoints?.authorize;
  const token = p.auth?.endpoints?.token;
  if (typeof serverUrl !== 'string') throw mismatch('reach.mcp.server.url is required');
  // §E.2 host-side rule: no issuer ⇒ §B.3(c) cannot hold ⇒ the grant is refused (the document is not).
  if (typeof issuer !== 'string') throw mismatch('a reach.mcp + oauth2 provider whose manifest declares no provider.auth.issuer cannot be authorized (RFC 0199 §E.2)', { field: 'provider.auth.issuer' });
  if (p.auth?.pkce === 'unsupported') throw mismatch('a provider reached as an MCP server MUST use PKCE; pkce "unsupported" cannot be authorized (RFC 0199 §B.2)', { field: 'provider.auth.pkce' });
  if (typeof authorize !== 'string' || typeof token !== 'string') throw mismatch('provider.auth.endpoints.authorize and .token are required for an MCP reach', { field: 'provider.auth.endpoints' });
  const resource = canonicalResource(serverUrl);
  // (a) RFC 9728 §3.1: the well-known URI derived from the server URL — path-inserted, then the root form.
  const s = new URL(resource);
  const candidates = [`${s.origin}/.well-known/oauth-protected-resource${s.pathname === '/' ? '' : s.pathname}`, `${s.origin}/.well-known/oauth-protected-resource`];
  let prm: Record<string, unknown> | null = null;
  for (const c of candidates) { prm = await getJson(host, c); if (prm) break; }
  if (!prm) throw mismatch('the MCP server publishes no Protected Resource Metadata at the URIs its URL derives', { resource });
  // (b) RFC 9728 §3.3
  if (typeof prm['resource'] !== 'string' || canonicalResource(prm['resource']) !== resource) throw mismatch('the PRM resource is not the server URL it was fetched for', { resource, got: prm['resource'] });
  // (c) the manifest's issuer must be named — never another one adopted.
  const servers = Array.isArray(prm['authorization_servers']) ? (prm['authorization_servers'] as unknown[]).map(String) : [];
  if (!servers.includes(issuer)) throw mismatch('the PRM does not name the manifest\'s issuer', { issuer, authorizationServers: servers });
  // (d) metadata ONLY from the manifest's issuer, and its issuer identical (RFC 8414 §3.3).
  const md = await getJson(host, asMetadataUrl(issuer));
  if (!md || md['issuer'] !== issuer) throw mismatch('the issuer\'s authorization-server metadata is missing or names another issuer', { issuer });
  // (e) the endpoints must equal the manifest's.
  if (md['authorization_endpoint'] !== authorize || md['token_endpoint'] !== token) throw mismatch('the authorization-server metadata endpoints differ from the manifest\'s', { field: md['token_endpoint'] !== token ? 'token_endpoint' : 'authorization_endpoint' });
  // §B.2: S256 MUST be listed.
  const methods = Array.isArray(md['code_challenge_methods_supported']) ? (md['code_challenge_methods_supported'] as unknown[]).map(String) : [];
  if (!methods.includes('S256')) throw mismatch('the authorization server does not list S256 in code_challenge_methods_supported (RFC 0199 §B.2)', { codeChallengeMethods: methods });
  return { resource, issuer, authorize, token, issRequired: md['authorization_response_iss_parameter_supported'] === true };
}

/**
 * The production connection-pack registration path for an oauth2 provider
 * reached as an MCP server: validate, verify, pin. A second registration of
 * the same provider keeps the first pin.
 */
export async function registerReachProvider(host: Host, pack: Record<string, unknown>): Promise<ProviderRow> {
  // connection-packs.md §Manifest: the shape this path relies on (the full manifest schema is the publish-time gate).
  const p = (pack['provider'] ?? {}) as PackProvider;
  const https = (v: unknown): boolean => typeof v === 'string' && /^https:\/\//.test(v);
  if (pack['kind'] !== 'connection' || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.id)) throw err('pack_validation_failed', 'a connection pack names kind "connection" and a provider.id');
  if (!https(p.reach?.mcp?.server?.url) || (p.auth?.endpoints?.authorize !== undefined && !https(p.auth.endpoints.authorize)) || (p.auth?.endpoints?.token !== undefined && !https(p.auth.endpoints.token)) || (p.auth?.issuer !== undefined && !https(p.auth.issuer))) {
    throw err('pack_validation_failed', 'connection-pack endpoints, issuer and reach.mcp.server.url are https:// URLs (clause 3)');
  }
  if (p.auth?.kind !== 'oauth2' || p.reach?.mcp === undefined) throw err('validation_error', 'this path registers an oauth2 provider reached as an MCP server (provider.reach.mcp)');
  const id = String(p.id);
  const existing = host.store.db.prepare('SELECT * FROM oauth_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  if (existing && existing.source !== 'pack') throw err('validation_error', `provider ${id} is already defined by the host catalog`);
  const t = await verifyReach(host, p);
  const tuple = JSON.stringify([t.resource, t.issuer, t.authorize, t.token]);
  const row: ProviderRow = { id, auth_url: t.authorize, token_url: t.token, issuer: t.issuer, pkce: 'S256', resource: t.resource, source: 'pack', pin_json: existing?.pin_json ?? tuple, iss_required: t.issRequired ? 1 : 0 };
  if (row.pin_json !== tuple) throw mismatch('a later discovery disagrees with the tuple pinned at registration (RFC 0199 §B.4)', { provider: id });
  upsertProvider(host, row);
  host.store.db.prepare('INSERT OR REPLACE INTO oauth_packs (provider_id, pack_json) VALUES (?, ?)').run(id, JSON.stringify(pack));
  return row;
}

/** §B.4 — before every grant for a pack provider, discovery runs again and must match the pin. */
async function recheckPin(host: Host, row: ProviderRow): Promise<ProviderRow> {
  if (row.source !== 'pack') return row;
  const packRow = host.store.db.prepare('SELECT pack_json FROM oauth_packs WHERE provider_id = ?').get(row.id) as { pack_json: string } | undefined;
  if (!packRow) throw mismatch('the pack behind this provider is not registered');
  const t = await verifyReach(host, (JSON.parse(packRow.pack_json) as { provider: PackProvider }).provider);
  if (JSON.stringify([t.resource, t.issuer, t.authorize, t.token]) !== row.pin_json) throw mismatch('discovery disagrees with the tuple pinned at registration (RFC 0199 §B.4)', { provider: row.id });
  return row;
}

// ── the one authorization-URL builder ───────────────────────────────────────

export const redirectUriFor = (host: Host, providerId: string): string => `${publicBase(host)}/oauth/callback/${encodeURIComponent(providerId)}`;

/**
 * Begin an authorization-code grant for `subject`. PRODUCTION: a connectUrl
 * and the conformance seam both call this, and nothing else builds the URL.
 */
export async function beginGrant(host: Host, subject: Subject, providerId: string, scopes: string[], connect: string | null): Promise<string> {
  let row = provider(host, providerId);
  if (!row) throw err('oauth_provider_unsupported', `provider ${providerId} is not in oauth.providers`, { provider: providerId });
  row = await recheckPin(host, row);
  const state = b64u(32);
  const pkce = row.pkce !== 'unsupported';
  const verifier = b64u(32);
  const redirectUri = redirectUriFor(host, row.id);
  const url = new URL(row.auth_url);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  if (pkce) { url.searchParams.set('code_challenge', S256(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
  if (row.resource !== null) url.searchParams.set('resource', row.resource);
  host.store.db.prepare(`INSERT INTO oauth_states (state, provider, subject_key, verifier, redirect_uri, scopes_json, created_ms, consumed, connect_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(state, row.id, subjectKey(subject), pkce ? verifier : null, redirectUri, JSON.stringify(scopes), Date.now(), connect);
  return url.toString();
}

// ── credentials ─────────────────────────────────────────────────────────────

interface CredentialRow { subject_key: string; provider: string; ref: string; access_token: string; refresh_token: string | null; access_expires_ms: number; scopes_json: string }

function credentialOf(host: Host, key: string, providerId: string): CredentialRow | undefined {
  return host.store.db.prepare('SELECT * FROM oauth_credentials WHERE subject_key = ? AND provider = ?').get(key, providerId) as CredentialRow | undefined;
}
const covers = (c: CredentialRow, scopes: string[]): boolean => { const have = new Set(JSON.parse(c.scopes_json) as string[]); return scopes.every((s) => have.has(s)); };

async function tokenRequest(host: Host, row: ProviderRow, form: Record<string, string>): Promise<Record<string, unknown> | null> {
  let u: URL;
  try { u = validateEgressUrl(row.token_url, host.config.oauthAllowPrivate); } catch { return null; }
  const r = await guardedRequest(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString(), timeoutMs: 5000, allowPrivate: host.config.oauthAllowPrivate });
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body) as Record<string, unknown>; } catch { return null; }
}

/** Does a credential for (Subject, provider, scopes) resolve right now? (the §C.4 re-check) */
export function credentialResolves(host: Host, key: string, providerId: string, scopes: string[]): boolean {
  const c = credentialOf(host, key, providerId);
  return c !== undefined && covers(c, scopes) && c.access_expires_ms > Date.now();
}

/** Mark the stored access token expired (the expire-refresh seam). */
export function expireAccessToken(host: Host, subject: Subject, providerId: string): boolean {
  return host.store.db.prepare('UPDATE oauth_credentials SET access_expires_ms = 0 WHERE subject_key = ? AND provider = ?').run(subjectKey(subject), providerId).changes > 0;
}

/**
 * The node's view (executor.ts): resolve the credential, refreshing host-side;
 * `ok` never carries material (the node would get it in-sandbox only).
 */
export async function acquireForNode(host: Host, run: RunRow, providerId: string, scopes: string[], nodeId: string): Promise<{ ok: true; credentialRef: string } | { ok: false; reason: 'missing' | 'expired' | 'insufficient_scope'; credentialRef?: string }> {
  const key = subjectKey(ownerOf(host, run).subject);
  const c = credentialOf(host, key, providerId);
  if (!c) return { ok: false, reason: 'missing' };
  if (!covers(c, scopes)) return { ok: false, reason: 'insufficient_scope', credentialRef: c.ref };
  if (c.access_expires_ms > Date.now()) return { ok: true, credentialRef: c.ref };
  const row = provider(host, providerId);
  const refreshed = row && c.refresh_token !== null ? await tokenRequest(host, row, { grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: CLIENT_ID, ...(row.resource !== null ? { resource: row.resource } : {}) }) : null;
  if (refreshed && typeof refreshed['access_token'] === 'string') {
    const expiresIn = typeof refreshed['expires_in'] === 'number' ? refreshed['expires_in'] : 3600;
    host.store.db.prepare('UPDATE oauth_credentials SET access_token = ?, access_expires_ms = ?, refresh_token = COALESCE(?, refresh_token) WHERE subject_key = ? AND provider = ?')
      .run(refreshed['access_token'], Date.now() + expiresIn * 1000, typeof refreshed['refresh_token'] === 'string' ? refreshed['refresh_token'] : null, key, providerId);
    return { ok: true, credentialRef: c.ref };
  }
  // oauth.md §Token lifecycle: terminal refresh failure → connector.auth-expired (content-free).
  appendEvent(host, run, 'connector.auth-expired', { provider: providerId, credentialRef: c.ref, reason: 'refresh_token_revoked' }, { nodeId });
  return { ok: false, reason: 'expired', credentialRef: c.ref };
}

/** Mint the connectUrl of a credential interrupt: host-owned, bound to the run's Subject, carrying no token. */
export function connectUrlFor(host: Host, run: RunRow, nodeId: string, providerId: string, scopes: string[]): string {
  const id = b64u(24);
  host.store.db.prepare('INSERT INTO oauth_connect (connect_id, run_id, node_id, subject_key, provider, scopes_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, run.run_id, nodeId, subjectKey(ownerOf(host, run).subject), providerId, JSON.stringify(scopes));
  return `${publicBase(host)}/oauth/connect/${id}`;
}

// ── routes: connectUrl and the callback ─────────────────────────────────────

interface StateRow { state: string; provider: string; subject_key: string; verifier: string | null; redirect_uri: string; scopes_json: string; created_ms: number; consumed: number; connect_id: string | null }
interface ConnectRow { connect_id: string; run_id: string; node_id: string; subject_key: string; provider: string; scopes_json: string }

/** Set by server.ts: the host-side resolve of a credential interrupt once its grant completed (executor.ts). */
let onGrantCompleted: ((host: Host, runId: string, nodeId: string, subject: Subject) => void) | null = null;
export function setGrantCompletedHandler(fn: (host: Host, runId: string, nodeId: string, subject: Subject) => void): void { onGrantCompleted = fn; }

async function connect(ctx: Ctx): Promise<Reply> {
  const subject = ctx.subject as Subject;
  const row = ctx.host.store.db.prepare('SELECT * FROM oauth_connect WHERE connect_id = ?').get(ctx.params['connectId']) as ConnectRow | undefined;
  if (!row) throw err('not_found', 'no such connect link');
  // oauth.md: connectUrl completes only for the initiating Subject (oauth-same-user-binding).
  if (row.subject_key !== subjectKey(subject)) throw err('forbidden', 'this connect link belongs to another Subject');
  const run = ctx.host.store.getRun(row.run_id);
  if (!run || TERMINAL.has(run.status) || !ctx.host.store.pendingInterruptForNode(row.run_id, row.node_id)) throw err('interrupt_already_resolved', 'the credential interrupt this link belongs to is no longer open');
  const url = await beginGrant(ctx.host, subject, row.provider, JSON.parse(row.scopes_json) as string[], row.connect_id);
  return { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } };
}

async function callback(ctx: Ctx): Promise<Reply> {
  const host = ctx.host;
  const subject = ctx.subject as Subject;
  const providerId = ctx.params['provider'] as string;
  const q = ctx.url.searchParams;
  const state = q.get('state');
  // Rule 2: an absent / unknown / consumed / expired state is refused before any token request.
  if (state === null || state.length === 0) throw err('validation_error', 'the callback carries no state', { field: 'state' });
  const row = host.store.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state) as StateRow | undefined;
  if (!row || row.provider !== providerId) throw err('validation_error', 'unknown state', { field: 'state' });
  if (row.consumed !== 0) throw err('validation_error', 'the state was already used', { field: 'state' });
  if (Date.now() - row.created_ms > STATE_TTL_MS) throw err('validation_error', 'the state expired', { field: 'state' });
  // Rule 3: only the Subject bound to state completes it — refused, and nothing is stored.
  if (row.subject_key !== subjectKey(subject)) throw err('forbidden', 'the callback is authenticated as a Subject other than the one that began the grant');
  // From here the state is spent, whatever happens (a mix-up attempt burns it).
  if (host.store.db.prepare('UPDATE oauth_states SET consumed = 1 WHERE state = ? AND consumed = 0').run(state).changes !== 1) throw err('validation_error', 'the state was already used', { field: 'state' });
  const p = provider(host, providerId);
  if (!p) throw err('oauth_provider_unsupported', `provider ${providerId} is not in oauth.providers`);
  // Rule 4: RFC 9207 §2.4, before any token request.
  const iss = q.get('iss');
  if (p.issuer !== null) {
    if (iss !== null && iss !== p.issuer) throw err('validation_error', 'the authorization response names another issuer (RFC 9207)', { field: 'iss' });
    if (iss === null && p.iss_required === 1) throw err('validation_error', 'the authorization response carries no iss, which this provider\'s metadata promises (RFC 9207)', { field: 'iss' });
  }
  if (q.get('error') !== null) throw err('validation_error', 'the provider refused the authorization', { field: 'error' });
  const code = q.get('code');
  if (code === null) throw err('validation_error', 'the callback carries no code', { field: 'code' });
  const tokens = await tokenRequest(host, p, {
    grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, client_id: CLIENT_ID,
    ...(row.verifier !== null ? { code_verifier: row.verifier } : {}),
    ...(p.resource !== null ? { resource: p.resource } : {}),

  });
  if (!tokens || typeof tokens['access_token'] !== 'string') throw err('validation_error', 'the token endpoint refused the exchange', { field: 'code' });
  const scopes = JSON.parse(row.scopes_json) as string[];
  const granted = typeof tokens['scope'] === 'string' && tokens['scope'].length > 0 ? tokens['scope'].split(' ') : scopes;
  const ref = credentialOf(host, row.subject_key, p.id)?.ref ?? `cred_${opaque()}`;
  const expiresIn = typeof tokens['expires_in'] === 'number' ? tokens['expires_in'] : 3600;
  host.store.db.prepare(`INSERT INTO oauth_credentials (subject_key, provider, ref, access_token, refresh_token, access_expires_ms, scopes_json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject_key, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, access_expires_ms = excluded.access_expires_ms, scopes_json = excluded.scopes_json`)
    .run(row.subject_key, p.id, ref, tokens['access_token'], typeof tokens['refresh_token'] === 'string' ? tokens['refresh_token'] : null, Date.now() + expiresIn * 1000, JSON.stringify(granted));
  if (row.connect_id !== null && onGrantCompleted !== null) {
    const link = host.store.db.prepare('SELECT * FROM oauth_connect WHERE connect_id = ?').get(row.connect_id) as ConnectRow | undefined;
    const run = link ? host.store.getRun(link.run_id) : undefined;
    if (link && run && !TERMINAL.has(run.status)) {
      appendEvent(host, run, 'connector.authorized', { provider: p.id, credentialRef: ref, scopes: granted }, { nodeId: link.node_id });
      onGrantCompleted(host, link.run_id, link.node_id, subject);
    }
  }
  return { status: 200, body: { provider: p.id, credentialRef: ref } };
}

export function oauthRoutes(): Route[] {
  return [
    route('GET', '/oauth/connect/{connectId}', true, connect),
    route('GET', '/oauth/callback/{provider}', true, callback),
  ];
}

export const OAUTH_DDL = `
-- RFC 0199: the OAuth-client stores. Tokens never leave this table on any surface.
CREATE TABLE IF NOT EXISTS oauth_providers (
  id TEXT PRIMARY KEY, auth_url TEXT NOT NULL, token_url TEXT NOT NULL, issuer TEXT NULL, pkce TEXT NULL,
  resource TEXT NULL, source TEXT NOT NULL, pin_json TEXT NULL, iss_required INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_packs (provider_id TEXT PRIMARY KEY, pack_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, provider TEXT NOT NULL, subject_key TEXT NOT NULL, verifier TEXT NULL, redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL, created_ms INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, connect_id TEXT NULL
);
CREATE TABLE IF NOT EXISTS oauth_credentials (
  subject_key TEXT NOT NULL, provider TEXT NOT NULL, ref TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NULL,
  access_expires_ms INTEGER NOT NULL, scopes_json TEXT NOT NULL, PRIMARY KEY (subject_key, provider)
);
CREATE TABLE IF NOT EXISTS oauth_connect (
  connect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, subject_key TEXT NOT NULL, provider TEXT NOT NULL, scopes_json TEXT NOT NULL
);
-- RFC 0199 §D.2(d): a host-owned page that resolves one interrupt for its Subject (MCP URL mode for a schema form mode may not carry).
CREATE TABLE IF NOT EXISTS interrupt_pages (
  page_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, subject_key TEXT NOT NULL
);
`;

export { subjectKey };
