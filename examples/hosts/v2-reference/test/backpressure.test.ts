/**
 * conformance.md §Production profile, `backpressure` (router.ts): with
 * OPENWOP_INFLIGHT_CAP set, the host serves at most that many authenticated
 * requests at once and answers the next `503 service_unavailable` with
 * `Retry-After` and no `details.retryAfter*` (errors.md §Retry timing).
 * Unset, no cap is enforced and `production` is not advertised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const KEY = 'k-bp';
let capped: RunningHost; let open: RunningHost;
beforeAll(async () => {
  capped = await startHost({ port: 0, dbPath: ':memory:', apiKey: KEY, inflightCap: 2, backpressureRetryAfterSeconds: 3 });
  open = await startHost({ port: 0, dbPath: ':memory:', apiKey: KEY });
});
afterAll(async () => { await capped.close(); await open.close(); });

const base = (h: RunningHost): string => `http://127.0.0.1:${h.port}`;
const auth = { Authorization: `Bearer ${KEY}`, 'OpenWOP-Version': '2.0' };
const post = (h: RunningHost, body: unknown): Promise<Response> => fetch(`${base(h)}/runs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Open an event stream on a held run; resolves once the stream's headers are back. */
async function hold(h: RunningHost): Promise<AbortController> {
  const { runId } = await (await post(h, { workflowId: 'conformance-delay', inputs: { delayMs: 5000 } })).json() as { runId: string };
  const ctl = new AbortController();
  const res = await fetch(`${base(h)}/runs/${encodeURIComponent(runId)}/events`, { headers: { ...auth, Accept: 'text/event-stream' }, signal: ctl.signal });
  expect(res.status).toBe(200);
  return ctl;
}

describe('backpressure at the in-flight cap', () => {
  it('production.backpressure is advertised only when a cap is set', async () => {
    const withCap = await (await fetch(`${base(capped)}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { production?: { backpressure?: unknown } };
    expect(withCap.production?.backpressure).toEqual({ inflightCap: 2, retryAfterSeconds: 3 });
    const without = await (await fetch(`${base(open)}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { production?: unknown };
    expect(without.production).toBeUndefined();
  });

  it('at the cap the next request is 503 service_unavailable with Retry-After and no retry timing in details; a freed slot serves again', async () => {
    const streams = [await hold(capped), await hold(capped)];
    try {
      const refused = await post(capped, { workflowId: 'conformance-noop' });
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('3');
      const body = await refused.json() as { error: string; details?: Record<string, unknown> };
      expect(body.error).toBe('service_unavailable');
      expect(body.details).toBeUndefined();
      // Discovery takes no slot: it answers while the host is at capacity.
      expect((await fetch(`${base(capped)}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).status).toBe(200);
    } finally { for (const s of streams) s.abort(); }
    await new Promise((r) => setTimeout(r, 100));
    expect((await post(capped, { workflowId: 'conformance-noop' })).status).toBe(201);
  });

  it('with no cap set, more concurrent streams than any small cap are all served', async () => {
    const streams = [await hold(open), await hold(open), await hold(open)];
    try { expect((await post(open, { workflowId: 'conformance-noop' })).status).toBe(201); }
    finally { for (const s of streams) s.abort(); }
  });
});
