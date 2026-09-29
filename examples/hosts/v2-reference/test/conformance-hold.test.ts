/**
 * core.conformance.hold (suite 2.44.4): a reserved, pure node that completes after
 * inputs.delayMs with its inputs as its outputs, performs nothing observable
 * outside the log, is never side-effecting, and re-executes live on replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const K = 'k-hold';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
let running: RunningHost;
let B = '';
const enc = encodeURIComponent;
beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K });
  B = `http://127.0.0.1:${running.port}`;
  (running.host.workflows as Map<string, unknown>).set('hold-test', {
    id: 'hold-test', name: 'hold', version: '1.0', variables: [], edges: [],
    nodes: [{ id: 'hold', typeId: 'core.conformance.hold', config: {}, inputs: { delayMs: { value: 250 }, greeting: { value: 'hi' }, n: { value: 3 } } }],
  });
});
afterAll(async () => { await running.close(); });

const get = async (p: string): Promise<any> => (await fetch(`${B}${p}`, { headers: H })).json();
async function terminal(runId: string): Promise<any> {
  for (let i = 0; i < 100; i++) { const s = await get(`/runs/${enc(runId)}`); if (['completed', 'failed', 'cancelled'].includes(s.status)) return s; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}

describe('core.conformance.hold', () => {
  it('holds for delayMs and completes with its inputs as outputs, with no effect recorded', async () => {
    const t0 = Date.now();
    const c = await (await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: 'hold-test' }) })).json() as { runId: string };
    expect((await terminal(c.runId))?.status).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const evs = (await get(`/runs/${enc(c.runId)}/events/poll?timeout=1`)).events as Array<{ type: string; payload: any }>;
    expect(evs.find((e) => e.type === 'node.completed')?.payload.outputs).toEqual({ delayMs: 250, greeting: 'hi', n: 3 });
    expect((await get(`/runs/${enc(c.runId)}/effects`)).effects).toEqual([]);
  });
  it('re-executes live on a replay fork: a fresh node.started and completion, nothing suppressed', async () => {
    const c = await (await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: 'hold-test' }) })).json() as { runId: string };
    await terminal(c.runId);
    const f = await (await fetch(`${B}/runs/${enc(c.runId)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'replay', fromSeq: 1 }) })).json() as { runId: string };
    expect((await terminal(f.runId))?.status).toBe('completed');
    const evs = (await get(`/runs/${enc(f.runId)}/events/poll?timeout=1`)).events as Array<{ type: string; payload: any }>;
    expect(evs.map((e) => e.type)).toEqual(['run.started', 'node.started', 'node.completed', 'run.completed']);
    expect(evs.find((e) => e.type === 'node.completed')?.payload.outputs).toEqual({ delayMs: 250, greeting: 'hi', n: 3 });
    expect((await get(`/runs/${enc(f.runId)}/effects`)).effects).toEqual([]);
  });
  it('is not advertised: no honoured fixture uses it yet', async () => {
    const d = await get('/.well-known/openwop');
    for (const id of (d.fixtures as string[]).filter((f) => f !== 'hold-test')) { // hold-test is registered by this file
      const def = running.host.workflows.get(id) as { nodes: Array<{ typeId: string }> } | undefined;
      expect(def?.nodes.some((n) => n.typeId === 'core.conformance.hold') ?? false, id).toBe(false);
    }
  });
});
