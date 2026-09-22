/**
 * RFC 0204 — the v2 `ctx.mcp` client (`spec/v2/core/host-services.md` §`mcp`).
 *
 * What pack code gets when this host advertises `mcp.client`:
 *
 *   callTool({ serverId, name, arguments?, idempotencyKey })
 *       → the server's `CallToolResult` UNALTERED — `content[]`,
 *         `structuredContent`, `isError`, `_meta` — including `isError: true`
 *         (a tool error is a result). An `InputRequiredResult` is handled here
 *         (MRTR, capped by `mcp.mrtr.maxRounds`) and never returned.
 *   listTools({ serverId, cursor? })
 *       → ONE `ListToolsResult` page unaltered; a pack's cursor is forwarded.
 *   readResource({ serverId, uri }) → the `ReadResourceResult` unaltered.
 *   serverHealth({ serverId })
 *       → `{ state: reachable | unreachable | incompatible, discover? }` from a
 *         `server/discover` probe no older than its `ttlMs`. Never a connection
 *         or session state: MCP 2026-07-28 has neither.
 *
 * Each call rejects ONLY for an unknown `serverId` (`not_found`), an MCP error
 * response (`mcp_error`, the MCP `Error` carried unaltered in
 * `details.error`), or a transport failure (`mcp_unreachable`).
 *
 * The transport is the same guarded egress path every other outbound call
 * uses, and the revision is decided by the same `decide()` and audited with
 * the same `negotiation.decided` event as the §23 seam — on the calling run's
 * own log, so the decision a pack's call rode on is visible where the call is.
 *
 * Servers are host-configured: `OPENWOP_MCP_SERVERS=id=url,id=url`. The
 * conformance operator contract binds `conformance` to the suite's fake MCP
 * server and `conformance.down` to an address nothing answers
 * (`conformance/fixtures.md` §"The ctx.mcp fixture").
 */
import { guardedRequest } from './egress.js';
import { MCP_FACET, audit, decide } from './interop.js';
import type { Host } from './host.js';
import type { RunRow } from './store.js';
import { childOf, runTraceContext, traceFields, traceHeaders, type TraceContext } from './trace-context.js';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';

export class McpClientError extends Error {
  constructor(readonly code: 'not_found' | 'mcp_error' | 'mcp_unreachable' | 'interop_version_unsupported' | 'mcp_mrtr_rounds_exceeded', message: string, readonly details?: Record<string, unknown>) { super(message); }
}

/** `mcp.client` is advertised only when the INSTALLED contract defines it (the host implements the contract it ships) and at least one server is bound. */
export function mcpClientAdvertised(host: Host): boolean {
  return host.artifacts.mcpClientFacet && host.config.mcpServers.size > 0;
}

type Json = Record<string, unknown>;
interface Answer { readonly ok: true; readonly result: Json }
interface Failure { readonly ok: false; readonly error: McpClientError }

async function rpc(host: Host, url: string, method: string, params: Json, revision: string, extraHeaders: Record<string, string> = {}): Promise<Answer | Failure> {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await guardedRequest(new URL(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': revision, 'Mcp-Method': method, ...extraHeaders },
    body: JSON.stringify(body),
    timeoutMs: 5000,
    allowPrivate: host.config.webhookAllowPrivate,
  });
  if (res.status === 0) return { ok: false, error: new McpClientError('mcp_unreachable', `the MCP server did not answer ${method}: ${res.error ?? 'transport failure'}`) };
  let json: Json | null = null;
  try { json = res.body ? (JSON.parse(res.body) as Json) : null; } catch { json = null; }
  const error = json?.['error'];
  if (error !== undefined && error !== null) return { ok: false, error: new McpClientError('mcp_error', `the MCP server answered ${method} with an error`, { error }) };
  const result = json?.['result'];
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return { ok: false, error: new McpClientError('mcp_unreachable', `the MCP server answered ${method} with HTTP ${res.status} and no JSON-RPC result`) };
  return { ok: true, result: result as Json };
}

/** One `server/discover` probe per server, reused while younger than its `ttlMs`. */
interface Probe { readonly at: number; readonly ttlMs: number; readonly outcome: Answer | Failure }
const probes = new Map<string, Probe>();

async function discover(host: Host, serverId: string, url: string, fresh = false): Promise<Answer | Failure> {
  const hit = probes.get(`${serverId}\u0000${url}`);
  if (!fresh && hit && Date.now() - hit.at < hit.ttlMs) return hit.outcome;
  const outcome = await rpc(host, url, 'server/discover', {}, MCP_FACET.preferredVersion);
  // A failed probe is not cached: `unreachable` is re-measured on every ask.
  const ttlMs = outcome.ok && typeof outcome.result['ttlMs'] === 'number' ? Math.max(0, outcome.result['ttlMs'] as number) : 0;
  probes.set(`${serverId}\u0000${url}`, { at: Date.now(), ttlMs, outcome });
  return outcome;
}

function bound(host: Host, serverId: unknown): string {
  const url = typeof serverId === 'string' ? host.config.mcpServers.get(serverId) : undefined;
  if (url === undefined) throw new McpClientError('not_found', `no MCP server is configured under serverId ${JSON.stringify(serverId)}`, { serverId: serverId ?? null });
  return url;
}

/** Decide the revision for this server and audit the decision on the calling run's log. */
async function negotiate(host: Host, run: RunRow | null, serverId: string, url: string): Promise<string> {
  const d0 = await discover(host, serverId, url);
  if (!d0.ok) {
    // -32022 carries the server's supported[]: that IS its offer.
    const supported = (d0.error.details?.['error'] as { data?: { supported?: unknown } } | undefined)?.data?.supported;
    if (!Array.isArray(supported)) throw d0.error;
    const d = decide(MCP_FACET.revisions, MCP_FACET.preferredVersion, MCP_FACET.minimumRevision, supported.map(String), undefined, true);
    if (run) audit(host, run, 'mcp', url, MCP_FACET.minimumRevision, d);
    if (d.outcome === 'refused') throw new McpClientError('interop_version_unsupported', `mcp negotiation refused: ${d.reason}`, { protocol: 'mcp', supported: [...MCP_FACET.revisions], reason: d.reason });
    return d.version;
  }
  const offers = Array.isArray(d0.result['supportedVersions']) ? (d0.result['supportedVersions'] as unknown[]).map(String) : [];
  const d = decide(MCP_FACET.revisions, MCP_FACET.preferredVersion, MCP_FACET.minimumRevision, offers, undefined, true);
  if (run) audit(host, run, 'mcp', url, MCP_FACET.minimumRevision, d);
  if (d.outcome === 'refused') throw new McpClientError('interop_version_unsupported', `mcp negotiation refused: ${d.reason}`, { protocol: 'mcp', supported: [...MCP_FACET.revisions], reason: d.reason });
  return d.version;
}

/** interop.md §Trace context (RFC 0207): the run's trace rides in BOTH carriers — `_meta` (SHOULD) and the header (see `rpc`). */
const meta = (revision: string, tc: TraceContext | null = null): Json => ({ [META_VERSION]: revision, [META_CLIENT_CAPS]: {}, ...traceFields(tc) });
function unwrap(a: Answer | Failure): Json { if (!a.ok) throw a.error; return a.result; }

export interface CtxMcp {
  callTool(req: { serverId: string; name: string; arguments?: Record<string, unknown>; idempotencyKey: string }): Promise<Json>;
  listTools(req: { serverId: string; cursor?: string }): Promise<Json>;
  readResource(req: { serverId: string; uri: string }): Promise<Json>;
  serverHealth(req: { serverId: string }): Promise<Json>;
}

/** The `ctx.mcp` a node receives. `run` is the calling run (the audit log); null for host-internal reads such as the tool catalog. */
export function createCtxMcp(host: Host, run: RunRow | null): CtxMcp {
  const runTrace = run !== null ? runTraceContext(run.options_json) : null;
  /** One child span per outbound request, the same one in `_meta` and in the header. */
  const span = (): TraceContext | null => (runTrace !== null ? childOf(runTrace) : null);
  return {
    async callTool({ serverId, name, arguments: args }) {
      const url = bound(host, serverId);
      const revision = await negotiate(host, run, serverId, url);
      let tc = span();
      let params: Json = { name, arguments: args ?? {}, _meta: meta(revision, tc) };
      // MRTR (interop.md §The MCP round ceiling): the host answers input_required
      // itself. A pack has no elicitation surface here, so every request is
      // declined; a round past maxRounds is refused and never sent.
      for (let rounds = 0; ; rounds++) {
        const r = unwrap(await rpc(host, url, 'tools/call', params, revision, { 'Mcp-Name': name, ...traceHeaders(tc) }));
        if (r['resultType'] !== 'input_required') return r;
        if (rounds + 1 > MCP_FACET.mrtr.maxRounds) throw new McpClientError('mcp_mrtr_rounds_exceeded', `MRTR round ${rounds + 1} exceeds mcp.mrtr.maxRounds ${MCP_FACET.mrtr.maxRounds}`, { maxRounds: MCP_FACET.mrtr.maxRounds });
        const requests = (r['inputRequests'] ?? {}) as Json;
        const inputResponses = Object.fromEntries(Object.keys(requests).map((k) => [k, { action: 'decline' }]));
        tc = span();
        params = { name, arguments: args ?? {}, inputResponses, requestState: r['requestState'], _meta: meta(revision, tc) };
      }
    },
    async listTools({ serverId, cursor }) {
      const url = bound(host, serverId);
      const revision = await negotiate(host, run, serverId, url);
      const tc = span();
      return unwrap(await rpc(host, url, 'tools/list', { ...(cursor !== undefined ? { cursor } : {}), _meta: meta(revision, tc) }, revision, traceHeaders(tc)));
    },
    async readResource({ serverId, uri }) {
      const url = bound(host, serverId);
      const revision = await negotiate(host, run, serverId, url);
      const tc = span();
      return unwrap(await rpc(host, url, 'resources/read', { uri, _meta: meta(revision, tc) }, revision, traceHeaders(tc)));
    },
    async serverHealth({ serverId }) {
      const url = bound(host, serverId);
      const probe = await discover(host, serverId, url);
      if (!probe.ok) {
        // A server that ANSWERED -32022 is reachable at a revision this host does not speak.
        const answered = probe.error.code === 'mcp_error';
        return { state: answered ? 'incompatible' : 'unreachable' };
      }
      const offers = Array.isArray(probe.result['supportedVersions']) ? (probe.result['supportedVersions'] as unknown[]).map(String) : [];
      const d = decide(MCP_FACET.revisions, MCP_FACET.preferredVersion, MCP_FACET.minimumRevision, offers, undefined, true);
      return { state: d.outcome === 'accepted' ? 'reachable' : 'incompatible', discover: probe.result };
    },
  };
}

/** Test hook: forget every cached probe. */
export function resetMcpProbes(): void { probes.clear(); }
