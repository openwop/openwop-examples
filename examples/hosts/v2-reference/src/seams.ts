/**
 * conformance.md §The seams profile — `openwop-conformance-seams-v2`, mounted
 * under /conformance/seams/… (api/seams-v2.yaml) and advertised as
 * `conformance.seamsProfile`. Never part of the canonical API.
 *
 *   POST sample/event-log/seed                  seedEra2EventLog (RFC 0176)
 *   POST sample/webhooks/receive                receiveWebhookDelivery (RFC 0176 §D.2)
 *   POST sample/auth/credential/{mint,revoke}   the per-lane revoke seam (RFC 0170 §B.3)
 *   POST sample/test/workload-identity/resolve  §20 workload identity (RFC 0154 / 0170 §B.4)
 *   PUT/GET/DELETE packs-test/{name}/-/{version}[.tgz|.sig]   the isolated pack catalog
 *   GET/PUT/DELETE workspace/files[/{path}]     the minimal RFC 0059 workspace
 */
import { createHash } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, SEAMS_PREFIX } from './config.js';
import { err } from './errors.js';
import { mintCredential, resolveWorkloadIdentity, revokeCredential } from './identity.js';
import { nowIso, opaque, tenantBound } from './ids.js';
import { installedPacks, publishTestPack } from './packs.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import { verifyInbound } from './webhooks.js';
import type { Host } from './host.js';

const SEED_STATUS = new Set(['running', 'completed', 'failed', 'cancelled']);
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

export function seamRoutes(host: Host): Route[] {
  if (!host.config.seamsProfile) return [];
  const p = SEAMS_PREFIX;
  return [
    route('POST', `${p}/sample/event-log/seed`, true, seedEra2),
    route('POST', `${p}/sample/webhooks/receive`, true, receive),
    route('POST', `${p}/sample/auth/credential/mint`, true, mint),
    route('POST', `${p}/sample/auth/credential/revoke`, true, revoke),
    route('POST', `${p}/sample/test/workload-identity/resolve`, true, workloadResolve),
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
