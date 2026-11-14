/**
 * RFC 0265 — a compensation unwind the suite causes unaided (fixture
 * `conformance-compensate-unwind`: e1 → e2 → e3, each a ledgered
 * `core.conformance.compensable-effect` with a node-level inverse, then `core.fail`).
 * The suite's v2-compensation-unwind scenario reads the event log,
 * `GET /runs/{runId}/compensation` and `GET /runs/{runId}/effects`; this file pins
 * the host's half of each leg: the fixture is advertised, the run fails and then
 * unwinds (requested before started), attempts run e3, e2, e1, the ledger holds
 * three inverse records with distinct ids beside the three forward ones, and a
 * `mode: "replay"` fork from the first event records no effect the source did not
 * make (replay.md §Suppression; invariant compensation-replay-no-refire).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0265';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const FIXTURE = 'conformance-compensate-unwind';
const EFFECT_NODES = ['e1', 'e2', 'e3'];

interface Ev { type: string; sequence: number; nodeId?: string; payload?: Record<string, unknown> }
interface LedgerRow { effectId: string; nodeId: string; attempt: number; at: string; invocationId?: string }
interface Projection { status: string; plan: Array<{ nodeId: string }>; attempts: Array<{ nodeId: string; outcome: string }> }

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

const enc = encodeURIComponent;
const getJson = async <T>(path: string): Promise<T> => (await (await fetch(`${B}${path}`, { headers: H })).json()) as T;
const events = async (runId: string): Promise<Ev[]> => (await getJson<{ events: Ev[] }>(`/runs/${enc(runId)}/events/poll?timeout=1`)).events;
const ledger = async (runId: string): Promise<LedgerRow[]> => (await getJson<{ effects: LedgerRow[] }>(`/runs/${enc(runId)}/effects`)).effects;
const projection = (runId: string): Promise<Projection> => getJson<Projection>(`/runs/${enc(runId)}/compensation`);

async function settled(runId: string): Promise<Ev[]> {
  for (let i = 0; i < 100; i++) {
    const log = await events(runId);
    if (log.some((e) => /^run\.(completed|failed|cancelled)$/.test(e.type))) return log;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not end`);
}

/** The suite's attribution (conformance/src/lib/compensation-unwind.ts splitLedger): each effect node's earliest row is its forward; `fail` rows are neither; the rest are inverses. */
function split(rows: readonly LedgerRow[]): { forward: Map<string, LedgerRow>; inverse: LedgerRow[] } {
  const forward = new Map<string, LedgerRow>();
  for (const n of EFFECT_NODES) {
    const first = rows.filter((r) => r.nodeId === n).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    if (first !== undefined) forward.set(n, first);
  }
  const fwd = new Set(forward.values());
  return { forward, inverse: rows.filter((r) => !fwd.has(r) && r.nodeId !== 'fail') };
}

/** The suite's refiredAttempts: fork rows that repeat no parent row's (nodeId, attempt, at). */
function refired(parent: readonly LedgerRow[], fork: readonly LedgerRow[]): LedgerRow[] {
  const key = (r: LedgerRow): string => `${r.nodeId}|${r.attempt}|${r.at}`;
  const avail = new Map<string, number>();
  for (const r of parent) avail.set(key(r), (avail.get(key(r)) ?? 0) + 1);
  return fork.filter((r) => {
    const n = avail.get(key(r)) ?? 0;
    if (n > 0) { avail.set(key(r), n - 1); return false; }
    return true;
  });
}

let source: Promise<{ runId: string; log: Ev[] }> | undefined;
const unwound = (): Promise<{ runId: string; log: Ev[] }> => (source ??= (async () => {
  const c = await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: FIXTURE }) });
  expect(c.status).toBe(201);
  const runId = ((await c.json()) as { runId: string }).runId;
  return { runId, log: await settled(runId) };
})());

describe('RFC 0265 — compensation unwind through a failing fixture', () => {
  it('advertises the fixture (compensation, idempotency and replay.modes ∋ replay are advertised too)', async () => {
    const d = await getJson<{ fixtures: string[]; compensation?: unknown; idempotency?: unknown; replay?: { modes?: string[] } }>('/.well-known/openwop');
    expect(d.fixtures).toContain(FIXTURE);
    expect(d.compensation).toBeDefined();
    expect(d.idempotency).toBeDefined();
    expect(d.replay?.modes).toContain('replay');
  });

  it('the run fails, then unwinds: compensation.requested precedes compensation.started, and the unwind completes', async () => {
    const { log } = await unwound();
    expect(log.some((e) => e.type === 'run.failed')).toBe(true);
    const requested = log.find((e) => e.type === 'compensation.requested');
    const started = log.find((e) => e.type === 'compensation.started');
    expect(requested).toBeDefined();
    expect(started).toBeDefined();
    expect((requested as Ev).sequence).toBeLessThan((started as Ev).sequence);
    expect(log.some((e) => e.type === 'compensation.completed')).toBe(true);
    const p = await projection((await unwound()).runId);
    expect(p.status).toBe('completed');
    expect([...new Set(p.plan.map((s) => s.nodeId))].sort()).toEqual(EFFECT_NODES);
  });

  it('attempts[] runs e3, e2, e1 — the reverse of forward completion — and every inverse succeeded', async () => {
    const { runId, log } = await unwound();
    const forward = log.filter((e) => e.type === 'node.completed' && typeof e.nodeId === 'string' && EFFECT_NODES.includes(e.nodeId)).map((e) => e.nodeId);
    expect(forward).toEqual(['e1', 'e2', 'e3']);
    const p = await projection(runId);
    expect(p.attempts.map((a) => a.nodeId)).toEqual(['e3', 'e2', 'e1']);
    expect(p.attempts.every((a) => a.outcome === 'succeeded')).toBe(true);
  });

  it('the effect ledger holds one forward record per effect node and exactly three inverse records with distinct effectIds', async () => {
    const { runId } = await unwound();
    const rows = await ledger(runId);
    const { forward, inverse } = split(rows);
    expect([...forward.keys()].sort()).toEqual(EFFECT_NODES);
    expect(inverse).toHaveLength(3);
    expect(new Set(inverse.map((r) => r.effectId)).size).toBe(3);
    // Each inverse is its own effect identity, never the forward's, and one per node.
    for (const r of inverse) expect([...forward.values()].some((f) => f.effectId === r.effectId)).toBe(false);
    expect(inverse.map((r) => r.nodeId).sort()).toEqual(EFFECT_NODES);
  });

  it('a mode: "replay" fork from the first event records no effect the source run did not make', async () => {
    const { runId, log } = await unwound();
    const parent = await ledger(runId);
    const first = log[0] as Ev;
    const f = await fetch(`${B}/runs/${enc(runId)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'replay', fromSeq: first.sequence }) });
    expect(f.status).toBe(201);
    const forkId = ((await f.json()) as { runId: string }).runId;
    const forkLog = await settled(forkId);
    // The fork re-runs to the failure and unwinds again — resolving every effect, forward
    // and inverse, from the source's records rather than performing it.
    expect(forkLog.some((e) => e.type === 'run.failed')).toBe(true);
    expect(forkLog.some((e) => e.type === 'compensation.completed')).toBe(true);
    expect((await projection(forkId)).attempts.map((a) => a.nodeId)).toEqual(['e3', 'e2', 'e1']);
    const forkRows = await ledger(forkId);
    expect(refired(parent, forkRows)).toEqual([]);
    // Inherited history, not an empty ledger: all six source records, copied verbatim.
    expect(forkRows).toHaveLength(parent.length);
    expect(forkRows.every((r) => (r.invocationId ?? '').startsWith('replay-of:'))).toBe(true);
    // The source's ledger is untouched by the fork.
    expect(await ledger(runId)).toEqual(parent);
  });
});
