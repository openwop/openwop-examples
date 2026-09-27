/**
 * RFC 0173 §C.2 / replay.md §Suppression rule 1 — a `replay` fork of a run that
 * fired the guarded `http.fetch` seam records NO attempt the source did not
 * make. The fork's ledger carries the source's attempts as inherited history —
 * same `(nodeId, attempt, at)` and state — and the replay makes no outbound
 * call. Until 2026-09-27 the fork wrote a row stamped `at: now()` and
 * `state: completed`, which the suite's re-fire witness (and any reader of
 * GET /runs/{runId}/effects) reads as a new attempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-replay-guarded-seam';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };

interface EffectRow { nodeId: string; attempt: number; at: string; state: string; invocationId?: string }

async function call(method: string, path: string, body?: unknown): Promise<{ s: number; b: any }> {
  const r = await fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  return { s: r.status, b };
}

async function terminal(runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', `/runs/${encodeURIComponent(runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(String(r.b?.status))) return;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`run ${runId} never reached a terminal status`);
}

const effects = async (runId: string): Promise<EffectRow[]> => (await call('GET', `/runs/${encodeURIComponent(runId)}/effects`)).b.effects as EffectRow[];
const key = (e: EffectRow): string => `${e.nodeId}|${e.attempt}|${e.at}`;

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: true, rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('RFC 0173 §C.2 — a replay fork does not re-fire the guarded http.fetch seam', () => {
  it("the fork's ledger repeats the source's attempts exactly and adds none", async () => {
    const fired = await call('POST', '/conformance/seams/sample/effect-seams/fire', { seam: 'http.fetch' });
    expect(fired.s).toBe(201);
    const parentId = String(fired.b.runId);
    await terminal(parentId);
    const parent = await effects(parentId);
    expect(parent.length).toBeGreaterThan(0);

    const fork = await call('POST', `/runs/${encodeURIComponent(parentId)}:fork`, { mode: 'replay' });
    expect(fork.s).toBe(201);
    const forkId = String(fork.b.runId);
    await terminal(forkId);
    const forked = await effects(forkId);

    // Every fork row is one of the parent's attempts (multiset), same state.
    const available = new Map<string, EffectRow[]>();
    for (const p of parent) available.set(key(p), [...(available.get(key(p)) ?? []), p]);
    for (const f of forked) {
      const match = available.get(key(f))?.shift();
      expect(match, `fork row ${key(f)} is not a parent attempt — a re-fire on the host's own ledger`).toBeDefined();
      expect(f.state).toBe(match?.state);
      expect(f.invocationId).toBe(`replay-of:${parentId}`);
    }
    expect(forked.length).toBe(parent.length);
  });
});
