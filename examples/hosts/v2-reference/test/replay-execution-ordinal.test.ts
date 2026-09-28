/**
 * replay.md §Suppression rule 2 (openwop#1745, #1718; suite 2.43.2): a replay
 * resolves a side-effecting node from the source's recorded terminal outcome for
 * `(sourceRunId, nodeId, n)`, where n is that node's execution ordinal — its n-th
 * `node.started`, inherited prefix, retries and later visits included. The store
 * used to ignore n and return the node's LAST outcome. The host runs no cycles
 * yet, so the executions are recorded directly here; the executor supplies
 * n - 1 as `attempt` (its count of the node's earlier node.started events).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { performHttpFetch } from '../src/effects.js';
import { appendEvent } from '../src/events.js';
import { EVENT_LOG_SCHEMA_VERSION } from '../src/config.js';
import { nowIso, tenantBound } from '../src/ids.js';
import type { EffectRow, RunRow } from '../src/store.js';
import type { WorkflowNode } from '../src/host.js';

let running: RunningHost;
beforeAll(async () => { running = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-ordinal' }); });
afterAll(async () => { await running.close(); });

const node: WorkflowNode = { id: 'fetch', typeId: 'core.httpFetch', config: { url: 'https://effect-seam.invalid/fire', method: 'POST' }, inputs: {} } as unknown as WorkflowNode;

function run(extra: Partial<RunRow> = {}): RunRow {
  const tenant = running.host.config.tenant;
  const row: RunRow = {
    run_id: tenantBound(tenant), tenant, workflow_id: 'conformance-http-effect', status: 'completed', era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: null, options_json: '{}', inputs_json: '{}', created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null,
    current_node_id: null, error_json: null, source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null,
    pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: null, ...extra,
  };
  running.host.store.insertRun(row);
  return row;
}
function record(src: RunRow, effectId: string, execution: number | null, outcome: Record<string, unknown>, attempt = 1): void {
  const row: EffectRow = { effect_id: effectId, run_id: src.run_id, node_id: node.id, attempt, keying: 'business-identity', state: 'completed', provider_key: 'pk', invocation_id: null, at: nowIso(), business_key: `bk-${effectId}`, outcome_json: JSON.stringify(outcome), execution };
  running.host.store.claimEffect(row);
}
const fork = (src: RunRow): RunRow => run({ source_run_id: src.run_id, fork_mode: 'replay', status: 'running' });

describe('a replay resolves the source execution n, not the last one', () => {
  it('execution 1 and 2 of one node replay as themselves; a third fails closed', async () => {
    const src = run();
    record(src, 'e-1', 1, { status: 201 });
    record(src, 'e-2', 2, { status: 500, error: 'first try refused' }, 1);
    record(src, 'e-2', 2, { status: 202 }, 2); // execution 2's terminal outcome is its LAST transport attempt
    const f = fork(src);
    const first = await performHttpFetch(running.host, f, node, 0);
    expect(first).toMatchObject({ effectId: 'e-1', outputs: { status: 201, suppressed: true } });
    const second = await performHttpFetch(running.host, f, node, 1);
    expect(second).toMatchObject({ effectId: 'e-2', outputs: { status: 202, suppressed: true } });
    await expect(performHttpFetch(running.host, f, node, 2)).rejects.toMatchObject({ code: 'replay_source_missing' });
    // The fork's ledger inherits each execution's own rows, never the other's.
    expect(running.host.store.effectsForRun(f.run_id).map((e) => [e.effect_id, e.attempt])).toEqual([['e-1', 1], ['e-2', 1], ['e-2', 2]]);
  });
  it('a row recorded before the ordinal existed is execution 1', async () => {
    const src = run();
    record(src, 'legacy', null, { status: 200 });
    const f = fork(src);
    expect(await performHttpFetch(running.host, f, node, 0)).toMatchObject({ effectId: 'legacy', outputs: { status: 200 } });
    await expect(performHttpFetch(running.host, f, node, 1)).rejects.toMatchObject({ code: 'replay_source_missing' });
  });
  it('an execution that resolved to an earlier record replays through the effect its node.completed names', async () => {
    const src = run();
    record(src, 'e-shared', 1, { status: 204 });
    for (let i = 0; i < 2; i++) {
      appendEvent(running.host, src, 'node.started', { nodeId: node.id, typeId: node.typeId, attempt: i }, { nodeId: node.id });
      appendEvent(running.host, src, 'node.completed', { nodeId: node.id, outputs: { status: 204, effectId: 'e-shared' } }, { nodeId: node.id });
    }
    const f = fork(src);
    expect(await performHttpFetch(running.host, f, node, 1)).toMatchObject({ effectId: 'e-shared', outputs: { status: 204, suppressed: true } });
  });
  it('a recorded failure replays as the same failure, not a success', async () => {
    const src = run();
    record(src, 'e-failed', 1, { status: 0, error: 'connect refused' });
    await expect(performHttpFetch(running.host, fork(src), node, 0)).rejects.toThrow(/recorded, not performed/);
  });
});
