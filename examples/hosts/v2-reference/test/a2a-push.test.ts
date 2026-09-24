/**
 * RFC 0214 — A2A push notifications (a2a-push.ts). Each rule is asserted at a
 * REAL listener the host must (or must not) reach, never on a predicate's
 * return value:
 *   - unadvertised: all four push-config methods are -32003;
 *   - delivery: a StreamResponse statusUpdate, application/a2a+json, the
 *     config's Authorization, no OpenWOP signature, on each state change;
 *   - secrets: a read never returns `token` / `authentication.credentials`,
 *     and neither appears in GetTask or the event log;
 *   - the credential is dropped when the task reaches a terminal state;
 *   - a foreign-tenant read is byte-identical to an unknown id; delete is idempotent;
 *   - a 3xx is a failed delivery — the redirect target sees nothing;
 *   - delivery re-resolves: a registered name that later resolves to loopback
 *     gets ZERO connections (DNS rebinding);
 *   - no fork (replay or branch) pushes.
 */
import dns from 'node:dns';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const K = 'test-key-push';
const KB = 'test-key-push-tenant-b';
const SECRET = 's3cret-push-credential-7f1c';
const TOKEN = 'tok-push-9d2e';

interface Hit { headers: IncomingHttpHeaders; body: string }
interface Receiver { url: string; hits: Hit[]; close(): Promise<void> }
async function receiver(respond: (res: import('node:http').ServerResponse) => void = (res) => { res.writeHead(200); res.end(); }): Promise<Receiver> {
  const hits: Hit[] = [];
  const s: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); respond(res); });
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  const a = s.address(); const port = typeof a === 'object' && a ? a.port : 0;
  return { url: `http://127.0.0.1:${port}/hook`, hits, close: () => new Promise<void>((ok) => s.close(() => ok())) };
}

async function rpc(base: string, method: string, params: unknown, key = K): Promise<{ result?: any; error?: { code: number; message: string; data?: unknown } }> {
  const r = await fetch(`${base}/a2a/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return await r.json() as { result?: any; error?: { code: number; message: string } };
}
const msg = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: 'ROLE_USER', parts: [{ text: 'hi' }], ...extra });
const accept = (taskId: string): Record<string, unknown> => msg({ taskId, parts: [{ data: { action: 'accept' } }] });
const until = async (cond: () => boolean, ms = 6000): Promise<boolean> => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) return false; await new Promise((ok) => setTimeout(ok, 25)); } return true; };
const settle = (ms = 600): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

/** A task waiting for input (the routed workflow is conformance-approval). */
async function suspendedTask(base: string): Promise<string> {
  const r = await rpc(base, 'SendMessage', { message: msg() });
  expect(r.result?.task?.status?.state).toBe('TASK_STATE_INPUT_REQUIRED');
  return r.result.task.id as string;
}

describe('push unadvertised (the default): all four methods are -32003', () => {
  let h: RunningHost; let B = '';
  beforeAll(async () => { h = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 }); B = `http://127.0.0.1:${h.port}`; });
  afterAll(async () => { await h.close(); });
  it('refuses Create/Get/List/Delete with PushNotificationNotSupportedError and the card says false', async () => {
    for (const m of ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']) {
      expect((await rpc(B, m, { taskId: 'x', id: 'y', url: 'https://example.com/' })).error?.code).toBe(-32003);
    }
    const card = await (await fetch(`${B}/.well-known/agent-card.json`)).json() as { capabilities: { pushNotifications: boolean } };
    expect(card.capabilities.pushNotifications).toBe(false);
  });
});

describe('push advertised (guard opened for loopback receivers)', () => {
  let h: RunningHost; let B = '';
  beforeAll(async () => {
    h = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, tenantBApiKey: KB, devValidate: 'strict', rateLimitPerMinute: 100_000, a2aPush: true, webhookAllowPrivate: true, webhookMaxAttempts: 2, webhookBackoffBaseMs: 20 });
    B = `http://127.0.0.1:${h.port}`;
  });
  afterAll(async () => { await h.close(); });
  const receivers: Receiver[] = [];
  afterEach(async () => { for (const r of receivers.splice(0)) await r.close(); });

  it('advertises pushNotifications on the card and in discovery', async () => {
    const card = await (await fetch(`${B}/.well-known/agent-card.json`)).json() as { capabilities: { pushNotifications: boolean } };
    expect(card.capabilities.pushNotifications).toBe(true);
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { a2a: { pushNotifications: boolean } };
    expect(d.a2a.pushNotifications).toBe(true);
  });

  it('delivers a StreamResponse statusUpdate with the config credential, no OpenWOP signature, and drops the credential at terminal', async () => {
    const rx = await receiver(); receivers.push(rx);
    const taskId = await suspendedTask(B);
    const created = await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: rx.url, authentication: { scheme: 'Bearer', credentials: SECRET } });
    expect(created.error).toBeUndefined();
    const id = created.result.id as string;
    expect(id).toMatch(/^pnc-/);
    expect(JSON.stringify(created.result)).not.toContain(SECRET);
    await rpc(B, 'SendMessage', { message: accept(taskId) });
    expect(await until(() => rx.hits.some((x) => (JSON.parse(x.body) as any).statusUpdate?.status?.state === 'TASK_STATE_COMPLETED'))).toBe(true);
    const hit = rx.hits.find((x) => (JSON.parse(x.body) as any).statusUpdate?.status?.state === 'TASK_STATE_COMPLETED') as Hit;
    expect(hit.headers['content-type']).toBe('application/a2a+json');
    expect(hit.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(hit.headers).filter((k) => /openwop-signature|webhook-signature/i.test(k))).toEqual([]);
    expect((JSON.parse(hit.body) as any).statusUpdate.taskId).toBe(taskId);
    // terminal: the config and its destination credential are gone
    await settle(200);
    expect((await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id })).error?.code).toBe(-32001);
  });

  it('never returns token or credentials, and neither enters GetTask or the event log', async () => {
    const rx = await receiver(); receivers.push(rx);
    const taskId = await suspendedTask(B);
    const c1 = await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: rx.url, token: TOKEN });
    const c2 = await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: rx.url, authentication: { scheme: 'Basic', credentials: SECRET } });
    const got = await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id: c2.result.id });
    const listed = await rpc(B, 'ListTaskPushNotificationConfigs', { taskId });
    expect(listed.result.configs).toHaveLength(2);
    expect(got.result.authentication).toEqual({ scheme: 'Basic' });
    const task = await rpc(B, 'GetTask', { id: taskId });
    const log = await (await fetch(`${B}/runs/${encodeURIComponent(taskId)}/events/poll`, { headers: { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0' } })).text();
    for (const s of [JSON.stringify(c1.result), JSON.stringify(c2.result), JSON.stringify(got.result), JSON.stringify(listed.result), JSON.stringify(task.result), log]) {
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain(TOKEN);
    }
    // token-only config: carried as Authorization: Bearer <token> (interop.md SHOULD)
    await rpc(B, 'DeleteTaskPushNotificationConfig', { taskId, id: c2.result.id });
    await rpc(B, 'SendMessage', { message: accept(taskId) });
    expect(await until(() => rx.hits.length > 0)).toBe(true);
    expect(rx.hits[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('a foreign-tenant read is byte-identical to an unknown id; delete is idempotent everywhere', async () => {
    const rx = await receiver(); receivers.push(rx);
    const taskId = await suspendedTask(B);
    const c = await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: rx.url });
    const foreign = await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id: c.result.id }, KB);
    const unknown = await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id: 'pnc-does-not-exist' });
    const wrongTask = await rpc(B, 'GetTaskPushNotificationConfig', { taskId: 'nope', id: c.result.id });
    expect(foreign.error).toEqual(unknown.error);
    expect(wrongTask.error).toEqual(unknown.error);
    expect(unknown.error?.code).toBe(-32001);
    // a foreign delete changes nothing and answers like any other
    expect((await rpc(B, 'DeleteTaskPushNotificationConfig', { taskId, id: c.result.id }, KB)).result).toEqual({});
    expect((await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id: c.result.id })).result?.id).toBe(c.result.id);
    expect((await rpc(B, 'DeleteTaskPushNotificationConfig', { taskId, id: c.result.id })).result).toEqual({});
    expect((await rpc(B, 'DeleteTaskPushNotificationConfig', { taskId, id: c.result.id })).result).toEqual({});
    expect((await rpc(B, 'GetTaskPushNotificationConfig', { taskId, id: c.result.id })).error?.code).toBe(-32001);
  });

  it('a 3xx is a failed delivery: the redirect target sees nothing', async () => {
    const target = await receiver(); receivers.push(target);
    const redirector = await receiver((res) => { res.writeHead(307, { Location: target.url }); res.end(); }); receivers.push(redirector);
    const taskId = await suspendedTask(B);
    await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: redirector.url, authentication: { scheme: 'Bearer', credentials: SECRET } });
    await rpc(B, 'SendMessage', { message: accept(taskId) });
    expect(await until(() => redirector.hits.length >= 2)).toBe(true); // retried (maxAttempts 2), each a failure
    await settle(300);
    expect(target.hits).toHaveLength(0);
  });

  it('no fork pushes: replay and branch forks of a pushed task deliver nothing', async () => {
    const rx = await receiver(); receivers.push(rx);
    const taskId = await suspendedTask(B);
    await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: rx.url });
    const post = (body: unknown): Promise<Response> => fetch(`${B}/runs/${encodeURIComponent(taskId)}:fork`, { method: 'POST', headers: { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ mode: 'replay' })).status).toBeLessThan(300);
    expect((await post({ mode: 'branch', fromSeq: 0 })).status).toBeLessThan(300);
    await settle(1200);
    expect(rx.hits).toHaveLength(0);
  });
});

describe('push advertised, guard CLOSED', () => {
  let h: RunningHost; let B = '';
  beforeAll(async () => {
    h = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000, a2aPush: true, webhookAllowPrivate: false, webhookMaxAttempts: 2, webhookBackoffBaseMs: 20 });
    B = `http://127.0.0.1:${h.port}`;
  });
  afterAll(async () => { await h.close(); vi.restoreAllMocks(); });

  it('refuses a non-https, loopback or private URL at registration', async () => {
    const taskId = await suspendedTask(B);
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://10.0.0.1/hook', 'https://localhost/hook', 'https://169.254.169.254/latest']) {
      expect((await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url })).error?.code).toBe(-32602);
    }
  });

  it('re-resolves at delivery: a registered name that now resolves to loopback gets zero connections (DNS rebinding)', async () => {
    let connections = 0;
    const tcp: TcpServer = createTcpServer((sock) => { connections++; sock.destroy(); });
    await new Promise<void>((ok) => tcp.listen(0, '127.0.0.1', () => ok()));
    const a = tcp.address(); const port = typeof a === 'object' && a ? a.port : 0;
    try {
      const taskId = await suspendedTask(B);
      // registration passes: https, and a name that is not on the deny list
      const c = await rpc(B, 'CreateTaskPushNotificationConfig', { taskId, url: `https://rebind.push-test.example:${port}/hook` });
      expect(c.error).toBeUndefined();
      // at delivery the name resolves to loopback
      const lookup = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
      await rpc(B, 'SendMessage', { message: accept(taskId) });
      expect(await until(() => lookup.mock.calls.length >= 1)).toBe(true);
      await settle(500);
      expect(connections).toBe(0);
      lookup.mockRestore();
    } finally {
      await new Promise<void>((ok) => tcp.close(() => ok()));
    }
  });
});
