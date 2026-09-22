/**
 * RFC 0208 — the host as an A2A 1.0 SERVER, held to the `a2a.*` rows of
 * `spec/v2/interop-map.json` (`spec/v2/core/interop.md` §"The operation
 * mappings"). interop.ts is the host's A2A CLIENT; this is the other half.
 *
 *   GET  /.well-known/agent-card.json   the Agent Card (unauthenticated)
 *   POST /a2a/jsonrpc                   the one JSONRPC interface at 1.0
 *
 * Every operation is a v2 operation under the caller's Subject — the same
 * functions REST uses (acceptRun + scheduleRun, resolveAndResume, requestCancel,
 * store.listRuns), so authorization, tenant scoping, interrupt eligibility and
 * the event log are the REST ones, not a copy. What A2A adds is persisted per
 * run in `a2a_tasks` (contextId + the Messages exchanged on the task).
 *
 * Skill routing: an A2A 1.0 Message carries no skill selector, so one interface
 * routes one skill — the workflow `OPENWOP_A2A_WORKFLOW_ID` names (default
 * conformance-approval). The card lists exactly that skill.
 *
 * Advertised: streaming false, pushNotifications false, durableTasks false,
 * extendedAgentCard false — so SendStreamingMessage / SubscribeToTask /
 * returnImmediately are -32004, push-config methods -32003, and
 * GetExtendedAgentCard -32007 (the rows' own errors).
 */
import { HOST_NAME, HOST_VENDOR, HOST_VERSION } from './config.js';
import { HostError } from './errors.js';
import { requestCancel, resolveAndResume, scheduleRun, applyPinDisposition } from './executor.js';
import { principalRef } from './identity.js';
import { nowIso, opaque } from './ids.js';
import { acceptRun } from './runs.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import { TERMINAL, type Host, type Subject } from './host.js';
import type { RunRow } from './store.js';
import { A2A_FACET } from './interop.js';

export const A2A_SERVER_PROFILES = ['a2a-1.0'] as const;
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_JSONRPC_PATH = '/a2a/jsonrpc';
const A2A_VERSION = '1.0';

/** A2A 1.0.1 JSON-RPC error codes (interop-map.json a2a.errors). */
export const A2A_ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** The run status → Task.status.state projection (interop-map.json a2a.taskState). */
const TASK_STATE: Record<string, string> = {
  pending: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  paused: 'TASK_STATE_WORKING',
  cancelling: 'TASK_STATE_WORKING',
  'waiting-approval': 'TASK_STATE_INPUT_REQUIRED',
  'waiting-input': 'TASK_STATE_INPUT_REQUIRED',
  'waiting-external': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

const isSuspended = (status: string): boolean => status.startsWith('waiting-');
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Block (bounded) until the run is terminal or suspended. Both server
 * interfaces answer a blocking request with the run's state at that point; the
 * log stays the source of truth — this only reads the store.
 */
export async function waitForSettle(host: Host, runId: string, capMs: number): Promise<RunRow | undefined> {
  const deadline = Date.now() + capMs;
  for (;;) {
    const run = host.store.getRun(runId);
    if (!run || TERMINAL.has(run.status) || isSuspended(run.status) || Date.now() >= deadline) return run;
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

// ── the Agent Card ─────────────────────────────────────────────────────────

function routedWorkflow(host: Host): { id: string; name: string; description: string; tags: string[] } | null {
  const def = host.workflows.get(host.config.a2aWorkflowId);
  if (!def) return null;
  const tags = Array.isArray(def.metadata?.['tags']) ? (def.metadata['tags'] as unknown[]).map(String) : [];
  return { id: def.id, name: def.name ?? def.id, description: def.description ?? `Runs the OpenWOP workflow ${def.id}`, tags: tags.length > 0 ? tags : ['openwop'] };
}

export function agentCard(host: Host, baseUrl: string): Record<string, unknown> {
  const skill = routedWorkflow(host);
  return {
    name: HOST_NAME,
    description: `OpenWOP v2 reference host. The interface routes one skill: the workflow ${host.config.a2aWorkflowId}, one run per task.`,
    version: HOST_VERSION,
    // a2a.card supportedInterfaces[]: only interfaces the host routes; the protocolVersion set equals a2a.versions.
    supportedInterfaces: [{ url: `${baseUrl}${A2A_JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
    provider: { organization: HOST_VENDOR, url: 'https://openwop.dev' },
    // a2a.card capabilities: equal to the a2a facets; GetExtendedAgentCard is not served.
    capabilities: { streaming: A2A_FACET.streaming, pushNotifications: A2A_FACET.pushNotifications, extendedAgentCard: false },
    // a2a.card securitySchemes | securityRequirements: exactly the authentication the endpoint enforces.
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'An OpenWOP api-key or session credential (Authorization: Bearer <credential>); the Subject it resolves to owns the task.' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    // a2a.card skills[]: skills[].id is the routed workflowId; no skill the host does not route.
    skills: skill === null ? [] : [skill],
  };
}

async function cardHandler(ctx: Ctx): Promise<Reply> {
  return { status: 200, body: agentCard(ctx.host, ctx.baseUrl), headers: { 'Cache-Control': 'public, max-age=60' } };
}

// ── the task projection ────────────────────────────────────────────────────

interface A2AMessage { messageId: string; role: string; parts: unknown[]; taskId?: string; contextId?: string; metadata?: Record<string, unknown> }

function contextOf(host: Host, run: RunRow): string {
  // A run not created over A2A has no persisted A2ATaskState; its contextId falls back to its runId.
  return host.store.a2aTask(run.run_id)?.context_id ?? run.run_id;
}

function historyOf(host: Host, run: RunRow): A2AMessage[] {
  const row = host.store.a2aTask(run.run_id);
  return row ? (JSON.parse(row.history_json) as A2AMessage[]) : [];
}

export function taskOf(host: Host, run: RunRow, historyLength?: number): Record<string, unknown> {
  const history = historyOf(host, run);
  const task: Record<string, unknown> = {
    id: run.run_id,
    contextId: contextOf(host, run),
    status: { state: TASK_STATE[run.status] ?? 'TASK_STATE_WORKING', timestamp: run.updated_at },
    history: historyLength === undefined ? history : historyLength === 0 ? [] : history.slice(-historyLength),
    artifacts: [],
  };
  if (isSuspended(run.status) && run.current_node_id !== null) {
    const pending = host.store.pendingInterruptForNode(run.run_id, run.current_node_id);
    if (pending) task['metadata'] = { openwop: { interrupt: { kind: pending.kind, nodeId: pending.node_id } } };
    if (pending?.kind === 'credential') {
      // RFC 0199 §D.1 (interop-map.json a2a.taskState override (waiting-input, credential)):
      // TASK_STATE_AUTH_REQUIRED, with a status message naming the provider and carrying connectUrl —
      // A2A §7.6.1's out-of-band means. The message carries no credential and no interrupt token.
      const data = (JSON.parse(pending.payload_json) as { data?: { provider?: string; scopes?: string[]; connectUrl?: string } }).data ?? {};
      const scopes = Array.isArray(data.scopes) && data.scopes.length > 0 ? ` (${data.scopes.join(' ')})` : '';
      task['status'] = { state: 'TASK_STATE_AUTH_REQUIRED', timestamp: run.updated_at, message: { messageId: `auth-${pending.interrupt_id.split('/')[1] ?? pending.interrupt_id}`, role: 'ROLE_AGENT', parts: [{ text: `Authorize ${String(data.provider)}${scopes}: ${String(data.connectUrl)}` }], taskId: run.run_id, contextId: contextOf(host, run) } };
    }
  }
  return task;
}

/** A task the caller cannot read is answered exactly as a nonexistent one (Isolation) — including a foreign tenant REST refuses 403. */
function readableRun(host: Host, subject: Subject, id: unknown): RunRow {
  if (typeof id !== 'string' || id.length === 0) throw new RpcError(A2A_ERR.TASK_NOT_FOUND, 'task not found');
  const run = host.store.getRun(id);
  if (!run || run.tenant !== subject.tenant) throw new RpcError(A2A_ERR.TASK_NOT_FOUND, 'task not found');
  return applyPinDisposition(host, run);
}

function parseMessage(raw: unknown): A2AMessage {
  if (!isObject(raw)) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'params.message MUST be a Message object');
  const { messageId, role, parts } = raw;
  if (typeof messageId !== 'string' || messageId.length === 0) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.messageId is REQUIRED');
  if (typeof role !== 'string' || role.length === 0) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.role is REQUIRED');
  if (!Array.isArray(parts)) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.parts MUST be an array');
  for (const p of parts) if (!isObject(p) || !('text' in p || 'data' in p || 'raw' in p || 'url' in p)) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'a Part is discriminated by member presence (text | raw | url | data)');
  if (raw['taskId'] !== undefined && typeof raw['taskId'] !== 'string') throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.taskId MUST be a string');
  if (raw['contextId'] !== undefined && typeof raw['contextId'] !== 'string') throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.contextId MUST be a string');
  if (raw['metadata'] !== undefined && !isObject(raw['metadata'])) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.metadata MUST be an object');
  const m: A2AMessage = { messageId, role, parts };
  if (typeof raw['taskId'] === 'string') m.taskId = raw['taskId'];
  if (typeof raw['contextId'] === 'string') m.contextId = raw['contextId'];
  if (isObject(raw['metadata'])) m.metadata = raw['metadata'];
  return m;
}

/** The resumeValue a message carries: `metadata.openwop.interrupt`, else the first `data` part. */
function resumeValueOf(m: A2AMessage): unknown {
  const openwop = m.metadata?.['openwop'];
  if (isObject(openwop) && 'interrupt' in openwop) return openwop['interrupt'];
  const data = m.parts.find((p): p is Record<string, unknown> => isObject(p) && 'data' in p);
  return data === undefined ? undefined : data['data'];
}

function appendHistory(host: Host, run: RunRow, m: A2AMessage): void {
  const history = historyOf(host, run);
  history.push({ ...m, taskId: run.run_id, contextId: contextOf(host, run) });
  host.store.setA2AHistory(run.run_id, JSON.stringify(history));
}

/** A REST refusal from a shared code path, rendered in the binding's vocabulary. */
function fromHostError(e: HostError): RpcError {
  if (e.code === 'run_terminal' || e.code === 'interrupt_already_resolved') return new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, e.message);
  if (e.status === 404) return new RpcError(A2A_ERR.TASK_NOT_FOUND, 'task not found');
  if (e.status === 400 || e.status === 403 || e.status === 422) return new RpcError(A2A_ERR.INVALID_PARAMS, e.message);
  if (e.status === 409) return new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, e.message);
  return new RpcError(A2A_ERR.INTERNAL, 'the host failed to serve the request');
}

const BLOCK_CAP_MS = 3000;

// ── the methods ────────────────────────────────────────────────────────────

async function sendMessage(host: Host, subject: Subject, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const m = parseMessage(params['message']);
  const configuration = params['configuration'];
  if (configuration !== undefined && !isObject(configuration)) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'configuration MUST be an object');
  if (isObject(configuration) && configuration['returnImmediately'] === true) {
    throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, 'configuration.returnImmediately requires a2a.durableTasks, which this host does not advertise');
  }
  // message.messageId is the idempotency seed: a repeat from the same principal answers the task it already reached.
  const principal = `${subject.tenant}|${principalRef(subject)}`;
  const seen = host.store.a2aMessageRun(principal, m.messageId);
  if (seen !== undefined) {
    const run = readableRun(host, subject, seen);
    return { task: taskOf(host, (await waitForSettle(host, run.run_id, BLOCK_CAP_MS)) ?? run) };
  }

  if (m.taskId === undefined) {
    const def = host.workflows.get(host.config.a2aWorkflowId);
    if (!def) throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, 'the interface routes no skill on this host');
    const inputs = Object.fromEntries(def.variables.filter((v) => v.defaultValue !== undefined).map((v) => [v.name, v.defaultValue]));
    const run = acceptRun(host, subject, def.id, inputs, { transport: 'a2a' }, null);
    const contextId = m.contextId ?? `ctx-${opaque()}`;
    host.store.insertA2ATask({ run_id: run.run_id, tenant: subject.tenant, context_id: contextId, history_json: '[]', created_at: nowIso() });
    appendHistory(host, run, m);
    host.store.recordA2AMessage(principal, m.messageId, run.run_id);
    scheduleRun(host, run.run_id);
    return { task: taskOf(host, (await waitForSettle(host, run.run_id, BLOCK_CAP_MS)) ?? run) };
  }

  const run = readableRun(host, subject, m.taskId);
  // A2A §3.4.3: a message whose contextId is not its task's is refused, and NOTHING changes.
  if (m.contextId !== undefined && m.contextId !== contextOf(host, run)) {
    throw new RpcError(A2A_ERR.INVALID_PARAMS, 'message.contextId is not the task\'s contextId');
  }
  // a2a.operations SendMessage (taskId, run terminal and retained): no event is appended.
  if (TERMINAL.has(run.status)) throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, `the task is ${TASK_STATE[run.status] ?? run.status}; a terminal task accepts no message`);
  if (!isSuspended(run.status) || run.current_node_id === null) {
    // a2a.operations (taskId, run not suspended and not terminal): no declared input path on this host.
    throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, 'the task is not waiting for input; this host declares no input path for a running task');
  }
  const pending = host.store.pendingInterruptForNode(run.run_id, run.current_node_id);
  if (!pending) throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, 'the task has no open interrupt');
  const resumeValue = resumeValueOf(m);
  if (resumeValue === undefined) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'the message carries no resumeValue (metadata.openwop.interrupt or a data part)');
  // The REST resolveInterruptByRun path: validation, approver eligibility, the atomic claim, the log.
  resolveAndResume(host, run, pending, resumeValue, subject);
  const fresh = host.store.getRun(run.run_id) ?? run;
  appendHistory(host, fresh, m);
  host.store.recordA2AMessage(principal, m.messageId, run.run_id);
  return { task: taskOf(host, (await waitForSettle(host, run.run_id, BLOCK_CAP_MS)) ?? fresh) };
}

function historyLengthOf(params: Record<string, unknown>): number | undefined {
  const h = params['historyLength'];
  if (h === undefined || h === null) return undefined;
  if (typeof h !== 'number' || !Number.isInteger(h) || h < 0) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'historyLength MUST be a non-negative integer');
  return h;
}

function getTask(host: Host, subject: Subject, params: Record<string, unknown>): Record<string, unknown> {
  const historyLength = historyLengthOf(params);
  return taskOf(host, readableRun(host, subject, params['id']), historyLength);
}

const WIRE_STATES = new Set(Object.values(TASK_STATE));

/**
 * a2a.operations ListTasks: exactly the set listRuns returns to this Subject
 * (tenant is a WHERE clause there), filtered by contextId and status; the
 * `tenant` parameter never selects — it is not read.
 */
function listTasks(host: Host, subject: Subject, params: Record<string, unknown>): Record<string, unknown> {
  const contextId = params['contextId'];
  if (contextId !== undefined && typeof contextId !== 'string') throw new RpcError(A2A_ERR.INVALID_PARAMS, 'contextId MUST be a string');
  const status = params['status'];
  if (status !== undefined && (typeof status !== 'string' || !WIRE_STATES.has(status))) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'status MUST be a TaskState this host projects');
  const pageSizeRaw = params['pageSize'];
  let pageSize = 50;
  if (pageSizeRaw !== undefined) {
    if (typeof pageSizeRaw !== 'number' || !Number.isInteger(pageSizeRaw) || pageSizeRaw < 1 || pageSizeRaw > 100) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'pageSize MUST be an integer 1-100');
    pageSize = pageSizeRaw;
  }
  const tokenRaw = params['pageToken'];
  let offset = 0;
  if (tokenRaw !== undefined && tokenRaw !== '') {
    const decoded = typeof tokenRaw === 'string' ? Buffer.from(tokenRaw, 'base64url').toString('utf8') : '';
    if (!/^o:(0|[1-9][0-9]*)$/.test(decoded)) throw new RpcError(A2A_ERR.INVALID_PARAMS, 'pageToken is not one this host minted');
    offset = Number(decoded.slice(2));
  }
  const historyLength = historyLengthOf(params);
  const runs = host.store.listRuns(subject.tenant, { limit: 100_000 })
    .filter((r) => contextId === undefined || contextOf(host, r) === contextId)
    .filter((r) => status === undefined || TASK_STATE[r.status] === status)
    // ordered by status timestamp, newest first
    .sort((a, b) => (a.updated_at === b.updated_at ? (a.run_id < b.run_id ? 1 : -1) : a.updated_at < b.updated_at ? 1 : -1));
  const page = runs.slice(offset, offset + pageSize);
  const next = offset + pageSize < runs.length ? Buffer.from(`o:${offset + pageSize}`).toString('base64url') : '';
  return { tasks: page.map((r) => taskOf(host, applyPinDisposition(host, r), historyLength)), nextPageToken: next, pageSize, totalSize: runs.length };
}

function cancelTask(host: Host, subject: Subject, params: Record<string, unknown>): Record<string, unknown> {
  const run = readableRun(host, subject, params['id']);
  if (TERMINAL.has(run.status)) throw new RpcError(A2A_ERR.TASK_NOT_CANCELABLE, `the task is ${TASK_STATE[run.status] ?? run.status}`);
  try {
    requestCancel(host, run, 'a2a-cancel-task');
  } catch (e) {
    if (e instanceof HostError && e.code === 'run_terminal') throw new RpcError(A2A_ERR.TASK_NOT_CANCELABLE, e.message);
    throw e;
  }
  return taskOf(host, host.store.getRun(run.run_id) ?? run);
}

async function dispatch(host: Host, subject: Subject, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (method) {
    case 'SendMessage': return sendMessage(host, subject, params);
    case 'GetTask': return getTask(host, subject, params);
    case 'ListTasks': return listTasks(host, subject, params);
    case 'CancelTask': return cancelTask(host, subject, params);
    case 'SendStreamingMessage':
    case 'SubscribeToTask':
      throw new RpcError(A2A_ERR.UNSUPPORTED_OPERATION, `${method} requires a2a.streaming, which this host does not advertise`);
    case 'CreateTaskPushNotificationConfig':
    case 'GetTaskPushNotificationConfig':
    case 'ListTaskPushNotificationConfigs':
    case 'DeleteTaskPushNotificationConfig':
      throw new RpcError(A2A_ERR.PUSH_NOT_SUPPORTED, `${method} requires a2a.pushNotifications, which this host does not advertise`);
    case 'GetExtendedAgentCard':
      throw new RpcError(A2A_ERR.EXTENDED_CARD_NOT_CONFIGURED, 'capabilities.extendedAgentCard is false on this host');
    default:
      throw new RpcError(A2A_ERR.METHOD_NOT_FOUND, `method ${method} is not served`);
  }
}

type RpcId = string | number | null;
const rpcError = (id: RpcId, code: number, message: string): Reply => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } }, headers: { 'A2A-Version': A2A_VERSION } });

async function jsonRpcHandler(ctx: Ctx): Promise<Reply> {
  const subject = ctx.subject;
  if (subject === null) return rpcError(null, A2A_ERR.INTERNAL, 'the interface is authenticated');
  let parsed: unknown;
  try { parsed = JSON.parse((await ctx.raw()).toString('utf8')); } catch { return rpcError(null, A2A_ERR.PARSE, 'the request body is not JSON'); }
  if (!isObject(parsed) || parsed['jsonrpc'] !== '2.0' || typeof parsed['method'] !== 'string') return rpcError(null, A2A_ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
  const rawId = parsed['id'];
  const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const version = ctx.header('a2a-version');
  if (version !== null && version.trim() !== '' && version.trim() !== A2A_VERSION) {
    return rpcError(id, A2A_ERR.VERSION_NOT_SUPPORTED, `A2A-Version ${version.trim()} is not served; this interface serves ${A2A_VERSION}`);
  }
  const params = parsed['params'] === undefined ? {} : parsed['params'];
  if (!isObject(params)) return rpcError(id, A2A_ERR.INVALID_PARAMS, 'params MUST be an object');
  try {
    const result = await dispatch(ctx.host, subject, parsed['method'], params);
    return { status: 200, body: { jsonrpc: '2.0', id, result }, headers: { 'A2A-Version': A2A_VERSION } };
  } catch (e) {
    if (e instanceof RpcError) return rpcError(id, e.code, e.message);
    if (e instanceof HostError) { const r = fromHostError(e); return rpcError(id, r.code, r.message); }
    process.stderr.write(`[a2a] ${String((e as Error)?.stack ?? e)}\n`);
    return rpcError(id, A2A_ERR.INTERNAL, 'the host failed to serve the request');
  }
}

export function a2aServerRoutes(): Route[] {
  return [
    route('GET', AGENT_CARD_PATH, false, cardHandler, 'both'),
    route('POST', A2A_JSONRPC_PATH, true, jsonRpcHandler, 'both'),
  ];
}
