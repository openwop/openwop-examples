/**
 * RFC 0257 — a run whose every terminal node is skipped (run-event-payloads.schema.json
 * `$defs/runCompleted.skippedTerminals`). The suite's v2-all-terminals-skipped scenario
 * witnesses it; this file pins the host's half: a triggerRule skip and an EdgeCondition
 * skip both complete with the marker, a completed terminal carries none, and a replay
 * fork ends with the same event and list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0257';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const ROUTE_ONLY = 'conformance-error-route-only';
const CONDITION = 'conformance-all-terminals-skipped';

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

async function terminalOf(runId: string): Promise<{ events: any[]; last: any }> {
  for (let i = 0; i < 80; i++) {
    const p = (await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: H })).json()) as any;
    const last = p.events.find((e: any) => e.type === 'run.completed' || e.type === 'run.failed');
    if (last) return { events: p.events, last };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not end`);
}
async function start(workflowId: string, inputs?: Record<string, unknown>): Promise<string> {
  const c = await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify(inputs ? { workflowId, inputs } : { workflowId }) });
  expect(c.status).toBe(201);
  return ((await c.json()) as any).runId as string;
}

describe('RFC 0257 — every terminal skipped', () => {
  it('advertises both fixtures', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    expect(d.fixtures).toEqual(expect.arrayContaining([ROUTE_ONLY, CONDITION]));
  });

  it('a triggerRule skip completes with skippedTerminals, and a replay fork ends the same', async () => {
    const runId = await start(ROUTE_ONLY);
    const { last } = await terminalOf(runId);
    expect(last.type).toBe('run.completed');
    expect(last.payload.skippedTerminals).toEqual(['on-fail']);
    const f = await fetch(`${B}/runs/${encodeURIComponent(runId)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) });
    expect(f.status).toBeLessThan(300);
    const replayed = await terminalOf(((await f.json()) as any).runId as string);
    expect(replayed.last.type).toBe('run.completed');
    expect(replayed.last.payload.skippedTerminals).toEqual(['on-fail']);
  });

  it('a declined EdgeCondition skips act; a satisfied one runs it and carries no marker', async () => {
    const declined = await terminalOf(await start(CONDITION, { payload: { ok: false } }));
    expect(declined.last.type).toBe('run.completed');
    expect(declined.last.payload.skippedTerminals).toEqual(['act']);
    expect(declined.events.some((e: any) => e.type === 'node.started' && e.nodeId === 'act')).toBe(false);

    const ran = await terminalOf(await start(CONDITION, { payload: { ok: true } }));
    expect(ran.last.type).toBe('run.completed');
    expect('skippedTerminals' in ran.last.payload).toBe(false);
    expect(ran.events.some((e: any) => e.type === 'node.completed' && e.nodeId === 'act')).toBe(true);
    const check = ran.events.find((e: any) => e.type === 'node.completed' && e.nodeId === 'check');
    expect(check.payload.outputs).toEqual({ payload: { ok: true } });
  });

  it('a completed run with a completed terminal carries no marker', async () => {
    const { last } = await terminalOf(await start('conformance-noop'));
    expect(last.type).toBe('run.completed');
    expect('skippedTerminals' in last.payload).toBe(false);
  });
});
