/**
 * RFC 0228: a failed core.httpFetch fails its node with a registered code —
 * `egress_denied` when the host's own egress guard refused the destination (the
 * request never left), `upstream_unavailable` when the target gave no answer.
 * A replay of a recorded failure fails with the same code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { performHttpFetch } from '../src/effects.js';
import { EVENT_LOG_SCHEMA_VERSION } from '../src/config.js';
import { nowIso, tenantBound } from '../src/ids.js';
import type { RunRow } from '../src/store.js';
import type { WorkflowNode } from '../src/host.js';

let guarded: RunningHost; let open: RunningHost;
beforeAll(async () => {
  guarded = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-g', webhookAllowPrivate: false });
  open = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-o', webhookAllowPrivate: true });
});
afterAll(async () => { await guarded.close(); await open.close(); });

function run(h: RunningHost, extra: Partial<RunRow> = {}): RunRow {
  const tenant = h.host.config.tenant;
  const row: RunRow = {
    run_id: tenantBound(tenant), tenant, workflow_id: 'conformance-http-effect', status: 'running', era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: null, options_json: '{}', inputs_json: '{}', created_at: nowIso(), updated_at: nowIso(), started_at: null, completed_at: null,
    current_node_id: null, error_json: null, source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null,
    pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: null, ...extra,
  };
  h.host.store.insertRun(row);
  return row;
}
const node = (url: string): WorkflowNode => ({ id: 'fetch', typeId: 'core.httpFetch', config: { url, method: 'POST', businessKey: `bk-${Math.random()}` }, inputs: {} } as unknown as WorkflowNode);

describe('a failed http.fetch fails with a registered code (RFC 0228)', () => {
  it('the egress guard refusing the destination is egress_denied', async () => {
    await expect(performHttpFetch(guarded.host, run(guarded), node('http://127.0.0.1:9/x'), 1)).rejects.toMatchObject({ code: 'egress_denied' });
  });
  it('a target that gives no answer is upstream_unavailable, and its replay fails the same way', async () => {
    const src = run(open); const n = node('http://127.0.0.1:9/x'); // nothing listens on port 9
    await expect(performHttpFetch(open.host, src, n, 1)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(performHttpFetch(open.host, run(open, { source_run_id: src.run_id, fork_mode: 'replay' }), n, 1)).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
