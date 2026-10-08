/**
 * RFC 0237 — declared nondeterminism (replay.md §Declared nondeterminism).
 * The suite's v2-nondeterminism-sources scenario witnesses it; this file pins the
 * host's half: `nondeterminismPolicy` lists the drawn sources, the fixture's run
 * outputs one value per source, and a replay fork reproduces each while a branch
 * draws afresh.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { DECLARED_SOURCES } from '../src/nondeterminism.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0237';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const FIXTURE = 'conformance-nondeterminism';

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

async function completedOutputs(runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 80; i++) {
    const p = (await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: H })).json()) as any;
    const done = p.events.find((e: any) => e.type === 'run.completed');
    if (done) return done.payload.outputs;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not complete`);
}
async function fork(runId: string, mode: 'replay' | 'branch'): Promise<string> {
  const r = await fetch(`${B}/runs/${encodeURIComponent(runId)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ mode, fromSeq: 0 }) });
  expect(r.status).toBeLessThan(300);
  return ((await r.json()) as any).runId as string;
}

describe('RFC 0237 — declared nondeterminism', () => {
  it('lists the drawn sources, and a replay fork reproduces each while a branch draws afresh', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    if (!d.fixtures.includes(FIXTURE)) return; // the installed suite ships no nondeterminism fixture
    expect(d.nondeterminismPolicy).toMatchObject({ declared: true, sources: [...DECLARED_SOURCES] });
    const c = await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: FIXTURE }) });
    expect(c.status).toBe(201);
    const runId = ((await c.json()) as any).runId as string;
    const first = await completedOutputs(runId);
    for (const s of DECLARED_SOURCES) expect(typeof first[s]).toBe('string');
    const replayed = await completedOutputs(await fork(runId, 'replay'));
    for (const s of DECLARED_SOURCES) expect(replayed[s]).toBe(first[s]);
    const branched = await completedOutputs(await fork(runId, 'branch'));
    expect(branched['random']).not.toBe(first['random']);
  });
});
