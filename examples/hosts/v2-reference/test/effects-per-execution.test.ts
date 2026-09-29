/**
 * openwop-examples#132 — the live (non-replay) path across executions of one node.
 *
 * idempotency.md §"Layer 2: effect identity": the effect is keyed on its business
 * identity ("containing no runId, nodeId or ordinal"), "stable across every
 * transport or provider retry", and "a retried node MUST NOT issue a second
 * external effect". So a later execution (a loop visit) keeps the identity and:
 *   - re-attempts an operation that only FAILED — it was never performed;
 *   - resolves to an operation that already COMPLETED — performing it again would
 *     be a second external effect;
 * and a re-delivery of the SAME execution dedupes exactly as before. Before the
 * fix, any later execution collided on the ledger key and resolved to the first
 * execution's record, a recorded transport failure included.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { performHttpFetch } from '../src/effects.js';
import { EVENT_LOG_SCHEMA_VERSION } from '../src/config.js';
import { nowIso, tenantBound } from '../src/ids.js';
import type { RunRow } from '../src/store.js';
import type { WorkflowNode } from '../src/host.js';

let running: RunningHost;
let provider: Server;
let url = '';
let hits: string[] = []; // the Idempotency-Key of every request that reached the provider
let mode: 'reset' | 'ok' = 'ok';
beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-132', webhookAllowPrivate: true });
  provider = createServer((req, res) => {
    hits.push(String(req.headers['idempotency-key']));
    if (mode === 'reset') { req.socket.destroy(); return; }
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(provider.address() as { port: number }).port}/charge`;
});
afterAll(async () => { await running.close(); await new Promise<void>((r) => provider.close(() => r())); });

function run(extra: Partial<RunRow> = {}): RunRow {
  const tenant = running.host.config.tenant;
  const row: RunRow = {
    run_id: tenantBound(tenant), tenant, workflow_id: 'conformance-http-effect', status: 'running', era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: null, options_json: '{}', inputs_json: '{}', created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null,
    current_node_id: null, error_json: null, source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null,
    pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: null, ...extra,
  };
  running.host.store.insertRun(row);
  return row;
}
const node = (businessKey: string): WorkflowNode => ({ id: 'fetch', typeId: 'core.httpFetch', config: { url, method: 'POST', body: { order: businessKey }, businessKey }, inputs: {} } as unknown as WorkflowNode);
const ledger = (r: RunRow) => running.host.store.effectsForRun(r.run_id).map((e) => [e.attempt, e.execution, e.state]);

describe('effects across executions of one node (#132)', () => {
  it('a later execution re-attempts an operation the earlier one FAILED, under the same identity', async () => {
    hits = []; const r = run(); const n = node(`bk-fail-${Date.now()}`);
    mode = 'reset';
    await expect(performHttpFetch(running.host, r, n, 1)).rejects.toThrow(/http.fetch failed after 1 transport attempt/);
    mode = 'ok';
    const second = await performHttpFetch(running.host, r, n, 2);
    expect(second.outputs).toMatchObject({ status: 201, attempts: 1 });
    expect(second.outputs['deduplicated']).toBeUndefined();
    expect(hits.length).toBe(2);                 // the second execution reached the provider
    expect(new Set(hits).size).toBe(1);          // under the SAME idempotency key (one business identity)
    expect(ledger(r)).toEqual([[1, 1, 'released'], [2, 2, 'completed']]);
  });
  it('a re-delivery of the SAME execution dedupes: no second request, the recorded outcome', async () => {
    hits = []; const r = run(); const n = node(`bk-same-${Date.now()}`);
    mode = 'ok';
    const first = await performHttpFetch(running.host, r, n, 1);
    const again = await performHttpFetch(running.host, r, n, 1);
    expect(hits.length).toBe(1);
    expect(again.effectId).toBe(first.effectId);
    expect(again.outputs).toMatchObject({ status: 201, deduplicated: true });
    // ...and a recorded FAILURE of that execution is its outcome too: re-delivery does not re-fire it.
    hits = []; const r2 = run(); const n2 = node(`bk-same-fail-${Date.now()}`);
    mode = 'reset';
    await expect(performHttpFetch(running.host, r2, n2, 1)).rejects.toThrow();
    mode = 'ok';
    await expect(performHttpFetch(running.host, r2, n2, 1)).resolves.toMatchObject({ outputs: { deduplicated: true } });
    expect(hits.length).toBe(1);
  });
  it('a later execution of an operation that already COMPLETED resolves to it: no second external effect', async () => {
    hits = []; const r = run(); const n = node(`bk-done-${Date.now()}`);
    mode = 'ok';
    const first = await performHttpFetch(running.host, r, n, 1);
    const later = await performHttpFetch(running.host, r, n, 2);
    expect(hits.length).toBe(1);
    expect(later).toMatchObject({ effectId: first.effectId, outputs: { status: 201, deduplicated: true } });
  });
  it('replay is unchanged: each execution of the source replays as itself', async () => {
    hits = []; const src = run(); const n = node(`bk-replay-${Date.now()}`);
    mode = 'reset';
    await expect(performHttpFetch(running.host, src, n, 1)).rejects.toThrow();
    mode = 'ok';
    await performHttpFetch(running.host, src, n, 2);
    const before = hits.length;
    const fork = run({ source_run_id: src.run_id, fork_mode: 'replay' });
    await expect(performHttpFetch(running.host, fork, n, 1)).rejects.toThrow(/recorded, not performed/);
    await expect(performHttpFetch(running.host, fork, n, 2)).resolves.toMatchObject({ outputs: { status: 201, suppressed: true } });
    expect(hits.length).toBe(before); // the replay performed nothing
  });
});
