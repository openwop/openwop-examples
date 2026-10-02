/**
 * runs.md §`budget` section (budget.ts): the run budget over the `toolCalls`
 * dimension, driven through `createRun` with the suite's
 * `conformance-budget-tool-calls` fixture (three scripted tool calls).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const KEY = 'k-budget';
let h: RunningHost;
beforeAll(async () => { h = await startHost({ port: 0, dbPath: ':memory:', apiKey: KEY }); });
afterAll(async () => { await h.close(); });

const base = (): string => `http://127.0.0.1:${h.port}`;
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
async function create(budget: unknown): Promise<Response> {
  return fetch(`${base()}/runs`, { method: 'POST', headers, body: JSON.stringify({ workflowId: 'conformance-budget-tool-calls', ...(budget === undefined ? {} : { configurable: { version: 1, budget } }) }) });
}
async function finished(runId: string): Promise<{ status: string; error?: { code: string } }> {
  for (let i = 0; i < 80; i++) {
    const snap = await (await fetch(`${base()}/runs/${encodeURIComponent(runId)}`, { headers })).json() as { status: string; error?: { code: string } };
    if (['completed', 'failed', 'cancelled'].includes(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run did not end');
}
async function types(runId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const body = await (await fetch(`${base()}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers })).json() as { events: Array<{ type: string; payload: Record<string, unknown> }> };
  return body.events;
}

describe('the run budget over toolCalls', () => {
  it('discovery advertises the one dimension the host enforces, and the fixture', async () => {
    const doc = await (await fetch(`${base()}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { budget: Record<string, unknown>; fixtures: string[] };
    expect(doc.budget['dimensions']).toEqual(['toolCalls']);
    expect(doc.budget['enforce']).toBe('hard');
    expect(doc.budget['scopes']).toEqual(['run']);
    expect(doc.fixtures).toContain('conformance-budget-tool-calls');
  });

  it('a two-call budget on three calls: reserved, threshold, exhausted, cap.breached, then the run fails budget_exhausted', async () => {
    const res = await create({ maxToolCalls: 2, thresholdPercent: 50, onExhaustion: 'fail' });
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    const snap = await finished(runId);
    expect(snap.status).toBe('failed');
    expect(snap.error?.code).toBe('budget_exhausted');
    const ev = await types(runId);
    const at = (t: string): number => ev.findIndex((e) => e.type === t);
    expect(at('budget.reserved')).toBeGreaterThan(-1);
    expect(at('budget.reserved')).toBeLessThan(at('budget.threshold-crossed'));
    expect(at('budget.threshold-crossed')).toBeLessThan(at('budget.exhausted'));
    expect(at('budget.exhausted')).toBeLessThan(at('cap.breached'));
    expect(ev.filter((e) => e.type === 'agent.tool-called')).toHaveLength(2); // the third call was never made
    expect(ev.filter((e) => e.type === 'budget.threshold-crossed')).toHaveLength(1);
    const breach = ev.find((e) => e.type === 'cap.breached');
    expect(breach?.payload).toMatchObject({ kind: 'budget-tool-calls', limit: 2, observed: 3 });
    expect(ev.find((e) => e.type === 'budget.reserved')?.payload).toMatchObject({ scope: 'run', effectiveBudget: { maxToolCalls: 2 } });
  });

  it('a budget that exactly covers the run is not exhausted', async () => {
    const { runId } = await (await create({ maxToolCalls: 3 })).json() as { runId: string };
    expect((await finished(runId)).status).toBe('completed');
    const ev = await types(runId);
    expect(ev.some((e) => e.type === 'budget.exhausted' || e.type === 'cap.breached')).toBe(false);
    expect(ev.filter((e) => e.type === 'agent.tool-called')).toHaveLength(3);
  });

  it('no budget: the run completes and emits no budget event', async () => {
    const { runId } = await (await create(undefined)).json() as { runId: string };
    expect((await finished(runId)).status).toBe('completed');
    expect((await types(runId)).some((e) => e.type.startsWith('budget.'))).toBe(false);
  });

  it('onExhaustion: interrupt is refused, not ignored; an unknown key is a validation error', async () => {
    const interrupt = await create({ maxToolCalls: 2, onExhaustion: 'interrupt' });
    expect(interrupt.status).toBe(422);
    expect((await interrupt.json() as { error: string }).error).toBe('capability_not_provided');
    const unknown = await create({ maxToolCalls: 2, maxWidgets: 1 });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: string }).error).toBe('validation_error');
  });
});
