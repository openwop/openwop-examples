/**
 * RFC 0208 — the host as an A2A 1.0 server and an MCP 2026-07-28 server.
 * Route-level regression net under the conformance scenarios
 * (v2-a2a-operation-map, v2-mcp-mount-map, v2-mcp-tasks): boots the host in-memory with a
 * second tenant and strict dev validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-interop';
const KB = 'test-key-interop-tenant-b';
const REV = '2026-07-28';
const enc = encodeURIComponent;

interface RpcErr { code: number; message: string; data?: any }
interface Rpc { status: number; result?: any; error?: RpcErr | undefined }

async function a2a(method: string, params: unknown, opts: { key?: string | null; version?: string } = {}): Promise<Rpc> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'A2A-Version': opts.version ?? '1.0' };
  const key = opts.key === undefined ? K : opts.key;
  if (key !== null) headers['Authorization'] = `Bearer ${key}`;
  const r = await fetch(`${B}/a2a/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const b = await r.json() as { result?: unknown; error?: RpcErr };
  return { status: r.status, ...b };
}

interface McpOpts { key?: string | null; version?: string | null; bodyVersion?: string | null; caps?: Record<string, unknown>; mcpName?: string }
async function mcp(method: string, params: Record<string, unknown>, o: McpOpts = {}): Promise<Rpc> {
  const version = o.version === undefined ? REV : o.version;
  const bodyVersion = o.bodyVersion === undefined ? version : o.bodyVersion;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Mcp-Method': method };
  if (version !== null) headers['MCP-Protocol-Version'] = version;
  if (o.mcpName !== undefined) headers['Mcp-Name'] = o.mcpName;
  const key = o.key === undefined ? K : o.key;
  if (key !== null) headers['Authorization'] = `Bearer ${key}`;
  const meta: Record<string, unknown> = { 'io.modelcontextprotocol/clientCapabilities': o.caps ?? {} };
  if (bodyVersion !== null) meta['io.modelcontextprotocol/protocolVersion'] = bodyVersion;
  const r = await fetch(`${B}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: meta } }) });
  const b = await r.json().catch(() => ({})) as { result?: unknown; error?: RpcErr };
  return { status: r.status, ...b };
}

async function rest(path: string, key = K): Promise<any> {
  const r = await fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${key}`, 'OpenWOP-Version': '2.0' } });
  return r.json();
}
async function events(runId: string): Promise<Array<{ type: string; payload: any }>> {
  return ((await rest(`/runs/${enc(runId)}/events/poll`)) as { events: Array<{ type: string; payload: any }> }).events;
}
async function waitStatus(runId: string, wanted: string[], ms = 8000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const s = (await rest(`/runs/${enc(runId)}`)).status as string;
    if (wanted.includes(s) || Date.now() > end) return s;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}
const msg = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: 'ROLE_USER', parts: [{ text: 'hi' }], ...extra });
const accept = (taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => msg({ taskId, parts: [{ data: { action: 'accept' } }], ...extra });

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, tenantBApiKey: KB, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('discovery + the Agent Card', () => {
  it('advertises the server profiles with absolute URLs the caller can reach', async () => {
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as any;
    expect(d.a2a.profiles).toEqual(['a2a-1.0']);
    expect(d.a2a.agentCardUrl).toBe(`${B}/.well-known/agent-card.json`);
    expect([d.a2a.streaming, d.a2a.pushNotifications, d.a2a.durableTasks]).toEqual([false, false, false]);
    expect(d.mcp.profiles).toEqual(['mcp-2026-07-28']);
    expect(d.mcp.features).toEqual(['server-discover', 'mrtr', 'cacheable-lists', 'extensions']);
    expect(d.mcp.serverMount).toEqual({ transports: ['streamable-http'] });
    expect(d.mcp.serverUrls).toEqual([`${B}/mcp`]);
  });
  it('serves an unauthenticated A2A 1.0 card routing exactly one skill', async () => {
    const r = await fetch(`${B}/.well-known/agent-card.json`);
    expect(r.status).toBe(200);
    const card = await r.json() as any;
    expect(card.supportedInterfaces).toEqual([{ url: `${B}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    // RFC 0202: extendedAgentCard is true iff the installed contract defines a2a.agentCards (GetExtendedAgentCard served).
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: running.host.artifacts.agentCardsFacet });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(['conformance-approval']);
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe('Bearer');
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
    expect(typeof card.provider.organization).toBe('string');
  });
});

describe('A2A JSON-RPC', () => {
  it('SendMessage → INPUT_REQUIRED → accept by taskId (contextId inferred) → COMPLETED, transport a2a', async () => {
    const first = await a2a('SendMessage', { message: msg() });
    expect(first.status).toBe(200);
    const task = first.result.task;
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(task.metadata.openwop.interrupt).toEqual({ kind: 'approval', nodeId: 'gate' });
    expect(task.id.startsWith('openwop-reference-tenant/')).toBe(true);
    const reply = await a2a('SendMessage', { message: accept(task.id) });
    expect(reply.error).toBeUndefined();
    expect(reply.result.task.contextId).toBe(task.contextId);
    expect(await waitStatus(task.id, ['completed'])).toBe('completed');
    const got = await a2a('GetTask', { id: task.id });
    expect(got.result.status.state).toBe('TASK_STATE_COMPLETED');
    expect(got.result.history).toHaveLength(2);
    expect((await a2a('GetTask', { id: task.id, historyLength: 1 })).result.history).toHaveLength(1);
    expect((await events(task.id)).find((e) => e.type === 'run.started')?.payload.transport).toBe('a2a');
  });
  it('a repeated messageId does not start a second run', async () => {
    const m = msg();
    const a = await a2a('SendMessage', { message: m });
    const b = await a2a('SendMessage', { message: m });
    expect(b.result.task.id).toBe(a.result.task.id);
    await a2a('CancelTask', { id: a.result.task.id });
  });
  it('a contextId mismatch is -32602 and leaves the run exactly as it was', async () => {
    const task = (await a2a('SendMessage', { message: msg() })).result.task;
    const before = (await events(task.id)).length;
    const bad = await a2a('SendMessage', { message: accept(task.id, { contextId: 'ctx-not-this-one' }) });
    expect(bad.status).toBe(200);
    expect(bad.error?.code).toBe(-32602);
    expect(await waitStatus(task.id, ['waiting-approval'])).toBe('waiting-approval');
    expect((await events(task.id)).length).toBe(before);
    await a2a('CancelTask', { id: task.id });
  });
  it('a message to a terminal task is -32004 and appends nothing; CancelTask on it is -32002', async () => {
    const task = (await a2a('SendMessage', { message: msg() })).result.task;
    await a2a('SendMessage', { message: accept(task.id) });
    expect(await waitStatus(task.id, ['completed'])).toBe('completed');
    const before = (await events(task.id)).length;
    expect((await a2a('SendMessage', { message: msg({ taskId: task.id }) })).error?.code).toBe(-32004);
    expect((await events(task.id)).length).toBe(before);
    expect((await a2a('CancelTask', { id: task.id })).error?.code).toBe(-32002);
  });
  it('CancelTask on a suspended task answers CANCELED', async () => {
    const task = (await a2a('SendMessage', { message: msg() })).result.task;
    const c = await a2a('CancelTask', { id: task.id });
    expect(c.result.status.state).toBe('TASK_STATE_CANCELED');
    expect((await a2a('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  });
  it('an unknown task and another tenant\'s task are the identical -32001', async () => {
    const mine = (await a2a('SendMessage', { message: msg() })).result.task;
    const unknown = await a2a('GetTask', { id: 'openwop-reference-tenant/AAAAAAAAAAAAAAAAAAAAAAAA' });
    const foreign = await a2a('GetTask', { id: mine.id }, { key: KB });
    const segment = await a2a('GetTask', { id: `zz-other/${mine.id.split('/')[1]}` });
    for (const r of [unknown, foreign, segment]) { expect(r.status).toBe(200); expect(r.error).toEqual({ code: -32001, message: 'task not found' }); }
    await a2a('CancelTask', { id: mine.id });
  });
  it('ListTasks is the caller\'s tenant only; tenant never selects', async () => {
    const mine = (await a2a('SendMessage', { message: msg() })).result.task;
    const own = await a2a('ListTasks', { contextId: mine.contextId });
    expect(own.result.tasks.map((t: { id: string }) => t.id)).toEqual([mine.id]);
    expect(own.result.nextPageToken).toBe('');
    const theirs = await a2a('ListTasks', { tenant: 'openwop-reference-tenant', contextId: mine.contextId }, { key: KB });
    // Without RFC 0202 tenant is not read; with it, a value that is no routing value in B's inventory is refused.
    expect(theirs.result?.tasks ?? []).toEqual([]);
    if (running.host.artifacts.agentCardsFacet) expect(theirs.error?.code).toBe(-32602);
    const all = await a2a('ListTasks', {}, { key: KB });
    expect(all.result.tasks.every((t: { id: string }) => t.id.startsWith('openwop-reference-tenant-b/'))).toBe(true);
    await a2a('CancelTask', { id: mine.id });
  });
  it('refuses unadvertised rows with their own codes; a foreign A2A-Version is -32009; unauthenticated is the 401 envelope', async () => {
    expect((await a2a('SubscribeToTask', { id: 'x' })).error?.code).toBe(-32004);
    expect((await a2a('SendStreamingMessage', { message: msg() })).error?.code).toBe(-32004);
    expect((await a2a('SendMessage', { message: msg(), configuration: { returnImmediately: true } })).error?.code).toBe(-32004);
    expect((await a2a('CreateTaskPushNotificationConfig', {})).error?.code).toBe(-32003);
    if (!running.host.artifacts.agentCardsFacet) expect((await a2a('GetExtendedAgentCard', {})).error?.code).toBe(-32007);
    expect((await a2a('NoSuchMethod', {})).error?.code).toBe(-32601);
    expect((await a2a('GetTask', { id: 'x' }, { version: '0.3' })).error?.code).toBe(-32009);
    const anon = await fetch(`${B}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe('unauthenticated');
  });
});

describe('MCP mount', () => {
  it('server/discover answers the advertised revisions with cache hints; initialize is never required', async () => {
    const r = await mcp('server/discover', {});
    expect(r.result.supportedVersions).toEqual([REV]);
    expect([r.result.resultType, r.result.ttlMs, r.result.cacheScope]).toEqual(['complete', 60000, 'private']);
    expect((await mcp('initialize', {})).error?.code).toBe(-32601);
  });
  it('header checks run in order: missing → -32022, header≠body → -32020 before support, unsupported → -32022', async () => {
    const missing = await mcp('tools/list', {}, { version: null, bodyVersion: REV });
    expect([missing.status, missing.error?.code, missing.error?.data?.supported]).toEqual([400, -32022, [REV]]);
    const mismatch = await mcp('tools/list', {}, { bodyVersion: '1999-01-01' });
    expect([mismatch.status, mismatch.error?.code]).toEqual([400, -32020]);
    const name = await mcp('tools/call', { name: 'conformance-noop', arguments: {} }, { mcpName: 'other' });
    expect([name.status, name.error?.code]).toEqual([400, -32020]);
    const unsupported = await mcp('tools/list', {}, { version: '1999-01-01' });
    expect([unsupported.status, unsupported.error?.code, unsupported.error?.data]).toEqual([400, -32022, { supported: [REV], requested: '1999-01-01' }]);
  });
  it('tools/list is the fixtures, sorted, private', async () => {
    const r = await mcp('tools/list', {});
    const names = r.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(['conformance-noop', 'conformance-failure', 'conformance-approval']));
    expect(r.result.cacheScope).toBe('private');
  });
  it('tools/call: noop completes isError false (transport mcp); failure is a result isError true; bad arguments are -32602', async () => {
    const ok = await mcp('tools/call', { name: 'conformance-noop', arguments: {} }, { mcpName: 'conformance-noop' });
    expect([ok.error, ok.result.resultType, ok.result.isError]).toEqual([undefined, 'complete', false]);
    const runId = JSON.parse(ok.result.content[0].text).runId as string;
    expect((await events(runId)).find((e) => e.type === 'run.started')?.payload.transport).toBe('mcp');
    const bad = await mcp('tools/call', { name: 'conformance-failure', arguments: {} });
    expect([bad.error, bad.result.isError]).toEqual([undefined, true]);
    expect((await mcp('tools/call', { name: 'conformance-noop', arguments: 'x' })).error?.code).toBe(-32602);
    expect((await mcp('tools/call', { name: 'no-such-tool', arguments: {} })).error?.code).toBe(-32602);
  });
  it('MRTR: elicitation is never assumed; input_required → accept retry completes; requestState is single use and bound', async () => {
    const noCap = await mcp('tools/call', { name: 'conformance-approval', arguments: {} });
    expect([noCap.error?.code, noCap.error?.data]).toEqual([-32021, { requiredCapabilities: ['elicitation'] }]);
    const caps = { elicitation: {} };
    const first = await mcp('tools/call', { name: 'conformance-approval', arguments: {} }, { caps });
    expect(first.result.resultType).toBe('input_required');
    // interop-map.json mcp.mrtr InputRequiredResult: one key per open interrupt, keyed by its
    // interruptId (tenant-bound, `<tenant>/<opaque>`), NOT by the node id — the same key
    // mcp.tasks.status projects. A second run of the same workflow suspends at the same node
    // and MUST therefore be advertised under a different key.
    const key = Object.keys(first.result.inputRequests)[0] as string;
    expect(key).toMatch(/^[^/]+\/[A-Za-z0-9._~-]{16,128}$/);
    expect(key).not.toBe('gate');
    const second = await mcp('tools/call', { name: 'conformance-approval', arguments: {} }, { caps });
    const key2 = Object.keys(second.result.inputRequests)[0] as string;
    expect(key2).not.toBe(key);
    // …and each key answers only its own interrupt: the second run's state spends key2.
    await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: second.result.requestState, inputResponses: { [key2]: { action: 'decline' } } }, { caps });
    expect(first.result.inputRequests[key].method).toBe('elicitation/create');
    expect(first.result.inputRequests[key].params.requestedSchema.properties.action.enum).toEqual(['accept', 'reject']);
    const state = first.result.requestState as string;
    const responses = { [key]: { action: 'accept', content: { action: 'accept' } } };
    // bound to the principal and the request: another tenant's caller, or other arguments, cannot spend it
    expect((await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: state, inputResponses: responses }, { caps, key: KB })).error?.code).toBe(-32602);
    expect((await mcp('tools/call', { name: 'conformance-approval', arguments: { x: 1 }, requestState: state, inputResponses: responses }, { caps })).error?.code).toBe(-32602);
    expect((await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: `${state}x`, inputResponses: responses }, { caps })).error?.code).toBe(-32602);
    const retry = await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: state, inputResponses: responses }, { caps });
    expect([retry.error, retry.result.resultType, retry.result.isError]).toEqual([undefined, 'complete', false]);
    const again = await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: state, inputResponses: responses }, { caps });
    expect(again.error?.code).toBe(-32602);
    // …and the key WAS this run's interruptId: the completed result names the run, whose
    // node.suspended carries the same id the MRTR request was keyed by.
    const runId = JSON.parse(retry.result.content[0].text).runId as string;
    expect((await events(runId)).find((e) => e.type === 'node.suspended')?.payload.interruptId).toBe(key);
  });
  it('MRTR decline takes the reject path (a result, isError true)', async () => {
    const caps = { elicitation: {} };
    const first = await mcp('tools/call', { name: 'conformance-approval', arguments: {} }, { caps });
    const key = Object.keys(first.result.inputRequests)[0] as string;
    const r = await mcp('tools/call', { name: 'conformance-approval', arguments: {}, requestState: first.result.requestState, inputResponses: { [key]: { action: 'decline' } } }, { caps });
    expect([r.error, r.result.isError]).toEqual([undefined, true]);
  });
  it('unauthenticated is refused at the boundary (401 envelope), never a 200', async () => {
    const anon = await mcp('tools/list', {}, { key: null });
    expect(anon.status).toBe(401);
  });
});

describe('MCP Tasks (RFC 0198)', () => {
  const TASKS = { elicitation: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } };
  const unproject = (t: string): string => t.replace(/~2F/g, '/');
  it('server/discover lists the extension; a declaring tools/call is a task whose id is the projected runId', async () => {
    expect((await mcp('server/discover', {})).result.capabilities.extensions).toEqual({ 'io.modelcontextprotocol/tasks': {} });
    const t = await mcp('tools/call', { name: 'conformance-approval', arguments: {} }, { caps: TASKS });
    expect([t.error, t.result.resultType, t.result.ttlMs]).toEqual([undefined, 'task', null]);
    const runId = unproject(t.result.taskId as string);
    expect(runId).toMatch(/^[^/]+\/[A-Za-z0-9._~-]{22,}$/);
    expect((await rest(`/runs/${enc(runId)}`)).workflowId).toBe('conformance-approval');
    expect(await waitStatus(runId, ['waiting-approval'])).toBe('waiting-approval');
    const got = await mcp('tasks/get', { taskId: t.result.taskId }, { caps: TASKS, mcpName: t.result.taskId });
    const key = Object.keys(got.result.inputRequests)[0] as string;
    expect([got.result.status, key]).toEqual(['input_required', (await events(runId)).find((e) => e.type === 'node.suspended')?.payload.interruptId]);
    const answer = { taskId: t.result.taskId, inputResponses: { [key]: { action: 'accept', content: { action: 'accept' } } } };
    expect((await mcp('tasks/update', answer, { caps: TASKS })).result).toEqual({ resultType: 'complete' });
    expect((await mcp('tasks/update', answer, { caps: TASKS })).result).toEqual({ resultType: 'complete' });
    expect(await waitStatus(runId, ['completed'])).toBe('completed');
    expect((await events(runId)).filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);
    const done = await mcp('tasks/get', { taskId: t.result.taskId }, { caps: TASKS });
    expect([done.result.status, done.result.result.isError]).toEqual(['completed', false]);
  });
  it('tasks/* without the extension is -32021; unknown, foreign-tenant and other-tenant reads are the identical -32602', async () => {
    const t = await mcp('tools/call', { name: 'conformance-approval', arguments: {} }, { caps: TASKS });
    expect((await mcp('tasks/get', { taskId: t.result.taskId }, { caps: {} })).error?.code).toBe(-32021);
    const [tenant, opaque] = unproject(t.result.taskId).split('/') as [string, string];
    const refusals = [
      await mcp('tasks/get', { taskId: `${tenant}~2F${'Z'.repeat(opaque.length)}` }, { caps: TASKS }),
      await mcp('tasks/get', { taskId: `elsewhere~2F${opaque}` }, { caps: TASKS }),
      await mcp('tasks/get', { taskId: t.result.taskId }, { caps: TASKS, key: KB }),
      await mcp('tasks/cancel', { taskId: t.result.taskId }, { caps: TASKS, key: KB }),
    ];
    expect(new Set(refusals.map((r) => JSON.stringify([r.status, r.error]))).size).toBe(1);
    expect(refusals[0]?.error).toEqual({ code: -32602, message: 'task not found' });
    expect((await mcp('tasks/cancel', { taskId: t.result.taskId }, { caps: TASKS })).result).toEqual({ resultType: 'complete' });
    expect(await waitStatus(unproject(t.result.taskId), ['cancelled'])).toBe('cancelled');
    expect((await mcp('tasks/get', { taskId: t.result.taskId }, { caps: TASKS })).result.status).toBe('cancelled');
  });
  it('a disconnect before the answer cancels the run with reason mcp-request-cancelled', async () => {
    const before = new Set(((await rest('/runs?workflowId=conformance-delay&limit=100')).runs as Array<{ runId: string }>).map((r) => r.runId));
    const ac = new AbortController();
    const call = fetch(`${B}/mcp`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'Mcp-Method': 'tools/call', 'MCP-Protocol-Version': REV, Authorization: `Bearer ${K}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'conformance-delay', arguments: { delayMs: 5000 }, _meta: { 'io.modelcontextprotocol/protocolVersion': REV, 'io.modelcontextprotocol/clientCapabilities': {} } } }) }).catch(() => undefined);
    let runId: string | undefined;
    for (let i = 0; i < 40 && runId === undefined; i++) {
      runId = ((await rest('/runs?workflowId=conformance-delay&limit=100')).runs as Array<{ runId: string }>).map((r) => r.runId).find((r) => !before.has(r));
      if (runId === undefined) await new Promise((ok) => setTimeout(ok, 25));
    }
    ac.abort();
    await call;
    expect(await waitStatus(runId as string, ['cancelled', 'completed'])).toBe('cancelled');
    expect((await events(runId as string)).find((e) => e.type === 'run.cancelled')?.payload.reason).toBe('mcp-request-cancelled');
  });
});
