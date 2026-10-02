/**
 * host-services.md §`httpClient` (safe-fetch.ts): the guarded client behind
 * the reserved `core.conformance.safefetch-probe` node. A refused target is
 * `egress_denied`, `details.reason: ssrf-blocked`; the guard is never relaxed
 * on this path, whatever the operator set for webhooks and OAuth.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFetchRejection, safeFetch } from '../src/safe-fetch.js';
import { startHost, type RunningHost } from '../src/server.js';

const KEY = 'k-safefetch';
let h: RunningHost; let listener: Server; let port = 0; const arrivals: string[] = [];
beforeAll(async () => {
  // Private egress is OPEN for webhooks here, as in the loopback lanes: safeFetch must stay closed.
  h = await startHost({ port: 0, dbPath: ':memory:', apiKey: KEY, webhookAllowPrivate: true });
  listener = createServer((rq, rs) => { arrivals.push(rq.url ?? ''); rs.writeHead(200); rs.end('x'); });
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  port = (listener.address() as AddressInfo).port;
});
afterAll(async () => { await h.close(); await new Promise<void>((r) => listener.close(() => r())); });

const base = (): string => `http://127.0.0.1:${h.port}`;
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
async function probe(url: string): Promise<{ status: string; error?: { code?: string; details?: { reason?: string } } }> {
  const { runId } = await (await fetch(`${base()}/runs`, { method: 'POST', headers, body: JSON.stringify({ workflowId: 'conformance-safefetch-probe', inputs: { url } }) })).json() as { runId: string };
  for (let i = 0; i < 400; i++) {
    const snap = await (await fetch(`${base()}/runs/${encodeURIComponent(runId)}`, { headers })).json() as { status: string; error?: { code?: string; details?: { reason?: string } } };
    if (['completed', 'failed', 'cancelled'].includes(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the probe run did not end');
}

describe('safeFetch refuses private targets on the resolved address', () => {
  it('discovery advertises httpClient with the guard, the caps, safeFetch and the probe fixture', async () => {
    const doc = await (await fetch(`${base()}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { httpClient: Record<string, unknown>; fixtures: string[] };
    expect(doc.httpClient).toMatchObject({ ssrfGuard: true, maxResponseBodyBytes: 1_048_576, requestTimeoutMs: 5_000, methods: ['GET'], safeFetch: {} });
    expect(doc.fixtures).toContain('conformance-safefetch-probe');
  });

  it('loopback, RFC 1918, link-local, metadata, alternate spellings and a resolving name are egress_denied / ssrf-blocked, and nothing connects', async () => {
    const targets = [
      `http://127.0.0.1:${port}/a`, `http://[::1]:${port}/a`, 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/',
      'http://169.254.169.254/', 'http://[fe80::1]/', `http://2130706433:${port}/a`, `http://0177.0.0.1:${port}/a`, `http://127.1:${port}/a`,
      `http://[::ffff:7f00:1]:${port}/a`, `http://localhost:${port}/a`,
    ];
    for (const t of targets) {
      const snap = await probe(t);
      expect(snap.status, t).toBe('failed');
      expect(snap.error?.code, t).toBe('egress_denied');
      expect(snap.error?.details?.reason, t).toBe('ssrf-blocked');
    }
    expect(arrivals).toEqual([]);
  });

  it('a non-http scheme and a non-URL are refused, not fetched', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'egress_denied' });
    await expect(safeFetch('not a url')).rejects.toBeInstanceOf(SafeFetchRejection);
  });

  it('a public name that does not resolve is upstream_unavailable, not egress_denied', async () => {
    await expect(safeFetch('http://no-such-host.invalid/')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
