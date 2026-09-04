/**
 * OpenWOP v2 reference host — node:http, no framework. Boots the store, loads
 * the contract, mounts the routes (discovery, runs, webhooks, packs, seams,
 * host events) and starts the delivery worker.
 *
 *   npm start            → http://127.0.0.1:3838
 *   OPENWOP_API_KEY      → the default api-key credential (openwop-v2-dev-key)
 */
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from './artifacts.js';
import { loadConfig, type HostConfig, PKG_ROOT, V1_VERSION, V2_VERSION } from './config.js';
import { etagOf, v1Document, v2Document } from './discovery.js';
import { err } from './errors.js';
import { ensureDefaultCredential } from './identity.js';
import { route, Router, STREAMED, type Ctx, type Reply } from './router.js';
import { runRoutes } from './runs.js';
import { seamRoutes } from './seams.js';
import { Store } from './store.js';
import { createValidator } from './validate.js';
import { deadLetterProjection, registerWebhook, startDeliveryWorker, subscribeFanout, unregisterWebhook } from './webhooks.js';
import { installedPacks } from './packs.js';
import { withIdempotency } from './router.js';
import { scheduleRun } from './executor.js';
import type { Host, WorkflowDefinition } from './host.js';

/** The fixture catalog: the suite's `fixtures/` (conformance package) plus the host-defined approvers fixture. */
export function loadWorkflows(config: HostConfig): Map<string, WorkflowDefinition> {
  const executable = new Set(['core.noop', 'core.delay', 'core.fail', 'core.approvalGate', 'core.clarificationGate', 'core.interrupt', 'core.httpFetch']);
  // The fixtures whose SEMANTICS this host honours end to end (not merely whose node types it recognises).
  const honoured = new Set(['conformance-noop', 'conformance-delay', 'conformance-cancellable', 'conformance-idempotent', 'conformance-multi-node', 'conformance-failure', 'conformance-approval', 'conformance-clarification', 'conformance-interrupt-external-event']);
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
  out.set('conformance-http-effect', {
    id: 'conformance-http-effect', name: 'Reference: http.fetch effect seam', version: '1.0',
    nodes: [{ id: 'fetch', typeId: 'core.httpFetch', config: { url: 'https://example.invalid/effect', method: 'POST', body: { hello: 'world' }, compensation: { irreversibleEffect: false } }, inputs: {} }],
    edges: [], variables: [], metadata: { tags: ['reference'] },
  });
  return out;
}

export interface RunningHost { host: Host; server: Server; port: number; close(): Promise<void> }

export async function startHost(overrides: Partial<HostConfig> = {}): Promise<RunningHost> {
  const config = loadConfig(overrides);
  const artifacts = loadArtifacts();
  const store = new Store(config.dbPath);
  const validate = await createValidator(artifacts.schemasDir, config.devValidate);
  const host: Host = { config, store, artifacts, bus: new EventEmitter(), workflows: loadWorkflows(config), startedAt: new Date().toISOString(), validate };
  host.bus.setMaxListeners(0);
  ensureDefaultCredential(host);

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
      return withIdempotency(ctx, 'registerWebhook', text, async () => ({ status: 201, body: registerWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, (text.trim() === '' ? {} : JSON.parse(text)) as Record<string, unknown>) }));
    }),
    route('DELETE', '/webhooks/{webhookId}', true, async (ctx) => { unregisterWebhook(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string); return { status: 204 }; }),
    route('GET', '/webhooks/{webhookId}/dead-letters', true, async (ctx) => ({ status: 200, body: deadLetterProjection(ctx.host, ctx.subject?.tenant ?? config.tenant, ctx.params['webhookId'] as string) })),
    ...runRoutes(),
    ...seamRoutes(host),
  );
  subscribeFanout(host);
  const stopWorker = startDeliveryWorker(host);
  // Runs left non-terminal by a previous process re-enter the loop (durability across restart).
  for (const r of store.nonTerminalRuns()) if ((r.era ?? 2) >= 3 && (r.status === 'running' || r.status === 'pending' || r.status === 'cancelling')) scheduleRun(host, r.run_id);

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
  const doc = ctx.major === 2 ? v2Document(ctx.host) : v1Document(ctx.host);
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
    ? ['/v1/runs', '/v1/runs/{runId}', '/v1/runs/{runId}/events', '/v1/runs/{runId}/events/poll', '/v1/runs/{runId}/cancel', '/v1/openapi.json']
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
    process.stdout.write(`openwop-host-v2-reference listening on http://${c.host}:${running.port} (protocolVersions ${V1_VERSION}, ${V2_VERSION}; preferredVersion ${c.preferredVersion}; db ${c.dbPath}; fixtures ${running.host.workflows.size}; seams ${c.seamsProfile ? 'mounted' : 'off'}; spec-artifacts ${running.host.artifacts.version})\n`);
    const stop = (): void => { void running.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e: unknown) => { process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`); process.exit(1); });
}
