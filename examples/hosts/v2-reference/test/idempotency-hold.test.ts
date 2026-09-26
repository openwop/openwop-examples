/**
 * RFC 0213 §B witness seam (`POST /conformance/seams/sample/test/idempotency/hold`,
 * src/idempotency-hold.ts). The seam only ARMS a single-use hold; the 409 a
 * concurrent same-key create receives comes from `withIdempotency`'s real
 * in-flight branch, and the held create still completes as the one winner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-idempotency-hold';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
const SEAM = '/conformance/seams/sample/test/idempotency/hold';
const newKey = (): string => `hold-${randomBytes(12).toString('hex')}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ s: number; h: Headers; b: any }> {
  const r = await fetch(`${B}${path}`, { method, headers: { ...H, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  return { s: r.status, h: r.headers, b };
}
const create = (key: string): Promise<{ s: number; h: Headers; b: any }> => call('POST', '/runs', { workflowId: 'conformance-noop' }, { 'Idempotency-Key': key });

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: true, webhookBackoffBaseMs: 20, webhookMaxAttempts: 3, rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('RFC 0213 §B — idempotency hold seam', () => {
  it('a same-key create during an armed hold gets the real 409 idempotency_in_flight; the held create still wins', async () => {
    const key = newKey();
    const armed = await call('POST', SEAM, { key, holdMs: 1500 });
    expect(armed.s).toBe(201);
    expect(armed.b).toEqual({ key, holdMs: 1500 });
    const winner = create(key);
    await new Promise((ok) => setTimeout(ok, 200));
    const loser = await create(key);
    expect(loser.s).toBe(409);
    expect(loser.b.error).toBe('idempotency_in_flight');
    expect(Object.keys(loser.b.details ?? {}).filter((k) => /^retryAfter/i.test(k))).toEqual([]);
    expect(loser.h.get('retry-after')).toMatch(/^\d+$/);
    const w = await winner;
    expect(w.s).toBe(201);
    const replay = await create(key);
    expect(replay.s).toBe(201);
    expect(replay.h.get('openwop-idempotent-replay')).toBe('true');
    expect(replay.b.runId).toBe(w.b.runId);
  });

  it('the hold is single-use: the next same-key create after completion is a replay, not held', async () => {
    const key = newKey();
    expect((await call('POST', SEAM, { key, holdMs: 300 })).s).toBe(201);
    expect((await create(key)).s).toBe(201);
    const t0 = Date.now();
    const again = await create(key);
    expect(again.h.get('openwop-idempotent-replay')).toBe('true');
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('an unarmed key is never held (the production path is unchanged)', async () => {
    const t0 = Date.now();
    expect((await create(newKey())).s).toBe(201);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('validates its body: an out-of-range holdMs, a malformed key and an unknown member are 400 validation_error', async () => {
    expect((await call('POST', SEAM, { key: newKey(), holdMs: 0 })).b.error).toBe('validation_error');
    expect((await call('POST', SEAM, { key: newKey(), holdMs: 10_001 })).b.error).toBe('validation_error');
    expect((await call('POST', SEAM, { key: 'short', holdMs: 100 })).b.error).toBe('validation_error');
    expect((await call('POST', SEAM, { key: newKey(), holdMs: 100, extra: 1 })).b.error).toBe('validation_error');
  });
});
