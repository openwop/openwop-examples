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
 *
 * RFC 0198 — the MCP Tasks extension (`io.modelcontextprotocol/tasks`,
 * revision 2026-07-28) and the disconnect rule (`interop.md` §"MCP tasks and
 * cancellation"; interop-map.json `mcp.tasks`):
 *
 *   - `server/discover` lists the extension; a `tools/call` that declares it is
 *     answered `CreateTaskResult` whenever the run is not terminal (never
 *     `InputRequiredResult`). `taskId` IS the run's projected tenant-bound
 *     `runId` (144-bit opaque segment) — no second id namespace, never a credential.
 *   - `tasks/get` / `tasks/update` / `tasks/cancel` are `getRun` /
 *     `resolveInterruptByRun` / `cancelRun` under the caller's Subject; an
 *     unreadable task is `-32602` exactly as a nonexistent one (one message, no
 *     data). `tasks/get` appends nothing. `subscriptions/listen` acknowledges only
 *     readable task ids and notifies only those.
 *   - Until the host has sent its WHOLE response to a request that starts or
 *     continues a run, the run belongs to that request: the connection closing
 *     first cancels it (`run.cancelled.reason: mcp-request-cancelled`). Once
 *     the response is sent, no disconnect touches the run.
 *   - The host never sends `notifications/cancelled` (it never tears down a
 *     `subscriptions/listen` stream on its own); a cancelled blocking call is
 *     answered `CallToolResult { isError: true }`.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HOST_NAME, HOST_VERSION } from './config.js';
import { HostError, err } from './errors.js';
import { requestCancel, resolveAndResume, scheduleRun } from './executor.js';
import { principalRef } from './identity.js';
import { opaque } from './ids.js';
import { payloadOf } from './interrupts.js';
import { MCP_FACET } from './interop.js';
import { inboundTraceContext, type TraceContext } from './trace-context.js';
import { acceptRun } from './runs.js';
import { projectBoundId, TENANT_BOUND, unprojectBoundId } from './ids.js';
import { route, STREAMED, type Ctx, type Reply, type Route } from './router.js';
import { TERMINAL, type Host, type Subject, type WorkflowDefinition } from './host.js';
import type { InterruptRow, RunRow } from './store.js';
import { waitForSettle } from './a2a-server.js';
import { OAUTH_USE_TYPE, credentialResolves, publicBase, subjectKey } from './oauth.js';
import { ownerOf } from './events.js';

export const MCP_SERVER_PROFILES = ['mcp-2026-07-28'] as const;
/** Every feature interop-map.json mcp.features requires for mcp-2026-07-28. */
export const MCP_SERVER_FEATURES = ['server-discover', 'mrtr', 'cacheable-lists', 'extensions'] as const;
/** RFC 0198 — the one MCP extension this mount serves; `extensions` in MCP_SERVER_FEATURES says to look at server/discover. */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** run-event-payloads runCancelled.reason — the MCP request that owned the run was cancelled or disconnected before the host answered it. */
export const MCP_REQUEST_CANCELLED = 'mcp-request-cancelled';
export const MCP_MOUNT_PATH = '/mcp';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const META_SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId';

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
/** A blocking call answered over SSE holds the stream open this long before it answers "still running". */
const SSE_CALL_CAP_MS = 60_000;
const TASK_POLL_INTERVAL_MS = 500;
const REQUEST_STATE_TTL_MS = 10 * 60_000;
const SUSPENDING = new Set(['core.approvalGate', 'core.clarificationGate', 'core.interrupt', OAUTH_USE_TYPE]);

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

/** The interrupt a waiting run is suspended on, if one is open. */
function openInterrupt(host: Host, run: RunRow): InterruptRow | undefined {
  if ((run.status !== 'waiting-approval' && run.status !== 'waiting-input') || run.current_node_id === null) return undefined;
  return host.store.pendingInterruptForNode(run.run_id, run.current_node_id);
}

const PRIMITIVE = new Set(['string', 'number', 'integer', 'boolean']);
/**
 * RFC 0199 §D.2(d) / MCP Elicitation §Requested Schema: form mode carries only a
 * flat object of primitive properties, and never a sensitive one (writeOnly or
 * format password — invariant elicitation-form-no-secret).
 */
export function formEligible(schema: Record<string, unknown>): boolean {
  if (schema['type'] !== 'object' || !isObject(schema['properties'])) return false;
  return Object.values(schema['properties']).every((p) => isObject(p) && PRIMITIVE.has(String(p['type'])) && p['writeOnly'] !== true && p['format'] !== 'password' && !('properties' in p) && !('items' in p));
}
const declaresUrlMode = (caps: Record<string, unknown>): boolean => isObject(caps['elicitation']) && isObject(caps['elicitation']['url']);

/** A host-owned page that resolves one interrupt for its Subject (the URL-mode target for a schema form mode may not carry). */
function interruptPageFor(host: Host, run: RunRow, pending: InterruptRow): string {
  const id = randomBytes(24).toString('base64url');
  host.store.db.prepare('INSERT INTO interrupt_pages (page_id, run_id, node_id, subject_key) VALUES (?, ?, ?, ?)').run(id, run.run_id, pending.node_id, subjectKey(ownerOf(host, run).subject));
  return `${publicBase(host)}/interrupt-pages/${id}`;
}

/**
 * The interop-map.json mcp.mrtr InputRequiredResult projection of one open
 * interrupt (RFC 0199 §D.2). Form mode only for a flat, non-sensitive schema;
 * a `credential` interrupt and any other schema go to URL mode when the
 * request declared `elicitation.url`; otherwise `null` — the caller answers
 * CallToolResult isError and never falls back to form mode.
 */
function elicitationFor(host: Host, run: RunRow, pending: InterruptRow, caps: Record<string, unknown>): Record<string, unknown> | null {
  const payload = payloadOf(pending);
  const data = payload.data ?? {};
  if (payload.kind === 'credential') {
    if (!declaresUrlMode(caps)) return null;
    const scopes = Array.isArray(data['scopes']) ? (data['scopes'] as unknown[]).map(String).join(' ') : '';
    return { method: 'elicitation/create', params: { mode: 'url', message: `Authorize ${String(data['provider'])}${scopes ? ` (${scopes})` : ''}`, url: String(data['connectUrl']) } };
  }
  let requestedSchema: Record<string, unknown>;
  let message: string;
  if (payload.kind === 'approval') {
    const actions = Array.isArray(data['actions']) ? (data['actions'] as unknown[]).map(String) : ['accept', 'reject'];
    requestedSchema = { type: 'object', properties: { action: { type: 'string', enum: actions } }, required: ['action'] };
    message = [data['title'], data['description']].filter((s) => typeof s === 'string').join(' — ') || `Approve ${pending.node_id}`;
  } else {
    const questions = Array.isArray(data['questions']) ? (data['questions'] as Array<{ id?: unknown; question?: unknown; schema?: unknown }>) : [];
    const properties: Record<string, unknown> = {};
    // The question's own answer schema is carried as-is — never flattened to a string,
    // which would put a password (or a nested object) into a plain form field.
    for (const q of questions) if (typeof q.id === 'string') properties[q.id] = isObject(q.schema) ? { ...q.schema, description: String(q.question ?? q.id) } : { type: 'string', description: String(q.question ?? q.id) };
    requestedSchema = { type: 'object', properties, required: Object.keys(properties) };
    message = questions.map((q) => String(q.question ?? '')).filter((s) => s.length > 0).join(' ') || `Input for ${pending.node_id}`;
  }
  if (formEligible(requestedSchema)) return { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema } };
  if (!declaresUrlMode(caps)) return null;
  return { method: 'elicitation/create', params: { mode: 'url', message, url: interruptPageFor(host, run, pending) } };
}

/**
 * An ElicitResult applied to one open interrupt through the REST resolve path
 * (validation, approver eligibility, the atomic claim, the log) — shared by the
 * MRTR retry and `tasks/update`. Content never becomes authority.
 */
function applyElicitResult(host: Host, subject: Subject, run: RunRow, pending: InterruptRow, response: Record<string, unknown>): void {
  const action = response['action'];
  if (action === 'cancel') { requestCancel(host, run, 'mcp-elicitation-cancelled'); return; }
  let resumeValue: unknown;
  if (action === 'accept') resumeValue = response['content'];
  else if (action === 'decline') resumeValue = pending.kind === 'approval' ? { action: 'reject' } : { declined: true };
  else throw new McpError(ERR.INVALID_PARAMS, 'ElicitResult.action is accept | decline | cancel');
  resolveAndResume(host, run, pending, resumeValue, subject);
}

/** The run's state at answer time, as MCP sees it (interop-map.json mcp.methods tools/call). */
function outcome(host: Host, subject: Subject | null, name: string, args: Record<string, unknown>, run: RunRow, caps: Record<string, unknown> = {}): Record<string, unknown> {
  if (run.status === 'completed') return textResult(false, { runId: run.run_id, status: run.status, variables: JSON.parse(run.inputs_json) as unknown });
  if (run.status === 'failed' || run.status === 'cancelled') {
    return textResult(true, { runId: run.run_id, status: run.status, ...(run.error_json !== null ? { error: JSON.parse(run.error_json) as unknown } : {}) });
  }
  const pending = openInterrupt(host, run);
  if (pending) {
    const request = elicitationFor(host, run, pending, caps);
    if (request === null) {
      // RFC 0199 §D.2(b)/(d): no form fallback. The run stays suspended and resolvable over REST and the token surface.
      const p = payloadOf(pending);
      const why = p.kind === 'credential'
        ? `authorization for ${String((p.data ?? {})['provider'])} is required out of band; this client declared no elicitation.url`
        : 'this input cannot be collected in form mode (not a flat, non-sensitive schema) and this client declared no elicitation.url';
      return textResult(true, { runId: run.run_id, status: run.status, interruptKind: p.kind, message: `${why}; the run is suspended — resolve it at POST /runs/{runId}/interrupts/${pending.node_id}` });
    }
    return {
      resultType: 'input_required',
      inputRequests: { [pending.node_id]: request },
      requestState: mintState(host, subject as Subject, name, args, run.run_id, pending.node_id),
    };
  }
  // waiting-external, or still moving at the cap: no MRTR form fits; the caller follows the run over REST.
  return textResult(true, { runId: run.run_id, status: run.status, message: `the run is ${run.status}; follow it at GET /runs/{runId}` });
}

/** What one HTTP request owns (RFC 0198 §G.12): the run it started or continued, until its response is sent. */
interface RequestOwnership { runId: string | null; capMs: number }

const declaresTasks = (caps: Record<string, unknown>): boolean => isObject(caps['extensions']) && isObject(caps['extensions'][MCP_TASKS_EXTENSION]);

async function toolsCall(host: Host, subject: Subject, params: Record<string, unknown>, caps: Record<string, unknown>, own: RequestOwnership, trace: TraceContext | null): Promise<Record<string, unknown>> {
  const tasked = declaresTasks(caps);
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
    const run = acceptRun(host, subject, name, inputs, { transport: 'mcp', ...(trace !== null ? { traceContext: trace } : {}) }, null);
    own.runId = run.run_id;
    scheduleRun(host, run.run_id);
    // RFC 0198 §B.3: the run row is durable (acceptRun), so tasks/get already
    // resolves — answer the handle now unless the run is somehow terminal.
    if (tasked) {
      const now = host.store.getRun(run.run_id) ?? run;
      return TERMINAL.has(now.status) ? outcome(host, subject, name, rawArgs, now, caps) : { resultType: 'task', ...taskOf(host, now, false) };
    }
    return outcome(host, subject, name, rawArgs, (await waitForSettle(host, run.run_id, own.capMs)) ?? run, caps);
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
  if (TERMINAL.has(run.status)) return outcome(host, subject, name, rawArgs, run, caps);
  // "Continues" (RFC 0198 §G.12): the retry owns the run until it is answered.
  own.runId = run.run_id;
  if (response['action'] === 'cancel') requestCancel(host, run, 'mcp-elicitation-cancelled');
  else {
    const pending = host.store.pendingInterruptForNode(run.run_id, claims.n);
    if (!pending) throw new McpError(ERR.INVALID_PARAMS, 'requestState refused: its interrupt is no longer open');
    const kind = payloadOf(pending).kind;
    if (kind === 'credential' && response['action'] === 'accept') {
      // RFC 0199 §D.2(c): URL mode carries no content; an accept is the §C.4 re-check. A credential
      // that now resolves resolves the interrupt; otherwise the answer below is input_required again.
      const data = payloadOf(pending).data ?? {};
      const scopes = Array.isArray(data['scopes']) ? (data['scopes'] as unknown[]).map(String) : [];
      if (credentialResolves(host, subjectKey(ownerOf(host, run).subject), String(data['provider'] ?? ''), scopes)) resolveAndResume(host, run, pending, { outcome: 'authorized' }, subject);
    } else if (kind === 'credential' && response['action'] === 'decline') {
      resolveAndResume(host, run, pending, { outcome: 'declined' }, subject);
    } else if (response['action'] === 'accept' && response['content'] === undefined) {
      // A URL-mode accept for a page-resolved interrupt: the page resolves it; nothing to apply here.
    } else {
      applyElicitResult(host, subject, run, pending, response);
    }
  }
  const settled = (await waitForSettle(host, run.run_id, own.capMs)) ?? run;
  if (tasked && !TERMINAL.has(settled.status)) return { resultType: 'task', ...taskOf(host, settled, false) };
  return outcome(host, subject, name, rawArgs, settled, caps);
}

// ── tasks (RFC 0198) ───────────────────────────────────────────────────────

const TASK_NOT_FOUND = 'task not found';
const taskNotFound = (): McpError => new McpError(ERR.INVALID_PARAMS, TASK_NOT_FOUND);

function requireTasks(caps: Record<string, unknown>): void {
  if (!declaresTasks(caps)) throw new McpError(ERR.MISSING_CAPABILITY, 'Missing required client capability', { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } });
}

/**
 * The run a taskId names, authorized as getRun is for the caller's Subject.
 * Malformed, unknown, purged and another tenant's ids all end here the same
 * way: `-32602 task not found`, no data (RFC 0198 §C.6; mcp-task-tenant-scoped).
 * The REST 403 id_tenant_mismatch is deliberately NOT projected.
 */
function taskRun(host: Host, subject: Subject, raw: unknown): RunRow {
  if (typeof raw !== 'string') throw taskNotFound();
  let id: string;
  try { id = unprojectBoundId(raw); } catch { throw taskNotFound(); }
  if (!TENANT_BOUND.test(id) || id.slice(0, id.indexOf('/')) !== subject.tenant) throw taskNotFound();
  const run = host.store.getRun(id);
  if (!run || run.tenant !== subject.tenant) throw taskNotFound();
  return run;
}

/** interop-map.json mcp.tasks.status — the run projected as an MCP Task (DetailedTask when `detailed`). */
function taskOf(host: Host, run: RunRow, detailed: boolean, caps: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { taskId: projectBoundId(run.run_id), createdAt: run.created_at, lastUpdatedAt: run.updated_at, ttlMs: null, pollIntervalMs: TASK_POLL_INTERVAL_MS, statusMessage: `the run is ${run.status}` };
  if (run.status === 'completed' || run.status === 'failed') {
    // A failed run is a tool outcome: completed + isError true; `failed` is reserved for a JSON-RPC error.
    if (!detailed) return { ...base, status: 'completed' };
    const { resultType: _discard, ...result } = outcome(host, null, '', {}, run);
    return { ...base, status: 'completed', result };
  }
  if (run.status === 'cancelled') return { ...base, status: 'cancelled' };
  const pending = openInterrupt(host, run);
  if (pending) {
    // One inputRequests entry per open interrupt, keyed by interruptId (unique over the task's lifetime by construction).
    const request = detailed ? elicitationFor(host, run, pending, caps) : null;
    return request !== null ? { ...base, status: 'input_required', inputRequests: { [pending.interrupt_id]: request } } : { ...base, status: 'input_required' };
  }
  return { ...base, status: 'working' };
}

function tasksGet(host: Host, subject: Subject, params: Record<string, unknown>, caps: Record<string, unknown> = {}): Record<string, unknown> {
  // A read: nothing is appended to the run's log.
  return { resultType: 'complete', ...taskOf(host, taskRun(host, subject, params['taskId']), true, caps) };
}

function tasksUpdate(host: Host, subject: Subject, params: Record<string, unknown>): Record<string, unknown> {
  const run = taskRun(host, subject, params['taskId']);
  const responses = params['inputResponses'];
  if (!isObject(responses)) throw new McpError(ERR.INVALID_PARAMS, 'tasks/update carries inputResponses');
  for (const [key, response] of Object.entries(responses)) {
    const current = host.store.getRun(run.run_id) ?? run;
    if (TERMINAL.has(current.status)) break;
    // A key already answered, never issued, or no longer open resolves nothing.
    const pending = openInterrupt(host, current);
    if (!pending || pending.interrupt_id !== key || !isObject(response) || typeof response['action'] !== 'string') continue;
    try {
      applyElicitResult(host, subject, current, pending, response);
    } catch (e) {
      // An ineligible approver, a lost race or an invalid value resolves nothing; the ack is eventually consistent.
      if (!(e instanceof HostError) && !(e instanceof McpError)) throw e;
    }
  }
  return { resultType: 'complete' };
}

function tasksCancel(host: Host, subject: Subject, params: Record<string, unknown>): Record<string, unknown> {
  const run = taskRun(host, subject, params['taskId']);
  // On a terminal run it is acknowledged and nothing is appended (RFC 0194 §A.2).
  if (!TERMINAL.has(run.status)) {
    try { requestCancel(host, run, undefined); } catch (e) { if (!(e instanceof HostError)) throw e; }
  }
  return { resultType: 'complete' };
}

/** subscriptions/listen with `notifications.taskIds`: an SSE stream that acknowledges only readable ids and notifies only those. */
function subscriptionsListen(ctx: Ctx, subject: Subject, id: RpcId, params: Record<string, unknown>, caps: Record<string, unknown>): typeof STREAMED {
  const host = ctx.host;
  const filter = isObject(params['notifications']) ? params['notifications'] : {};
  const requested = Array.isArray(filter['taskIds']) ? filter['taskIds'] : [];
  const readable: string[] = [];
  for (const raw of requested) {
    try { readable.push(projectBoundId(taskRun(host, subject, raw).run_id)); } catch { /* unreadable ≡ nonexistent: left out */ }
  }
  const meta = { [META_SUBSCRIPTION]: id };
  ctx.res.writeHead(200, { ...ctx.responseHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const frame = (msg: Record<string, unknown>): void => { ctx.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
  frame({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: meta, notifications: declaresTasks(caps) ? { taskIds: readable } : {} } });
  const last = new Map<string, string>();
  const tick = (): void => {
    for (const taskId of readable) {
      const run = host.store.getRun(unprojectBoundId(taskId));
      if (!run) continue;
      const task = taskOf(host, run, true);
      const seen = `${String(task['status'])}|${String(task['lastUpdatedAt'])}`;
      if (last.get(taskId) === seen) continue;
      last.set(taskId, seen);
      frame({ jsonrpc: '2.0', method: 'notifications/tasks', params: { ...task, _meta: meta } });
    }
  };
  tick();
  const timer = setInterval(tick, TASK_POLL_INTERVAL_MS);
  ctx.res.on('close', () => clearInterval(timer));
  return STREAMED;
}

// ── the mount ──────────────────────────────────────────────────────────────

async function dispatch(host: Host, subject: Subject, method: string, params: Record<string, unknown>, caps: Record<string, unknown>, own: RequestOwnership, trace: TraceContext | null): Promise<Record<string, unknown>> {
  switch (method) {
    case 'server/discover':
      return { resultType: 'complete', supportedVersions: [...MCP_FACET.revisions], capabilities: { tools: {}, extensions: { [MCP_TASKS_EXTENSION]: {} } }, serverInfo: serverInfo(), ttlMs: TTL_MS, cacheScope: 'private', _meta: { [META_SERVER_INFO]: serverInfo() } };
    case 'tools/list':
      return toolsList(host);
    case 'tools/call':
      return toolsCall(host, subject, params, caps, own, trace);
    case 'tasks/get':
      requireTasks(caps);
      return tasksGet(host, subject, params, caps);
    case 'tasks/update':
      requireTasks(caps);
      return tasksUpdate(host, subject, params);
    case 'tasks/cancel':
      requireTasks(caps);
      return tasksCancel(host, subject, params);
    default:
      // initialize is never required (and not served); prompts/* and resources/* are not offered.
      throw new McpError(ERR.METHOD_NOT_FOUND, `method ${method} is not served on this mount`);
  }
}

/** Streamable HTTP lets the server pick JSON or SSE; this mount answers a blocking call as SSE when the client ranks text/event-stream first. */
const prefersSse = (accept: string | null): boolean => (accept ?? '').split(',')[0]?.trim().toLowerCase().startsWith('text/event-stream') === true;

async function mcpHandler(ctx: Ctx): Promise<Reply | typeof STREAMED> {
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
    // ext-tasks §Streamable HTTP: Routing Headers — Mcp-Name is params.taskId on tasks/*.
    if (method.startsWith('tasks/') && mcpName !== params['taskId']) return reply(id, new McpError(ERR.HEADER_MISMATCH, `Mcp-Name ${mcpName} does not equal the request's taskId`, undefined, 400));
  }
  // (4) only now: is the (agreed) revision one this mount speaks?
  if (!supported.includes(requested)) return reply(id, new McpError(ERR.UNSUPPORTED_VERSION, `revision ${requested} is not served`, { supported, requested }, 400));

  if (rawId === undefined && method.startsWith('notifications/')) return { status: 202 };
  // Unknown _meta keys and clientCapabilities.extensions are opaque: never refused, never honoured.
  const caps = isObject(meta[META_CLIENT_CAPS]) ? meta[META_CLIENT_CAPS] : {};
  // interop.md §Trace context (RFC 0207): _meta.traceparent, when valid, is the parent — else the transport header; a malformed value is ignored, never refused.
  const trace = inboundTraceContext(meta, (n) => ctx.header(n));

  if (method === 'subscriptions/listen') {
    const filter = isObject(params['notifications']) ? params['notifications'] : {};
    if (filter['taskIds'] !== undefined && !declaresTasks(caps)) return reply(id, new McpError(ERR.MISSING_CAPABILITY, 'Missing required client capability', { requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } } }));
    return subscriptionsListen(ctx, subject, id, params, caps);
  }

  // RFC 0198 §G.12–13: until this request's WHOLE response is sent, the run it
  // started or continued belongs to it — the connection closing first cancels
  // the run as cancelRun would. After the response is finished, a close is
  // just the end of a connection and touches nothing.
  const sse = method === 'tools/call' && prefersSse(ctx.header('accept'));
  const own: RequestOwnership = { runId: null, capMs: sse ? SSE_CALL_CAP_MS : CALL_CAP_MS };
  ctx.res.on('close', () => {
    if (ctx.res.writableFinished || own.runId === null) return;
    const run = ctx.host.store.getRun(own.runId);
    if (!run || TERMINAL.has(run.status)) return;
    try { requestCancel(ctx.host, run, MCP_REQUEST_CANCELLED); } catch (e) { if (!(e instanceof HostError)) process.stderr.write(`[mcp] disconnect cancel: ${String(e)}\n`); }
  });

  const answer = async (): Promise<Reply> => {
    try {
      const result = await dispatch(ctx.host, subject, method, params, caps, own, trace);
      return { status: 200, body: { jsonrpc: '2.0', id, result } };
    } catch (e) {
      if (e instanceof McpError) return reply(id, e);
      if (e instanceof HostError) return reply(id, new McpError(e.status >= 500 ? ERR.INTERNAL : ERR.INVALID_PARAMS, e.message));
      process.stderr.write(`[mcp] ${String((e as Error)?.stack ?? e)}\n`);
      return reply(id, new McpError(ERR.INTERNAL, 'the host failed to serve the request'));
    }
  };
  if (!sse) return answer();
  // SSE: the stream opens now and carries exactly one message — the response. No notifications/cancelled, ever (RFC 0198 §G.14).
  ctx.res.writeHead(200, { ...ctx.responseHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  ctx.res.flushHeaders();
  const r = await answer();
  if (!ctx.res.destroyed) ctx.res.end(`event: message\ndata: ${JSON.stringify(r.body)}\n\n`);
  return STREAMED;
}

/**
 * RFC 0199 §D.2(d) — the host-owned page a URL-mode elicitation points at for
 * an interrupt form mode may not carry. It follows the connectUrl rules: it
 * requires the user to authenticate, serves only the interrupt's own Subject,
 * and resolves through the one resolve path (validation, eligibility, the log).
 */
interface PageRow { page_id: string; run_id: string; node_id: string; subject_key: string }
function pageTarget(ctx: Ctx): { run: RunRow; pending: InterruptRow } {
  const row = ctx.host.store.db.prepare('SELECT * FROM interrupt_pages WHERE page_id = ?').get(ctx.params['pageId']) as PageRow | undefined;
  if (!row) throw err('not_found', 'no such interrupt page');
  if (row.subject_key !== subjectKey(ctx.subject as Subject)) throw err('forbidden', 'this interrupt page belongs to another Subject');
  const run = ctx.host.store.getRun(row.run_id);
  const pending = run ? ctx.host.store.pendingInterruptForNode(row.run_id, row.node_id) : undefined;
  if (!run || !pending) throw err('interrupt_already_resolved', 'the interrupt this page resolves is no longer open');
  return { run, pending };
}
async function pageGet(ctx: Ctx): Promise<Reply> {
  const { pending } = pageTarget(ctx);
  const p = payloadOf(pending);
  return { status: 200, body: { interruptId: pending.interrupt_id, kind: p.kind, data: p.data }, headers: { 'Cache-Control': 'no-store' } };
}
async function pagePost(ctx: Ctx): Promise<Reply> {
  const { run, pending } = pageTarget(ctx);
  const body = await ctx.json<{ resumeValue?: unknown }>();
  if (!('resumeValue' in body)) throw err('validation_error', 'resumeValue is REQUIRED');
  return { status: 200, body: resolveAndResume(ctx.host, run, pending, body.resumeValue, ctx.subject) };
}

export function mcpServerRoutes(): Route[] {
  return [
    route('POST', MCP_MOUNT_PATH, true, mcpHandler, 'both'),
    route('GET', '/interrupt-pages/{pageId}', true, pageGet),
    route('POST', '/interrupt-pages/{pageId}', true, pagePost),
  ];
}
