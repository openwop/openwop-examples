/**
 * conformance.md §The seams profile — `openwop-conformance-seams-v2`, mounted
 * under /conformance/seams/… (api/seams-v2.yaml) and advertised as
 * `conformance.seamsProfile`. Never part of the canonical API.
 *
 *   POST sample/event-log/seed                  seedEra2EventLog (RFC 0176)
 *   POST sample/webhooks/receive                receiveWebhookDelivery (RFC 0176 §D.2)
 *   POST sample/auth/credential/{mint,revoke}   the per-lane revoke seam (RFC 0170 §B.3)
 *   POST sample/test/idempotency/hold            armIdempotencyHold — RFC 0213 §B in-flight witness (idempotency-hold.ts)
 *   POST sample/test/workload-identity/resolve  §20 workload identity (RFC 0154 / 0170 §B.4)
 *   POST sample/test/sandbox-{load,invoke}      §8 sandbox seam (RFC 0173 §B; sandbox.ts)
 *   POST sample/{a2a,mcp}/invoke                §22/§23 negotiation drivers (RFC 0175; interop.ts)
 *   POST sample/auth/{saml/validate,scim/provision} + GET sample/auth/subject-links   RFC 0050 seams; the link record (RFC 0159/0163; saml-scim.ts)
 *   PUT/GET/DELETE packs-test/{name}/-/{version}[.tgz|.sig]   the isolated pack catalog
 *   GET/PUT/DELETE workspace/files[/{path}]     the minimal RFC 0059 workspace
 *   POST sample/oauth/{authorize-start,expire-refresh}   RFC 0199 — point a provider at the suite's AS double, then the PRODUCTION builder (oauth.ts)
 */
import { inboundTraceContext } from './trace-context.js';
import { createHash } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, SEAMS_PREFIX } from './config.js';
import { err } from './errors.js';
import { mintCredential, resolveWorkloadIdentity, revokeCredential } from './identity.js';
import { IDEMPOTENCY_KEY, nowIso, opaque, tenantBound } from './ids.js';
import { installedPacks, publishTestPack } from './packs.js';
import { effectSeamManifest } from './effects.js';
import { scheduleRun } from './executor.js';
import { EVENT_LOG_SCHEMA_VERSION } from './config.js';
import { TERMINAL } from './host.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import { verifyInbound } from './webhooks.js';
import type { Host } from './host.js';
import { invokeSandboxed, sandboxPackIds } from './sandbox.js';
import { samlValidate, scimProvision, subjectLink } from './saml-scim.js';
import { a2aInvoke, mcpInvoke } from './interop.js';
import { unregisterChainPack } from './chains.js';
import { admitSurface } from './a2ui.js';
import { loadRun } from './runs.js';
import { armHold, MAX_HOLD_MS } from './idempotency-hold.js';
import { beginGrant, configureProvider, expireAccessToken, oauthSupported, registerReachProvider } from './oauth.js';

const SEED_STATUS = new Set(['running', 'completed', 'failed', 'cancelled']);
/** The seam's own fixture destination: reserved by RFC 2606, never resolvable. */
const FIXTURE_DESTINATION = 'https://effect-seam.invalid/fire';
const WS_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

async function seedEra2(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ eventLogSchemaVersion?: unknown; status?: unknown; events?: unknown }>();
  for (const k of Object.keys(body)) if (!['eventLogSchemaVersion', 'status', 'events'].includes(k)) throw err('validation_error', `unknown key ${k}`);
  if (body.eventLogSchemaVersion !== 2) throw err('validation_error', 'eventLogSchemaVersion MUST be 2 — the seam writes an era-2 log');
  if (!SEED_STATUS.has(String(body.status))) throw err('validation_error', 'status is running | completed | failed | cancelled');
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) throw err('validation_error', 'events[] MUST carry at least one row');
  const tenant = ctx.subject?.tenant ?? ctx.host.config.tenant;
  const runId = tenantBound(tenant);
  const started = events.find((e) => (e as { type?: unknown }).type === 'run.started') as { payload?: { workflowId?: unknown } } | undefined;
  const workflowId = typeof started?.payload?.workflowId === 'string' ? started.payload.workflowId : 'conformance-noop';
  // The run row carries NO era stamp and NO owner: it reads as era 2 and is legacy-stamped at first v2 read.
  ctx.host.store.insertRun({ run_id: runId, tenant, workflow_id: workflowId, status: String(body.status), era: null, owner_json: null, options_json: '{}', inputs_json: '{}', created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null, current_node_id: null, error_json: null, source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null, pause_requested: 0, cancel_requested: 0, pin_checked: 0, scope_id: null });
  const seen = new Set<number>();
  for (const raw of events as Array<Record<string, unknown>>) {
    for (const k of Object.keys(raw)) if (!['type', 'sequence', 'payload', 'timestamp', 'causationId'].includes(k)) throw err('validation_error', `unknown event key ${k}`);
    if (typeof raw['type'] !== 'string' || !Number.isInteger(raw['sequence']) || (raw['sequence'] as number) < 0 || raw['payload'] === null || typeof raw['payload'] !== 'object') throw err('validation_error', 'each event is { type, sequence, payload, timestamp?, causationId? }');
    if (seen.has(raw['sequence'] as number)) throw err('validation_error', `duplicate sequence ${raw['sequence']}`);
    seen.add(raw['sequence'] as number);
    // Persisted VERBATIM: v1 type string, the given sequence, no translation at write time.
    ctx.host.store.insertEvent({ run_id: runId, sequence: raw['sequence'] as number, event_id: opaque(), type: raw['type'], payload_json: JSON.stringify(raw['payload']), timestamp: typeof raw['timestamp'] === 'string' ? raw['timestamp'] : nowIso(), node_id: typeof (raw['payload'] as { nodeId?: unknown })['nodeId'] === 'string' ? String((raw['payload'] as { nodeId: string }).nodeId) : null, causation_id: typeof raw['causationId'] === 'string' ? raw['causationId'] : null, schema_version: EVENT_SCHEMA_VERSION, engine_version: null });
  }
  return { status: 201, body: { runId } };
}

async function receive(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ secret?: unknown; headers?: unknown; body?: unknown }>();
  for (const k of Object.keys(body)) if (!['secret', 'headers', 'body'].includes(k)) throw err('validation_error', `unknown key ${k}`);
  if (typeof body.secret !== 'string' || body.secret.length === 0) throw err('validation_error', 'secret is REQUIRED');
  if (body.headers === null || typeof body.headers !== 'object' || Array.isArray(body.headers)) throw err('validation_error', 'headers MUST be an object of strings');
  if (typeof body.body !== 'string') throw err('validation_error', 'body MUST be the raw delivery bytes as a string');
  const headers = Object.fromEntries(Object.entries(body.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const verdict = verifyInbound(body.secret, headers, body.body);
  return { status: 200, body: verdict.reason === undefined ? { accepted: verdict.accepted } : { accepted: verdict.accepted, reason: verdict.reason } };
}

/**
 * Start one run of `workflowId` under the caller's tenant with the given
 * inputs and wait for it to settle; the seams below use it to drive an effect
 * seam inside a real run whose ledger is the witness.
 */
async function driveRun(ctx: Ctx, workflowId: string, inputs: Record<string, unknown>): Promise<string> {
  const tenant = ctx.subject?.tenant ?? ctx.host.config.tenant;
  if (!ctx.host.workflows.has(workflowId)) throw err('not_found', `the seam fixture ${workflowId} is not registered on this host`, { workflowId });
  const runId = tenantBound(tenant);
  ctx.host.store.insertRun({
    run_id: runId, tenant, workflow_id: workflowId, status: 'pending', era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: JSON.stringify({ tenant, subject: ctx.subject }), options_json: '{}', inputs_json: JSON.stringify(inputs),
    created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null, current_node_id: null, error_json: null,
    source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null, pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: null,
  });
  scheduleRun(ctx.host, runId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = ctx.host.store.getRun(runId);
    if (r && TERMINAL.has(r.status)) return runId;
    if (Date.now() > deadline) return runId;
    await new Promise((res) => setTimeout(res, 25));
  }
}

/**
 * `fireEffectSeam` (RFC 0173 §C.1 no-re-fire witness) — drive one named row of
 * GET /host/effect-seams once inside a run. The scenario forks the run in
 * `replay` mode and asserts the fork's effect ledger does not exceed this run's.
 */
async function fireEffectSeamRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ seam?: unknown; receiverUrl?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'seam' && k !== 'receiverUrl') throw err('validation_error', `unknown key ${k}`);
  const seam = String(body.seam ?? '');
  const rows = (effectSeamManifest(ctx.host)['seams'] as Array<{ seam: string }>).map((r) => r.seam);
  if (!rows.includes(seam)) throw err('not_found', `${seam} is not a row of GET /host/effect-seams`, { seam, seams: rows });
  if (seam !== 'http.fetch') throw err('validation_error', `the ${seam} seam is not fired inside a run on this host — only http.fetch reaches the node runtime (webhook.fanout is driven by a run's own events)`, { seam });
  if (body.receiverUrl !== undefined && typeof body.receiverUrl !== 'string') throw err('validation_error', 'receiverUrl MUST be a URI');
  const runId = await driveRun(ctx, 'conformance-http-effect', {
    businessKey: `effect-seam-fire-${opaque()}`,
    url: typeof body.receiverUrl === 'string' ? body.receiverUrl : FIXTURE_DESTINATION,
  });
  return { status: 201, body: { runId } };
}

/**
 * `forceEffectTransportRetry` (RFC 0173 §D.2 G4) — one effect, retried at the
 * transport layer. Every attempt records under the one identity assigned to
 * the business key, so the ledger shows the same `effectId` and `providerKey`.
 */
async function effectRetryRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ providerUrl?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'providerUrl') throw err('validation_error', `unknown key ${k}`);
  if (typeof body.providerUrl !== 'string' || body.providerUrl.length === 0) throw err('validation_error', 'providerUrl is REQUIRED');
  const runId = await driveRun(ctx, 'conformance-http-effect', {
    businessKey: `effect-retry-${opaque()}`,
    url: body.providerUrl,
    transportRetries: 1,
  });
  const rows = ctx.host.store.effectsForRun(runId);
  const effectId = rows[0]?.effect_id;
  if (effectId === undefined) throw err('internal_error', 'the seam run recorded no effect — the ledger is the witness this seam exists to produce');
  return { status: 201, body: { runId, effectId } };
}

/**
 * `armIdempotencyHold` (RFC 0213 §B witness) — arms a single-use hold so the
 * caller tenant's NEXT `POST /runs` under `key` keeps its Layer-1 claim in flight
 * for `holdMs`. The seam answers only its own 201; the 409 a concurrent same-key
 * create receives comes from `withIdempotency`'s real in-flight branch.
 */
async function idempotencyHoldRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ key?: unknown; holdMs?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'key' && k !== 'holdMs') throw err('validation_error', `unknown key ${k}`);
  if (typeof body.key !== 'string' || !IDEMPOTENCY_KEY.test(body.key)) throw err('validation_error', 'key MUST be an Idempotency-Key (^[A-Za-z0-9._~-]{22,128}$)');
  if (typeof body.holdMs !== 'number' || !Number.isInteger(body.holdMs) || body.holdMs < 1 || body.holdMs > MAX_HOLD_MS) throw err('validation_error', `holdMs MUST be an integer in 1..${MAX_HOLD_MS}`);
  const tenant = ctx.subject?.tenant ?? ctx.host.config.tenant;
  armHold(ctx.host, tenant, body.key, body.holdMs);
  return { status: 201, body: { key: body.key, holdMs: body.holdMs } };
}

async function mint(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ lane?: unknown }>();
  const r = mintCredential(ctx.host, String(body.lane ?? 'api-key'), ctx.subject?.tenant ?? ctx.host.config.tenant);
  return { status: 201, body: { lane: body.lane ?? 'api-key', credential: r.credential, subjectId: r.subjectId } };
}

async function revoke(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ lane?: unknown; credential?: unknown }>();
  if (typeof body.credential !== 'string') throw err('validation_error', 'credential is REQUIRED');
  const revoked = revokeCredential(ctx.host, body.credential);
  if (!revoked) throw err('not_found', 'no active credential matches');
  return { status: 200, body: { revoked: true, lane: body.lane ?? 'api-key' } };
}

async function workloadResolve(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ identity?: unknown; expectedAudience?: unknown }>();
  try {
    const r = resolveWorkloadIdentity(ctx.host, (body.identity ?? {}) as Record<string, unknown>, typeof body.expectedAudience === 'string' ? body.expectedAudience : undefined);
    return { status: 200, body: r };
  } catch (e) {
    const he = e as { code?: string; status?: number; message: string; body?: () => Record<string, unknown> };
    if (typeof he.body === 'function' && he.code !== 'validation_error') {
      return { status: he.status ?? 401, body: { ...he.body(), details: { ...((he.body()['details'] as Record<string, unknown> | undefined) ?? {}), retriable: false } } };
    }
    throw e;
  }
}

async function packPut(ctx: Ctx): Promise<Reply> {
  const bytes = await ctx.raw();
  const r = publishTestPack(ctx.host, ctx.params['name'] as string, ctx.params['version'] as string, bytes, ctx.header('openwop-pack-sha256'));
  return { status: r.status, body: r.body };
}
async function packGet(ctx: Ctx): Promise<Reply> {
  const p = ctx.host.store.getPack('test', ctx.params['name'] as string, ctx.params['version'] as string);
  if (!p) throw err('pack_version_not_found', 'no such test-catalog version');
  return { status: 200, raw: p.tarball, contentType: 'application/tar+gzip', headers: { ETag: `"${p.sha256}"` } };
}
async function packDelete(ctx: Ctx): Promise<Reply> {
  // §Co-registered children: a parent's deletion decrements its children, and a
  // child goes only when its LAST parent does — so this runs before the row is
  // gone and can still read the manifest.
  const row = ctx.host.store.getPack('test', ctx.params['name'] as string, ctx.params['version'] as string);
  if (row?.kind === 'workflow-chain') unregisterChainPack(ctx.host, JSON.parse(row.manifest_json) as Record<string, unknown>);
  if (!ctx.host.store.deletePack('test', ctx.params['name'] as string, ctx.params['version'] as string)) throw err('pack_version_not_found', 'no such test-catalog version');
  return { status: 204 };
}
async function packSig(_ctx: Ctx): Promise<Reply> {
  throw err('signature_not_available', 'the test catalog stores no detached signature');
}
async function packList(ctx: Ctx): Promise<Reply> {
  return { status: 200, body: installedPacks(ctx.host, 'test') };
}

function ws(ctx: Ctx): { tenant: string; workspace: string } {
  return { tenant: ctx.subject?.tenant ?? ctx.host.config.tenant, workspace: 'default' };
}
function fileDoc(row: { path: string; content: string; content_type: string; version: number; etag: string; updated_at: string }): Record<string, unknown> {
  return { path: row.path, content: row.content, contentType: row.content_type, version: row.version, etag: row.etag, updatedAt: row.updated_at };
}
async function wsList(ctx: Ctx): Promise<Reply> {
  const { tenant, workspace } = ws(ctx);
  const prefix = ctx.url.searchParams.get('prefix') ?? '';
  return { status: 200, body: { files: ctx.host.store.workspaceFiles(tenant, workspace, prefix).map((f) => ({ ...fileDoc(f), content: '' })) } };
}
async function wsGet(ctx: Ctx): Promise<Reply> {
  const { tenant, workspace } = ws(ctx);
  const row = ctx.host.store.workspaceFile(tenant, workspace, ctx.params['path'] as string);
  if (!row) throw err('not_found', 'no such workspace file');
  return { status: 200, body: fileDoc(row) };
}
async function wsPut(ctx: Ctx): Promise<Reply> {
  const { tenant, workspace } = ws(ctx);
  const path = ctx.params['path'] as string;
  if (!WS_PATH.test(path) || path.split('/').includes('..')) throw err('validation_error', 'path grammar');
  const body = await ctx.json<{ content?: unknown; contentType?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'content' && k !== 'contentType') throw err('validation_error', `unknown key ${k}`);
  if (typeof body.content !== 'string') throw err('validation_error', 'content is REQUIRED');
  if (Buffer.byteLength(body.content) > 262_144) throw err('workspace_too_large', 'content exceeds workspace.maxFileBytes', { maxFileBytes: 262_144 });
  const existing = ctx.host.store.workspaceFile(tenant, workspace, path);
  const ifMatch = ctx.header('if-match');
  if (ifMatch !== null && existing && existing.etag !== ifMatch) throw err('workspace_conflict', 'stale If-Match', { currentVersion: existing.version });
  const row = { tenant, workspace, path, content: body.content, content_type: typeof body.contentType === 'string' ? body.contentType : 'text/markdown', version: (existing?.version ?? 0) + 1, etag: `"${createHash('sha256').update(body.content).digest('hex').slice(0, 16)}"`, updated_at: nowIso() };
  ctx.host.store.upsertWorkspaceFile(row);
  return { status: 200, body: fileDoc(row) };
}
async function wsDelete(ctx: Ctx): Promise<Reply> {
  const { tenant, workspace } = ws(ctx);
  if (!ctx.host.store.deleteWorkspaceFile(tenant, workspace, ctx.params['path'] as string)) throw err('not_found', 'no such workspace file');
  return { status: 204 };
}

/** host-sample-test-seams.md §8 — the synthetic pack registry is pre-populated; `load` answers for every listed pack. */
async function sandboxLoad(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ packId?: unknown }>();
  if (typeof body.packId !== 'string' || body.packId.length === 0) throw err('validation_error', 'packId is REQUIRED');
  const known = sandboxPackIds().some((t) => t.startsWith(`${body.packId}.`) || t === body.packId);
  if (!known) throw err('not_found', `no synthetic pack ${body.packId}`);
  return { status: 200, body: { ok: true, packId: body.packId } };
}

/** §8 `sandbox-invoke`: 200 { result } | 200 { error: SandboxError } — a refusal is a RESULT of the invocation, not an HTTP error. */
async function sandboxInvoke(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ typeId?: unknown; args?: unknown; allowedHostCalls?: unknown }>();
  if (typeof body.typeId !== 'string' || body.typeId.length === 0) throw err('validation_error', 'typeId is REQUIRED');
  const args = body.args !== undefined && body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
  const allowed = Array.isArray(body.allowedHostCalls) && body.allowedHostCalls.every((c) => typeof c === 'string') ? (body.allowedHostCalls as string[]) : [];
  return { status: 200, body: await invokeSandboxed(ctx.host, body.typeId, args, allowed) };
}

/** RFC 0050 seams (host-sample-test-seams.md): the host's genuine SAML ACS and SCIM server, driven by the suite. */
async function samlValidateRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<Record<string, unknown>>();
  return samlValidate(ctx.subject?.tenant ?? ctx.host.config.tenant, body, ctx.host.config.webhookAllowPrivate);
}
async function scimProvisionRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<Record<string, unknown>>();
  return scimProvision(ctx.subject?.tenant ?? ctx.host.config.tenant, body, ctx.host.config.webhookAllowPrivate);
}
/** identity.md §3 — the link is a record a host can show. */
async function subjectLinksRoute(ctx: Ctx): Promise<Reply> {
  const externalId = ctx.url.searchParams.get('externalId');
  if (!externalId) throw err('validation_error', 'externalId is REQUIRED');
  const link = subjectLink(ctx.subject?.tenant ?? ctx.host.config.tenant, externalId);
  if (!link) throw err('not_found', 'no subject link for that externalId');
  return { status: 200, body: { link } };
}

/** host-sample-test-seams.md §22/§23 — the host's real A2A / MCP client path, driven once. */
// The seam request's own trace context is the caller's (observability.md §Trace context propagation): the client path continues it (RFC 0207).
async function a2aInvokeRoute(ctx: Ctx): Promise<Reply> { return a2aInvoke(ctx.host, ctx.subject?.tenant ?? ctx.host.config.tenant, ctx.subject ?? null, await ctx.json<Record<string, unknown>>(), inboundTraceContext(null, (n) => ctx.header(n))); }
async function mcpInvokeRoute(ctx: Ctx): Promise<Reply> { return mcpInvoke(ctx.host, ctx.subject?.tenant ?? ctx.host.config.tenant, ctx.subject ?? null, await ctx.json<Record<string, unknown>>(), inboundTraceContext(null, (n) => ctx.header(n))); }

/**
 * `startOAuthAuthorization` (RFC 0199 §A/§B). The seam's only job is to point a
 * provider at the suite's authorization-server double — a catalog provider's
 * endpoints, or a connection pack through the production registration path
 * (which verifies and pins) — and then call `beginGrant`, the ONE builder
 * connectUrl uses too. `redirectUri` is accepted and ignored: the redirect
 * URI is fixed per provider.
 */
async function authorizeStartRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<Record<string, unknown>>();
  const allowed = new Set(['provider', 'authUrl', 'tokenUrl', 'issuer', 'pkce', 'scopes', 'connection', 'redirectUri']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw err('validation_error', `unknown key ${k}`);
  if (typeof body['provider'] !== 'string' || body['provider'].length === 0) throw err('validation_error', 'provider is REQUIRED');
  const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const scopes = Array.isArray(body['scopes']) ? (body['scopes'] as unknown[]).map(String) : ['openwop.read'];
  if (body['connection'] !== undefined) {
    const pack = body['connection'];
    if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) throw err('validation_error', 'connection MUST be a connection-pack manifest');
    const row = await registerReachProvider(ctx.host, pack as Record<string, unknown>);
    if (row.id !== body['provider']) throw err('validation_error', 'provider MUST be the connection pack\'s provider.id');
  } else {
    const v: { authUrl?: string; tokenUrl?: string; issuer?: string; pkce?: string } = {};
    for (const k of ['authUrl', 'tokenUrl', 'issuer', 'pkce'] as const) { const x = str(k); if (x !== undefined) v[k] = x; }
    await configureProvider(ctx.host, body['provider'], v);
  }
  const authorizationUrl = await beginGrant(ctx.host, ctx.subject as NonNullable<Ctx['subject']>, body['provider'], scopes, null);
  return { status: 201, body: { authorizationUrl } };
}

/** `expireOAuthAccessToken` (RFC 0199 §C.2(b)): expire the stored access token; the next use takes the production refresh path. */
async function expireRefreshRoute(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ provider?: unknown }>();
  if (typeof body.provider !== 'string') throw err('validation_error', 'provider is REQUIRED');
  if (!expireAccessToken(ctx.host, ctx.subject as NonNullable<Ctx['subject']>, body.provider)) throw err('not_found', 'the caller holds no credential for that provider');
  return { status: 204 };
}

/**
 * `emitA2uiSurface` (RFC 0209) — supplies the envelope a model would have emitted and
 * nothing else: admission is a2ui.ts, the one path production uses. Not mounted when
 * the host cannot enforce the profile (no validator ⇒ the kind is not advertised).
 */
async function emitSurfaceRoute(ctx: Ctx): Promise<Reply> {
  const adm = ctx.host.a2ui;
  if (adm === null) throw err('not_found', 'ui.a2ui-surface is not advertised on this host');
  const body = await ctx.json<{ runId?: unknown; envelope?: unknown }>();
  for (const k of Object.keys(body)) if (k !== 'runId' && k !== 'envelope') throw err('validation_error', `unknown key ${k}`);
  if (typeof body.runId !== 'string' || body.runId.length === 0) throw err('validation_error', 'runId is REQUIRED');
  const run = loadRun(ctx, body.runId);
  return { status: 201, body: admitSurface(ctx.host, adm, run, body.envelope) };
}

export function seamRoutes(host: Host): Route[] {
  if (!host.config.seamsProfile) return [];
  const p = SEAMS_PREFIX;
  return [
    route('POST', `${p}/sample/event-log/seed`, true, seedEra2),
    route('POST', `${p}/sample/webhooks/receive`, true, receive),
    route('POST', `${p}/sample/effect-seams/fire`, true, fireEffectSeamRoute),
    route('POST', `${p}/sample/test/idempotency/effect-retry`, true, effectRetryRoute),
    route('POST', `${p}/sample/test/idempotency/hold`, true, idempotencyHoldRoute),
    route('POST', `${p}/sample/auth/credential/mint`, true, mint),
    route('POST', `${p}/sample/auth/credential/revoke`, true, revoke),
    route('POST', `${p}/sample/test/workload-identity/resolve`, true, workloadResolve),
    route('POST', `${p}/sample/auth/saml/validate`, true, samlValidateRoute),
    route('POST', `${p}/sample/auth/scim/provision`, true, scimProvisionRoute),
    route('GET', `${p}/sample/auth/subject-links`, true, subjectLinksRoute),
    route('POST', `${p}/sample/a2a/invoke`, true, a2aInvokeRoute),
    route('POST', `${p}/sample/mcp/invoke`, true, mcpInvokeRoute),
    ...(host.a2ui !== null ? [route('POST', `${p}/sample/a2ui/emit-surface`, true, emitSurfaceRoute)] : []),
    ...(oauthSupported(host) ? [route('POST', `${p}/sample/oauth/authorize-start`, true, authorizeStartRoute), route('POST', `${p}/sample/oauth/expire-refresh`, true, expireRefreshRoute)] : []),
    route('POST', `${p}/sample/test/sandbox-load`, true, sandboxLoad),
    route('POST', `${p}/sample/test/sandbox-invoke`, true, sandboxInvoke),
    route('PUT', `${p}/packs-test/{name}/-/{version}.tgz`, true, packPut),
    route('GET', `${p}/packs-test/{name}/-/{version}.tgz`, true, packGet),
    route('GET', `${p}/packs-test/{name}/-/{version}.sig`, true, packSig),
    route('DELETE', `${p}/packs-test/{name}/-/{version}`, true, packDelete),
    route('GET', `${p}/packs-test`, true, packList),
    route('GET', `${p}/workspace/files`, true, wsList),
    route('GET', `${p}/workspace/files/{path}`, true, wsGet),
    route('PUT', `${p}/workspace/files/{path}`, true, wsPut),
    route('DELETE', `${p}/workspace/files/{path}`, true, wsDelete),
  ];
}
