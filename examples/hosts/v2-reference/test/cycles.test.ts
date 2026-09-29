/**
 * Cycles in the scheduler: a node reached again over an edge is re-opened and
 * executed again, each visit with its own execution ordinal and interrupt key,
 * bounded by configurable.run.recursionLimit (runs.md §`run` section).
 *   - RFC 0223 G11 (conformance-approval-reject-loopback): a rejected gate routed
 *     through `revise` back to itself is asked AGAIN under a NEW key
 *     (interrupt.md §Re-entry and resume values) and never replays the rejection.
 *   - openwop#1718 (conformance-replay-ordinal-loop): a looped side-effecting node
 *     records one outcome per execution; a replay fork resolves each by its own
 *     ordinal and fails closed where the source recorded none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const K = 'k-cycles';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
let running: RunningHost;
let B = '';
const enc = encodeURIComponent;
beforeAll(async () => { running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K }); B = `http://127.0.0.1:${running.port}`; });
afterAll(async () => { await running.close(); });

const call = async (method: string, path: string, body?: unknown): Promise<{ s: number; b: any }> => {
  const r = await fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text(); let b: unknown; try { b = JSON.parse(t); } catch { b = t; } return { s: r.status, b };
};
const events = async (runId: string): Promise<any[]> => (await call('GET', `/runs/${enc(runId)}/events/poll?timeout=1`)).b.events;
async function until(pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
const status = async (runId: string): Promise<string> => (await call('GET', `/runs/${enc(runId)}`)).b.status;
const LOOP = { configurable: { version: 1, run: { recursionLimit: 20 } } };

describe('the loop fixtures are advertised (v2 root only)', () => {
  it('both are in the v2 fixtures[] and not in the v1 one', async () => {
    const v2 = (await call('GET', '/.well-known/openwop')).b.fixtures as string[];
    const v1 = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '1' } })).json() as { fixtures: string[] }).fixtures;
    for (const f of ['conformance-approval-reject-loopback', 'conformance-replay-ordinal-loop']) { expect(v2, f).toContain(f); expect(v1, f).not.toContain(f); }
  });
});

describe('RFC 0223 G11 — a rejected gate looped back is asked again under a new key', () => {
  it('reject → revise → gate raises a NEW interrupt.requested with a DIFFERENT key, waits again, and applies no stale resolve', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-approval-reject-loopback', ...LOOP });
    expect(c.s).toBe(201);
    expect(await until(async () => (await status(c.b.runId)) === 'waiting-approval')).toBe(true);
    expect((await call('POST', `/runs/${enc(c.b.runId)}/interrupts/gate`, { resumeValue: { action: 'reject' } })).s).toBe(200);
    const requests = async (): Promise<any[]> => (await events(c.b.runId)).filter((e) => e.type === 'interrupt.requested' && e.nodeId === 'gate');
    expect(await until(async () => (await requests()).length === 2 && (await status(c.b.runId)) === 'waiting-approval')).toBe(true);
    const [first, second] = await requests();
    expect(second.payload.key).not.toBe(first.payload.key);
    const evs = await events(c.b.runId);
    expect(evs.filter((e) => e.type === 'interrupt.resolved').length).toBe(1);
    // The loop path is visible: gate failed (routed), revise ran, gate started again.
    expect(evs.filter((e) => e.nodeId === 'gate' && e.type === 'node.started').length).toBe(2);
    expect(evs.some((e) => e.nodeId === 'revise' && e.type === 'node.completed')).toBe(true);
    // Resolving the SECOND visit accepts it: the gate completes, revise is skipped, the run completes.
    expect((await call('POST', `/runs/${enc(c.b.runId)}/interrupts/gate`, { resumeValue: { action: 'accept' } })).s).toBe(200);
    expect(await until(async () => (await status(c.b.runId)) === 'completed')).toBe(true);
    const after = await events(c.b.runId);
    expect(after.filter((e) => e.type === 'interrupt.resolved').map((e) => e.payload.decision)).toEqual(['rejected', 'granted']);
  });
});

describe('recursionLimit bounds a cycle (runs.md §`run` section)', () => {
  it('a loop with no other bound fails recursion_limit_exceeded after cap.breached { node-executions }', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-replay-ordinal-loop', inputs: { delayMs: 10 }, configurable: { version: 1, run: { recursionLimit: 7 } } });
    expect(c.s).toBe(201);
    expect(await until(async () => (await status(c.b.runId)) === 'failed')).toBe(true);
    const snap = (await call('GET', `/runs/${enc(c.b.runId)}`)).b;
    expect(snap.error.code).toBe('recursion_limit_exceeded');
    const evs = await events(c.b.runId);
    expect(evs.filter((e) => e.type === 'node.started').length).toBe(7);
    expect(evs.find((e) => e.type === 'cap.breached')?.payload).toEqual({ kind: 'node-executions', limit: 7, observed: 8 });
    // Each execution of the looped side effect recorded its own outcome, under its own ordinal.
    const ledger = running.host.store.effectsForRun(c.b.runId).map((e) => e.execution);
    expect(ledger).toEqual([1, 2, 3]);
  });
});

describe('openwop#1718 — a replay resolves each looped execution by its own ordinal', () => {
  it('source cancelled inside wait after effect\'s first execution; the fork resolves n = 1 and fails n = 2 closed', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-replay-ordinal-loop', inputs: { delayMs: 1500 }, ...LOOP });
    expect(c.s).toBe(201);
    expect(await until(async () => (await events(c.b.runId)).some((e) => e.nodeId === 'effect' && e.type === 'node.completed'))).toBe(true);
    await call('POST', `/runs/${enc(c.b.runId)}/cancel`, {});
    expect(await until(async () => (await status(c.b.runId)) === 'cancelled')).toBe(true);
    const src = await events(c.b.runId);
    expect(src.filter((e) => e.nodeId === 'effect' && e.type === 'node.started').length).toBe(1);
    const at = src.find((e) => e.nodeId === 'effect' && e.type === 'node.started').sequence;
    const f = await call('POST', `/runs/${enc(c.b.runId)}:fork`, { mode: 'replay', fromSeq: at });
    expect(f.s).toBe(201);
    expect(await until(async () => ['completed', 'failed', 'cancelled'].includes(await status(f.b.runId)), 15_000)).toBe(true);
    const fork = (await events(f.b.runId)).filter((e) => e.nodeId === 'effect');
    expect(fork.filter((e) => e.type === 'node.completed').length).toBe(1);
    expect(fork.find((e) => e.type === 'node.completed').payload.outputs).toMatchObject({ suppressed: true });
    expect(fork.find((e) => e.type === 'node.failed')?.payload.error.code).toBe('replay_source_missing');
    expect((await call('GET', `/runs/${enc(f.b.runId)}`)).b.status).toBe('failed');
  }, 30_000);
});
