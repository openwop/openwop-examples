/**
 * OpenWOP v2 reference host — node:http, no framework. Boots the store, loads
 * the contract, mounts the routes (discovery, runs, webhooks, packs, seams,
 * host events) and starts the delivery worker.
 *
 *   npm start            → http://127.0.0.1:3838
 *   OPENWOP_API_KEY      → the default api-key credential (openwop-v2-dev-key)
 */
import { createA2uiAdmission } from './a2ui.js';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from './artifacts.js';
import { loadConfig, type HostConfig, PKG_ROOT, V1_VERSION, V2_VERSION, SERVED_VERSIONS, V1_RETIRED } from './config.js';
import { etagOf, v1Document, v2Document } from './discovery.js';
import { err } from './errors.js';
import { ensureDefaultCredential } from './identity.js';
import { route, Router, STREAMED, type Ctx, type Reply } from './router.js';
import { runRoutes } from './runs.js';
import { a2aServerRoutes } from './a2a-server.js';
import { mcpServerRoutes } from './mcp-server.js';
import { seamRoutes } from './seams.js';
import { durabilityRoutes, durabilitySeamMounted, recoverInFlightRuns } from './durability.js';
import { Store } from './store.js';
import { createValidator } from './validate.js';
import { deadLetterProjection, registerWebhook, rotateWebhookSecret, startDeliveryWorker, subscribeFanout, unregisterWebhook } from './webhooks.js';
import { installedPacks } from './packs.js';
import { getTool, listTools } from './tool-catalog.js';
import { withIdempotency } from './router.js';
import type { Host, WorkflowDefinition } from './host.js';

/** The fixture catalog: the suite's `fixtures/` (conformance package) plus the host-defined approvers fixture. */
export function loadWorkflows(config: HostConfig, mcpClient = false): Map<string, WorkflowDefinition> {
  const executable = new Set(['core.noop', 'core.delay', 'core.fail', 'core.approvalGate', 'core.clarificationGate', 'core.interrupt', 'core.httpFetch']);
  // The fixtures whose SEMANTICS this host honours end to end (not merely whose node types it recognises).
  const honoured = new Set(['conformance-noop', 'conformance-delay', 'conformance-cancellable', 'conformance-idempotent', 'conformance-multi-node', 'conformance-failure', 'conformance-approval', 'conformance-clarification', 'conformance-interrupt-external-event']);
  // RFC 0204: the ctx.mcp fixture, only when mcp.client is advertised (a host that does not advertise it MUST NOT advertise the fixture).
  if (mcpClient) { executable.add('core.conformance.mcp-client'); honoured.add('conformance-mcp-client'); }
  const dirs: string[] = [];
  if (config.fixturesDir) dirs.push(config.fixturesDir);
  try {
    const req = createRequire(join(PKG_ROOT, 'package.json'));
    dirs.push(join(dirname(req.resolve('@openwop/openwop-conformance/package.json')), 'fixtures'));
  } catch { /* the suite is a dev dependency; fixtures are optional */ }
  const out = new Map<string, WorkflowDefinition>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.startsWith('conformance-') && n.endsWith('.json'))) {
      try {
        const def = JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorkflowDefinition;
        if (!Array.isArray(def.nodes) || typeof def.id !== 'string' || !honoured.has(def.id)) continue;
        // Only fixtures every node of which this host executes are advertised (an honest `fixtures[]`).
        if (!def.nodes.every((n) => executable.has(n.typeId))) continue;
        out.set(def.id, { ...def, edges: def.edges ?? [], variables: def.variables ?? [] });
      } catch { /* skip an unreadable fixture */ }
    }
  }
  const approval = out.get('conformance-approval');
  if (approval) {
    // approver-enforced: an approval gate whose approversList names a principal the caller is not.
    const gate = approval.nodes[0] as WorkflowDefinition['nodes'][number];
    out.set('conformance-approval-approvers', { ...approval, id: 'conformance-approval-approvers', name: 'Conformance: Approval (listed approvers)', nodes: [{ ...gate, config: { ...gate.config, approversList: ['urn:conformance:listed-approver'] } }] });
  }
  // The one workflow that reaches the `http.fetch` row of the effect-seam
  // manifest; the seams profile drives it (fireEffectSeam, forceEffectTransportRetry).
  out.set('conformance-http-effect', {
    id: 'conformance-http-effect', name: 'Reference: http.fetch effect seam', version: '1.0',
    nodes: [{ id: 'fetch', typeId: 'core.httpFetch', config: { url: 'https://effect-seam.invalid/fire', method: 'POST', body: { hello: 'world' }, compensation: { irreversibleEffect: false } }, inputs: {} }],
    edges: [],
    variables: [
      { name: 'url', defaultValue: 'https://effect-seam.invalid/fire' },
      { name: 'businessKey' },
      { name: 'transportRetries', defaultValue: 0 },
    ],
    metadata: { tags: ['reference'] },
  });
  return out;
}

export interface RunningHost { host: Host; server: Server; port: number; close(): Promise<void> }

export async function startHost(overrides: Partial<HostConfig> = {}): Promise<RunningHost> {
  const config = loadConfig(overrides);
  const artifacts = loadArtifacts();
  const store = new Store(config.dbPath);
  const validate = await createValidator(artifacts.schemasDir, config.devValidate);
  const a2ui = await createA2uiAdmission(artifacts.schemasDir, config.envelopeStrictness);
  const host: Host = { config, store, artifacts, bus: new EventEmitter(), workflows: loadWorkflows(config, artifacts.mcpClientFacet && config.mcpServers.size > 0), startedAt: new Date().toISOString(), validate, a2ui };
  host.bus.setMaxListeners(0);
  ensureDefaultCredential(host);

  /** errors.md (rc.40): a malformed body is 400 validation_error from the host, never a parser 500. */
  const jsonObject = (text: string): Record<string, unknown> => {
    let parsed: unknown = {};
    if (text.trim() !== '') { try { parsed = JSON.parse(text); } catch { throw err('validation_error', 'the request body is not JSON'); } }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('validation_error', 'the request body MUST be a JSON object');
    return parsed as Record<string, unknown>;
  };
  const router = new Router(host);
  router.add(
    route('GET', '/.well-known/openwop', false, discovery, 'both'),
    route('GET', '/.well-known/wop', false, discovery, 'both'),
    route('GET', '/openapi.json', false, openapi, 'both'),
    route('GET', '/v1/openapi.json', false, openapi, 1),
    route('GET', '/host/events', true, hostEvents),
    route('GET', '/packs', true, async (ctx) => ({ status: 200, body: installedPacks(ctx.host, 'prod') })),
    route('POST', '/webhooks', true, async (ctx) => {
      const text = await ctx.text();
      return withIdempotency(ctx, 'registerWebhook', text, async () => {
        // errors.md (rc.40): a malformed body is 400 validation_error from the host, never a parser 500.
        let parsed: unknown = {};
        if (text.trim() !== '') { try { parsed = JSON.parse(text); } catch { throw err('validation_error', 'the request body is not JSON'); } }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('validation_error', 'the request body MUST be a JSON object');
        return { status: 201, body: await registerWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, parsed as Record<string, unknown>, ctx.major) };
      });
    }),
    route('DELETE', '/webhooks/{webhookId}', true, async (ctx) => { unregisterWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string); return { status: 204 }; }),
    // The 1.x webhook surface keeps its /v1/ path keys through the overlap (versioning.md §1.4); a
    // subscription registered here is rendered in the v1 contract for its lifetime (webhooks.md §Delivery).
    route('POST', '/v1/webhooks', true, async (ctx) => {
      const text = await ctx.text();
      return withIdempotency(ctx, 'registerWebhook', text, async () => {
        let parsed: unknown = {};
        if (text.trim() !== '') { try { parsed = JSON.parse(text); } catch { throw err('validation_error', 'the request body is not JSON'); } }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw err('validation_error', 'the request body MUST be a JSON object');
        return { status: 201, body: await registerWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, parsed as Record<string, unknown>, 1) };
      });
    }, 1),
    route('DELETE', '/v1/webhooks/{webhookId}', true, async (ctx) => { unregisterWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string); return { status: 204 }; }, 1),
    // RFC 0201 §E — rotateWebhookSecret (404 unless webhooks.secretRotation is advertised).
    route('POST', '/webhooks/{webhookId}/rotate-secret', true, async (ctx) => {
      const text = await ctx.text();
      return withIdempotency(ctx, 'rotateWebhookSecret', `${ctx.params['webhookId'] as string}|${text}`, async () => ({ status: 200, body: rotateWebhookSecret(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string, jsonObject(text)) }));
    }),
    route('POST', '/v1/webhooks/{webhookId}/rotate-secret', true, async (ctx) => {
      const text = await ctx.text();
      return withIdempotency(ctx, 'rotateWebhookSecret', `${ctx.params['webhookId'] as string}|${text}`, async () => ({ status: 200, body: rotateWebhookSecret(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string, jsonObject(text)) }));
    }, 1),
    route('GET', '/webhooks/{webhookId}/dead-letters', true, async (ctx) => ({ status: 200, body: deadLetterProjection(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string, ctx.url.searchParams) })),
    ...runRoutes(),
    // RFC 0208: the A2A 1.0 interface + Agent Card and the MCP 2026-07-28 mount.
    ...a2aServerRoutes(),
    ...mcpServerRoutes(),
    // RFC 0204 — spec/v2/core/tool-catalog.md (tool-catalog.ts). Read-only, authenticated, v2 only.
    route('GET', '/tools', true, async (ctx) => {
      const tools = await listTools(ctx.host);
      for (const t of tools) ctx.host.validate('tool-descriptor', t, `tool ${t.toolId}`);
      return { status: 200, body: tools };
    }),
    route('GET', '/tools/{toolId}', true, async (ctx) => ({ status: 200, body: await getTool(ctx.host, ctx.params['toolId'] as string) })),
    ...seamRoutes(host),
    ...durabilityRoutes(host),
  );
  subscribeFanout(host);
  const stopWorker = startDeliveryWorker(host);
  // Runs left non-terminal by a previous process re-enter the loop (durability across restart),
  // and a run that had started is RECORDED as recovered (`workflow.restored`) — durability.ts.
  recoverInFlightRuns(host);

  const server = createServer((req, res) => { void router.handle(req, res); });
  await new Promise<void>((ok) => server.listen(config.port, config.host, ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
  return {
    host,
    server,
    port,
    close: async () => {
      stopWorker();
      await new Promise<void>((ok) => server.close(() => ok()));
      store.close();
    },
  };
}

async function discovery(ctx: Ctx): Promise<Reply> {
  if (ctx.url.pathname === '/.well-known/wop' && ctx.major === 2) throw err('not_found', 'the /.well-known/wop alias is absent from the v2 surface (deprecation well-known-wop-alias)');
  const doc = ctx.major === 2 ? v2Document(ctx.host, ctx.baseUrl) : v1Document(ctx.host);
  if (ctx.major === 2) ctx.host.validate('capabilities', doc, 'discovery v2');
  const text = JSON.stringify(doc);
  const etag = etagOf(text);
  const headers = { ETag: etag, 'Cache-Control': 'public, max-age=60' };
  const inm = ctx.header('if-none-match');
  if (inm !== null && inm.split(',').map((s) => s.trim()).includes(etag)) return { status: 304, headers };
  return { status: 200, raw: text, contentType: 'application/json; charset=utf-8', headers };
}

async function openapi(ctx: Ctx): Promise<Reply> {
  const root = ctx.host.artifacts.root;
  const v2 = resolve(root, 'api', 'v2', 'openapi.yaml');
  const paths = ctx.major === 1
    ? ['/v1/runs', '/v1/runs/{runId}', '/v1/runs/{runId}/events', '/v1/runs/{runId}/events/poll', '/v1/runs/{runId}/cancel', '/v1/webhooks', '/v1/webhooks/{webhookId}', '/v1/openapi.json']
    : ['/.well-known/openwop', '/runs', '/runs/{runId}', '/runs/{runId}/events', '/runs/{runId}/events/poll', '/runs/{runId}/cancel', '/runs:bulk-cancel', '/runs/{runId}:pause', '/runs/{runId}:resume', '/runs/{runId}:fork', '/runs/{runId}/ancestry', '/runs/{runId}/annotations', '/runs/{runId}/compensation', '/runs/{runId}/effects', '/runs/{runId}/interrupts/{nodeId}', '/interrupts/{token}', '/webhooks', '/webhooks/{webhookId}', '/host/effect-seams', '/host/events', '/packs'];
  return { status: 200, body: { openapi: '3.1.0', info: { title: `OpenWOP v${ctx.major} — ${ctx.host.config.host}`, version: ctx.major === 1 ? V1_VERSION : V2_VERSION, description: ctx.major === 2 ? `The canonical document is @openwop/spec-artifacts ${ctx.host.artifacts.version} api/v2/openapi.yaml (${existsSync(v2) ? 'installed' : 'not installed'}); this host serves the path keys listed.` : 'v1 path keys served through the overlap.' }, paths: Object.fromEntries(paths.map((p) => [p, {}])) } };
}

/** events.md §Host events — the heartbeat channel at /host/events (content-free of run data). */
async function hostEvents(ctx: Ctx): Promise<Reply | typeof STREAMED> {
  ctx.res.writeHead(200, { ...ctx.responseHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let tick = 0;
  const send = (): void => {
    const payload = { heartbeatId: 'host-liveness', status: 'ok', changed: false };
    ctx.host.validate('heartbeat-evaluated', payload, 'heartbeat');
    ctx.res.write(`id: ${tick++}\nevent: heartbeat.evaluated\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  send();
  const timer = setInterval(send, 5000);
  ctx.res.on('close', () => clearInterval(timer));
  return STREAMED;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startHost().then((running) => {
    const c = running.host.config;
    process.stdout.write(`openwop-host-v2-reference listening on http://${c.host}:${running.port} (protocolVersions ${SERVED_VERSIONS.join(', ')}; preferredVersion ${c.preferredVersion}${V1_RETIRED ? ' — V1 RETIRED' : ''}; db ${c.dbPath}; fixtures ${running.host.workflows.size}; seams ${c.seamsProfile ? 'mounted' : 'off'}; spec-artifacts ${running.host.artifacts.version})\n`);
    if (durabilitySeamMounted(running.host)) process.stdout.write('  RFC 0158 DURABILITY SEAM MOUNTED — POST /host/durability/kill terminates this process (OPENWOP_DURABILITY_SEAM); never set this in production\n');
    const stop = (): void => { void running.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e: unknown) => { process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`); process.exit(1); });
}
