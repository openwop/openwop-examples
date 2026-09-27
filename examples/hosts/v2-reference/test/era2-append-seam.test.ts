/**
 * appendEra2Event (host-sample-test-seams.md §27) — RFC 0176 §A writer-rule
 * witness. The seam hands the host a v2-named event; the host's PRODUCTION
 * writer (`appendEvent`) decides the stored spelling. An era-2 run stores the
 * codemap's v1 spelling, and the production read translates it back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-era2-append-seam';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };

async function call(method: string, path: string, body?: unknown): Promise<{ s: number; b: any }> {
  const r = await fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  return { s: r.status, b };
}

const SEED = '/conformance/seams/sample/event-log/seed';
const APPEND = '/conformance/seams/sample/event-log/append';
const RENAMED_V2 = 'agent.reasoning-delta';
const RENAMED_V1 = 'agent.reasoning.delta';
const PAYLOAD = { agentId: 'conformance', delta: 'x', sequence: 0 };

async function seed(status = 'running'): Promise<string> {
  const r = await call('POST', SEED, { eventLogSchemaVersion: 2, status, events: [
    { type: 'run.started', sequence: 0, payload: { workflowId: 'conformance-noop' } },
    { type: 'node.started', sequence: 1, payload: { nodeId: 'noop' } },
  ] });
  expect(r.s).toBe(201);
  return r.b.runId as string;
}

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: true, rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('appendEra2Event (§27)', () => {
  it('stores the v1 spelling in an era-2 log and reads back the v2 name', async () => {
    const runId = await seed();
    const a = await call('POST', APPEND, { runId, type: RENAMED_V2, payload: PAYLOAD });
    expect(a.s).toBe(202);
    expect(a.b.sequence).toBe(2);
    const stored = running.host.store.db.prepare('SELECT type FROM events WHERE run_id = ? AND sequence = 2').get(runId) as { type: string };
    expect(stored.type).toBe(RENAMED_V1);
    const read = await call('GET', `/runs/${encodeURIComponent(runId)}/events/poll`);
    expect(read.s).toBe(200);
    const types = (read.b.events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain(RENAMED_V2);
    expect(types).not.toContain(RENAMED_V1);
  });

  it('refuses a run the seed seam did not create — it reads as unknown', async () => {
    const created = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    expect([201, 202]).toContain(created.s);
    const a = await call('POST', APPEND, { runId: created.b.runId, type: RENAMED_V2, payload: PAYLOAD });
    expect(a.s).toBe(404);
  });

  it('refuses a terminal seeded run and a non-v2 type', async () => {
    const done = await seed('completed');
    expect((await call('POST', APPEND, { runId: done, type: RENAMED_V2, payload: PAYLOAD })).s).toBe(409);
    const open = await seed();
    expect((await call('POST', APPEND, { runId: open, type: RENAMED_V1, payload: PAYLOAD })).s).toBe(400);
  });
});
