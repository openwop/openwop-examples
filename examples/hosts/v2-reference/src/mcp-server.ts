/**
 * RFC 0208 — the host as an MCP 2026-07-28 SERVER: one streamable-HTTP mount,
 * held to the `mcp.*` rows of `spec/v2/interop-map.json`. interop.ts is the
 * host's MCP CLIENT; this is the other half.
 *
 *   POST /mcp    JSON-RPC 2.0, authenticated (the normal Bearer credential)
 *
 * Stateless by construction: no `initialize`, no `Mcp-Session-Id`. Every
 * request carries its revision twice (the `MCP-Protocol-Version` header and
 * `_meta["io.modelcontextprotocol/protocolVersion"]`) and they MUST agree —
 * checked BEFORE version support, so a disagreement is -32020 even when the
 * body names a revision this host does not speak.
 *
 * Tools are the advertised fixtures (tool name = workflowId). `tools/call`
 * starts a run (transport `mcp`) through the REST acceptance path and answers
 * its outcome as a CallToolResult; a run that suspends on an approval or a
 * clarification answers InputRequiredResult (MRTR) with an HMAC-protected,
 * single-use `requestState` bound to the principal, a TTL, the request digest,
 * the run and the interrupt node. The retry resolves the interrupt through the
 * same eligibility-checked path REST `resolveInterruptByRun` uses.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HOST_NAME, HOST_VERSION } from './config.js';
import { HostError } from './errors.js';
import { requestCancel, resolveAndResume, scheduleRun } from './executor.js';
import { principalRef } from './identity.js';
import { opaque } from './ids.js';
import { payloadOf } from './interrupts.js';
import { MCP_FACET } from './interop.js';
import { acceptRun } from './runs.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import { TERMINAL, type Host, type Subject, type WorkflowDefinition } from './host.js';
import type { RunRow } from './store.js';
import { waitForSettle } from './a2a-server.js';

export const MCP_SERVER_PROFILES = ['mcp-2026-07-28'] as const;
/** Every feature interop-map.json mcp.features requires for mcp-2026-07-28. */
export const MCP_SERVER_FEATURES = ['server-discover', 'mrtr', 'cacheable-lists'] as const;
export const MCP_MOUNT_PATH = '/mcp';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CAPABILITY: -32021,
  UNSUPPORTED_VERSION: -32022,
} as const;

const TTL_MS = 60_000;
const CALL_CAP_MS = 5000;
const REQUEST_STATE_TTL_MS = 10 * 60_000;
const SUSPENDING = new Set(['core.approvalGate', 'core.clarificationGate', 'core.interrupt']);

type RpcId = string | number | null;
class McpError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>, readonly httpStatus = 200) { super(message); }
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function reply(id: RpcId, e: McpError): Reply {
  const error: Record<string, unknown> = { code: e.code, message: e.message };
  if (e.data !== undefined) error['data'] = e.data;
  return { status: e.httpStatus, body: { jsonrpc: '2.0', id, error } };
}

const serverInfo = (): Record<string, unknown> => ({ name: HOST_NAME, version: HOST_VERSION });

// ── tools ──────────────────────────────────────────────────────────────────

function toolDefs(host: Host): WorkflowDefinition[] {
  return [...host.workflows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function inputSchemaOf(def: WorkflowDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const v of def.variables) properties[v.name] = v.defaultValue === undefined ? { description: `workflow variable ${v.name}` } : { description: `workflow variable ${v.name}`, default: v.defaultValue };
  const required = def.variables.filter((v) => v.required === true).map((v) => v.name);
  return { type: 'object', properties, additionalProperties: true, ...(required.length > 0 ? { required } : {}) };
}

function toolsList(host: Host): Record<string, unknown> {
  // The list depends on nothing but this host's registry today, yet it is served
  // under the caller's authorization — private is the honest scope.
  const tools = toolDefs(host).map((def) => ({ name: def.id, description: def.description ?? def.name ?? `Runs the OpenWOP workflow ${def.id}`, inputSchema: inputSchemaOf(def) }));
  return { resultType: 'complete', tools, ttlMs: TTL_MS, cacheScope: 'private' };
}

// ── requestState ───────────────────────────────────────────────────────────

interface StateClaims { v: 1; p: string; e: number; d: string; r: string; n: string; j: string }

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const principalOf = (s: Subject): string => `${s.tenant}|${principalRef(s)}`;
const digestOf = (name: string, args: Record<string, unknown>): string => createHash('sha256').update(`${name}\n${stableJson(args)}`).digest('base64url');
const mac = (host: Host, body: string): string => createHmac('sha256', host.config.mcpStateSecret).update(body).digest('base64url');

function mintState(host: Host, subject: Subject, name: string, args: Record<string, unknown>, runId: string, nodeId: string): string {
  const claims: StateClaims = { v: 1, p: principalOf(subject), e: Date.now() + REQUEST_STATE_TTL_MS, d: digestOf(name, args), r: runId, n: nodeId, j: opaque() };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${mac(host, body)}`;
}

function verifyState(host: Host, subject: Subject, raw: unknown, name: string, args: Record<string, unknown>): StateClaims {
  const bad = (why: string): McpError => new McpError(ERR.INVALID_PARAMS, `requestState refused: ${why}`);
  if (typeof raw !== 'string') throw bad('not a string');
  const dot = raw.indexOf('.');
  if (dot <= 0) throw bad('malformed');
  const body = raw.slice(0, dot); const sig = raw.slice(dot + 1);
  const expect = mac(host, body);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw bad('integrity check failed');
  let claims: StateClaims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StateClaims; } catch { throw bad('malformed'); }
  if (claims.v !== 1 || typeof claims.j !== 'string') throw bad('malformed');
  if (claims.e < Date.now()) throw bad('expired');
  if (claims.p !== principalOf(subject)) throw bad('bound to another principal');
  if (claims.d !== digestOf(name, args)) throw bad('bound to another request');
  return claims;
}

// ── tools/call ─────────────────────────────────────────────────────────────

function textResult(isError: boolean, value: unknown): Record<string, unknown> {
  return { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

/** The run's state at answer time, as MCP sees it (interop-map.json mcp.methods tools/call). */
function outcome(host: Host, subject: Subject, name: string, args: Record<string, unknown>, run: RunRow): Record<string, unknown> {
  if (run.status === 'completed') return textResult(false, { runId: run.run_id, status: run.status, variables: JSON.parse(run.inputs_json) as unknown });
  if (run.status === 'failed' || run.status === 'cancelled') {
    return textResult(true, { runId: run.run_id, status: run.status, ...(run.error_json !== null ? { error: JSON.parse(run.error_json) as unknown } : {}) });
  }
  if ((run.status === 'waiting-approval' || run.status === 'waiting-input') && run.current_node_id !== null) {
    const pending = host.store.pendingInterruptForNode(run.run_id, run.current_node_id);
    if (pending) {
      const payload = payloadOf(pending);
      const data = payload.data ?? {};
      let requestedSchema: Record<string, unknown>;
      let message: string;
      if (payload.kind === 'approval') {
        const actions = Array.isArray(data['actions']) ? (data['actions'] as unknown[]).map(String) : ['accept', 'reject'];
        requestedSchema = { type: 'object', properties: { action: { type: 'string', enum: actions } }, required: ['action'] };
        message = [data['title'], data['description']].filter((s) => typeof s === 'string').join(' — ') || `Approve ${pending.node_id}`;
      } else {
        const questions = Array.isArray(data['questions']) ? (data['questions'] as Array<{ id?: unknown; question?: unknown }>) : [];
        const properties: Record<string, unknown> = {};
        for (const q of questions) if (typeof q.id === 'string') properties[q.id] = { type: 'string', description: String(q.question ?? q.id) };
        requestedSchema = { type: 'object', properties, required: Object.keys(properties) };
        message = questions.map((q) => String(q.question ?? '')).filter((s) => s.length > 0).join(' ') || `Input for ${pending.node_id}`;
      }
      return {
        resultType: 'input_required',
        inputRequests: { [pending.node_id]: { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema } } },
        requestState: mintState(host, subject, name, args, run.run_id, pending.node_id),
      };
    }
  }
  // waiting-external, or still moving at the cap: no MRTR form fits; the caller follows the run over REST.
  return textResult(true, { runId: run.run_id, status: run.status, message: `the run is ${run.status}; follow it at GET /runs/{runId}` });
}

async function toolsCall(host: Host, subject: Subject, params: Record<string, unknown>, caps: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = params['name'];
  if (typeof name !== 'string' || !host.workflows.has(name)) throw new McpError(ERR.INVALID_PARAMS, `unknown tool ${String(name)}`);
  const def = host.workflows.get(name) as WorkflowDefinition;
  const rawArgs = params['arguments'] === undefined ? {} : params['arguments'];
  // arguments are validated against the tool's inputSchema BEFORE any run is created.
  if (!isObject(rawArgs)) throw new McpError(ERR.INVALID_PARAMS, 'arguments MUST be an object (the tool inputSchema is type object)');
  for (const v of def.variables) if (v.required === true && rawArgs[v.name] === undefined && v.defaultValue === undefined) throw new McpError(ERR.INVALID_PARAMS, `arguments.${v.name} is required by the tool inputSchema`);
  // A tool that can suspend needs elicitation to be answerable; it is never assumed.
  if (def.nodes.some((n) => SUSPENDING.has(n.typeId)) && !isObject(caps['elicitation'])) {
    throw new McpError(ERR.MISSING_CAPABILITY, `tool ${name} can suspend for input and the request did not declare the elicitation client capability`, { requiredCapabilities: ['elicitation'] });
  }

  if (params['requestState'] === undefined) {
    const inputs = { ...Object.fromEntries(def.variables.filter((v) => v.defaultValue !== undefined).map((v) => [v.name, v.defaultValue])), ...rawArgs };
    const run = acceptRun(host, subject, name, inputs, { transport: 'mcp' }, null);
    scheduleRun(host, run.run_id);
    return outcome(host, subject, name, rawArgs, (await waitForSettle(host, run.run_id, CALL_CAP_MS)) ?? run);
  }

  const claims = verifyState(host, subject, params['requestState'], name, rawArgs);
  const responses = params['inputResponses'];
  if (!isObject(responses)) throw new McpError(ERR.INVALID_PARAMS, 'a retry carries inputResponses');
  const response = responses[claims.n];
  if (!isObject(response) || typeof response['action'] !== 'string') throw new McpError(ERR.INVALID_PARAMS, `inputResponses.${claims.n} MUST be an ElicitResult`);
  // Single use: consumed before it acts, atomically — a second retry with it fails.
  if (!host.store.consumeMcpRequestState(claims.j)) throw new McpError(ERR.INVALID_PARAMS, 'requestState refused: already used');
  const run = host.store.getRun(claims.r);
  if (!run || run.tenant !== subject.tenant) throw new McpError(ERR.INVALID_PARAMS, 'requestState refused: its run is not readable');
  if (TERMINAL.has(run.status)) return outcome(host, subject, name, rawArgs, run);
  const action = response['action'];
  if (action === 'cancel') {
    requestCancel(host, run, 'mcp-elicitation-cancelled');
  } else {
    const pending = host.store.pendingInterruptForNode(run.run_id, claims.n);
    if (!pending) throw new McpError(ERR.INVALID_PARAMS, 'requestState refused: its interrupt is no longer open');
    let resumeValue: unknown;
    if (action === 'accept') resumeValue = response['content'];
    else if (action === 'decline') resumeValue = pending.kind === 'approval' ? { action: 'reject' } : { declined: true };
    else throw new McpError(ERR.INVALID_PARAMS, 'ElicitResult.action is accept | decline | cancel');
    // The REST resolve path: validation, approver eligibility, the atomic claim, the log. Content never becomes authority.
    resolveAndResume(host, run, pending, resumeValue, subject);
  }
  return outcome(host, subject, name, rawArgs, (await waitForSettle(host, run.run_id, CALL_CAP_MS)) ?? run);
}

// ── the mount ──────────────────────────────────────────────────────────────

async function dispatch(host: Host, subject: Subject, method: string, params: Record<string, unknown>, caps: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (method) {
    case 'server/discover':
      return { resultType: 'complete', supportedVersions: [...MCP_FACET.revisions], capabilities: { tools: {} }, serverInfo: serverInfo(), ttlMs: TTL_MS, cacheScope: 'private', _meta: { [META_SERVER_INFO]: serverInfo() } };
    case 'tools/list':
      return toolsList(host);
    case 'tools/call':
      return toolsCall(host, subject, params, caps);
    default:
      // initialize is never required (and not served); prompts/* and resources/* are not offered.
      throw new McpError(ERR.METHOD_NOT_FOUND, `method ${method} is not served on this mount`);
  }
}

async function mcpHandler(ctx: Ctx): Promise<Reply> {
  const subject = ctx.subject;
  if (subject === null) return reply(null, new McpError(ERR.INTERNAL, 'the mount is authenticated'));
  let parsed: unknown;
  try { parsed = JSON.parse((await ctx.raw()).toString('utf8')); } catch { return reply(null, new McpError(ERR.PARSE, 'the request body is not JSON', undefined, 400)); }
  if (!isObject(parsed) || parsed['jsonrpc'] !== '2.0' || typeof parsed['method'] !== 'string') return reply(null, new McpError(ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 request', undefined, 400));
  const method = parsed['method'];
  const rawId = parsed['id'];
  const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const params = parsed['params'] === undefined ? {} : parsed['params'];
  if (!isObject(params)) return reply(id, new McpError(ERR.INVALID_PARAMS, 'params MUST be an object'));
  const meta = isObject(params['_meta']) ? params['_meta'] : {};
  const supported: string[] = [...MCP_FACET.revisions];

  // (1) the header is REQUIRED at every revision this mount speaks.
  const header = ctx.header('mcp-protocol-version');
  if (header === null || header.trim() === '') return reply(id, new McpError(ERR.UNSUPPORTED_VERSION, 'MCP-Protocol-Version is required; this mount speaks no header-less revision', { supported, requested: null }, 400));
  const requested = header.trim();
  // (2) header and body MUST agree — checked BEFORE version selection.
  if (meta[META_VERSION] !== requested) return reply(id, new McpError(ERR.HEADER_MISMATCH, `MCP-Protocol-Version ${requested} does not equal _meta ${META_VERSION}`, undefined, 400));
  // (3) Mcp-Method / Mcp-Name mirror the body and fail closed the same way.
  const mcpMethod = ctx.header('mcp-method');
  if (mcpMethod !== null && mcpMethod !== method) return reply(id, new McpError(ERR.HEADER_MISMATCH, `Mcp-Method ${mcpMethod} does not equal method ${method}`, undefined, 400));
  const mcpName = ctx.header('mcp-name');
  if (mcpName !== null) {
    const named = method === 'resources/read' ? params['uri'] : params['name'];
    if ((method === 'tools/call' || method === 'prompts/get' || method === 'resources/read') && mcpName !== named) {
      return reply(id, new McpError(ERR.HEADER_MISMATCH, `Mcp-Name ${mcpName} does not equal the request's ${method === 'resources/read' ? 'uri' : 'name'}`, undefined, 400));
    }
  }
  // (4) only now: is the (agreed) revision one this mount speaks?
  if (!supported.includes(requested)) return reply(id, new McpError(ERR.UNSUPPORTED_VERSION, `revision ${requested} is not served`, { supported, requested }, 400));

  if (rawId === undefined && method.startsWith('notifications/')) return { status: 202 };
  // Unknown _meta keys and clientCapabilities.extensions are opaque: never refused, never honoured.
  const caps = isObject(meta[META_CLIENT_CAPS]) ? meta[META_CLIENT_CAPS] : {};
  try {
    const result = await dispatch(ctx.host, subject, method, params, caps);
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
  } catch (e) {
    if (e instanceof McpError) return reply(id, e);
    if (e instanceof HostError) return reply(id, new McpError(e.status >= 500 ? ERR.INTERNAL : ERR.INVALID_PARAMS, e.message));
    process.stderr.write(`[mcp] ${String((e as Error)?.stack ?? e)}\n`);
    return reply(id, new McpError(ERR.INTERNAL, 'the host failed to serve the request'));
  }
}

export function mcpServerRoutes(): Route[] {
  return [route('POST', MCP_MOUNT_PATH, true, mcpHandler, 'both')];
}
