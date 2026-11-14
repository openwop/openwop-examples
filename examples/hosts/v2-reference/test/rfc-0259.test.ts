/**
 * RFC 0259 — `interrupt.resolved.resolvedVia` (run-event-payloads.schema.json
 * `$defs/interruptResolved.resolvedVia`). The suite's v2-interrupt-resolved-via
 * scenario witnesses it through the readInterruptToken seam; this file pins the
 * host's half: a token resolution records the scheme and no resolvedBy, a binding
 * the host made records boundTo, an altered one binds no one, a run-scoped
 * resolution records nothing, and an approversList gate refuses an unbound token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0259';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const ANON = { 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const SEAM = '/conformance/seams/sample/interrupts/token';

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = H): Promise<Response> => fetch(`${B}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

async function events(runId: string): Promise<any[]> {
  return ((await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: H })).json()) as any).events;
}
async function waitFor(runId: string, pred: (e: any) => boolean): Promise<any> {
  for (let i = 0; i < 80; i++) {
    const e = (await events(runId)).find(pred);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId}: event not seen`);
}
async function suspended(workflowId = 'conformance-approval'): Promise<{ runId: string; nodeId: string }> {
  const c = await post('/runs', { workflowId });
  expect(c.status).toBe(201);
  const runId = ((await c.json()) as any).runId as string;
  const req = await waitFor(runId, (e) => e.type === 'interrupt.requested');
  return { runId, nodeId: req.nodeId as string };
}
async function seam(runId: string, nodeId: string, bind = false): Promise<any> {
  const r = await post(SEAM, { runId, nodeId, ...(bind ? { bind: true } : {}) });
  expect(r.status).toBe(200);
  return r.json();
}
const resolvedOf = (runId: string): Promise<any> => waitFor(runId, (e) => e.type === 'interrupt.resolved');

describe('RFC 0259 — resolvedVia', () => {
  it('advertises interrupt.resolvedVia', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    expect(d.interrupt.resolvedVia).toBe(true);
  });

  it('an unbound token resolution records scheme interrupt-token, no boundTo and no resolvedBy', async () => {
    const { runId, nodeId } = await suspended();
    const { token, resumeValueMembers } = await seam(runId, nodeId);
    expect(resumeValueMembers).toBeUndefined();
    expect((await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept' } }, ANON)).status).toBe(200);
    const p = (await resolvedOf(runId)).payload;
    expect(p.resolvedVia).toEqual({ scheme: 'interrupt-token' });
    expect(p.resolvedBy).toBeUndefined();
  });

  it('a binding the host made records boundTo equal to the owner subject, and leaves the resume value clean', async () => {
    const { runId, nodeId } = await suspended();
    const { token, resumeValueMembers } = await seam(runId, nodeId, true);
    expect((await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept', ...resumeValueMembers } }, ANON)).status).toBe(200);
    const p = (await resolvedOf(runId)).payload;
    const owner = (await events(runId)).find((e) => e.type === 'run.started').payload.owner.subject;
    expect(p.resolvedVia.boundTo).toEqual(owner);
    expect(p.resolvedBy).toBeUndefined();
    expect(p.resumeValue).toEqual({ action: 'accept' });
  });

  it('a binding altered by one character binds no one', async () => {
    const { runId, nodeId } = await suspended();
    const { token, resumeValueMembers } = await seam(runId, nodeId, true);
    const forged = Object.fromEntries(Object.entries(resumeValueMembers as Record<string, string>).map(([k, v]) => [k, `${v.slice(0, -1)}${v.endsWith('x') ? 'y' : 'x'}`]));
    expect((await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept', ...forged } }, ANON)).status).toBe(200);
    const p = (await resolvedOf(runId)).payload;
    expect(p.resolvedVia).toEqual({ scheme: 'interrupt-token' });
  });

  it('a run-scoped resolution records no resolvedVia', async () => {
    const { runId, nodeId } = await suspended();
    expect((await post(`/runs/${encodeURIComponent(runId)}/interrupts/${encodeURIComponent(nodeId)}`, { resumeValue: { action: 'accept' } })).status).toBe(200);
    const p = (await resolvedOf(runId)).payload;
    expect(p.resolvedVia).toBeUndefined();
    expect(p.resolvedBy).toBeDefined();
  });

  it('an approversList gate refuses a token resolution bound to no listed approver', async () => {
    const { runId, nodeId } = await suspended('conformance-approval-approvers');
    const { token, resumeValueMembers } = await seam(runId, nodeId, true);
    expect((await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept' } }, ANON)).status).toBe(403);
    expect((await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept', ...resumeValueMembers } }, ANON)).status).toBe(403);
    expect((await events(runId)).some((e) => e.type === 'interrupt.resolved')).toBe(false);
  });

  it('the seam answers 404 once the interrupt is resolved', async () => {
    const { runId, nodeId } = await suspended();
    const { token } = await seam(runId, nodeId);
    await post(`/interrupts/${encodeURIComponent(token)}`, { resumeValue: { action: 'accept' } }, ANON);
    await resolvedOf(runId);
    expect((await post(SEAM, { runId, nodeId })).status).toBe(404);
  });
});
