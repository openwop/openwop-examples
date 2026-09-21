/**
 * The guarded request against a HOSTNAME — not an IP literal.
 *
 * An IP-literal URL never reaches the custom DNS `lookup`, so every loopback
 * fixture exercised only the branch that skips it. `localhost` is a name: it
 * goes through resolve -> validate -> pin -> connect, the path a real webhook
 * destination takes, and needs no network to do it.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedRequest, validateEgressUrl } from '../src/egress.js';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok())); });
async function listen(): Promise<number> {
  const s = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`host=${req.headers.host}`); });
  // Bind the NAME, not 127.0.0.1: `localhost` resolves to ::1 first on macOS and to 127.0.0.1 first
  // elsewhere, and guardedRequest connects to the FIRST record - so the listener must be wherever that is.
  await new Promise<void>((ok) => s.listen(0, 'localhost', () => ok())); servers.push(s);
  const a = s.address(); return typeof a === 'object' && a ? a.port : 0;
}

describe('guardedRequest resolves a NAME and connects to the address it validated', () => {
  it('reaches a hostname destination (regression: "Invalid IP address: undefined" on every non-literal URL)', async () => {
    const port = await listen();
    const r = await guardedRequest(new URL(`http://localhost:${port}/hook`), { method: 'GET', headers: {}, timeoutMs: 3000, allowPrivate: true });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body).toBe(`host=localhost:${port}`); // Host is the NAME; the socket went to the pinned address
  });

  it('still refuses that same name when the guard is closed — the fix did not open anything', async () => {
    const port = await listen();
    const r = await guardedRequest(new URL(`http://localhost:${port}/hook`), { method: 'GET', headers: {}, timeoutMs: 3000, allowPrivate: false });
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/egress denied/);
    expect(() => validateEgressUrl(`https://localhost:${port}/hook`, false)).toThrow();
  });
});

/**
 * Judged on the ADDRESS, not its spelling. The WHATWG URL parser turns
 * `[::ffff:127.0.0.1]` into hostname `::ffff:7f00:1`, and a guard that matched
 * only the dotted mapped form let loopback, the metadata address and RFC 1918
 * through at registration AND delivery - two POSTs reached a real listener.
 * The delivery test below asserts ZERO ARRIVALS at a real listener, not the
 * predicate's return value: that is the observation that caught it.
 */
describe('addresses that embed IPv4 are judged by the IPv4 they embed', () => {
  const refused = [
    'https://[::ffff:7f00:1]/', 'https://[::ffff:127.0.0.1]/', 'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://[::ffff:a9fe:a9fe]/', 'https://[::ffff:a00:1]/', 'https://[::ffff:c0a8:1]/',
    'https://[::7f00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::a9fe:a9fe]/', 'https://[2002:7f00:1::1]/',
    'https://[64:ff9b:1::1]/', 'https://[2001::1]/', 'https://[2001:db8::1]/', 'https://[ff02::1]/', 'https://[fec0::1]/', 'https://[::]/',
    'https://0.0.0.0/', 'https://100.64.0.1/', 'https://198.18.0.1/', 'https://255.255.255.255/', 'https://203.0.113.9/',
  ];
  it.each(refused)('refuses %s at registration', (u) => {
    expect(() => validateEgressUrl(u, false)).toThrow();
  });

  // Allow-by-reachability must not over-refuse: an IPv6-only host behind DNS64
  // is legitimately handed 64:ff9b::<public v4> for a public destination.
  const allowed = ['https://93.184.216.34/', 'https://[2606:4700:4700::1111]/', 'https://[64:ff9b::5db8:d822]/', 'https://[2002:5db8:d822::1]/', 'https://[::ffff:5db8:d822]/', 'https://example.com/'];
  it.each(allowed)('still accepts the public destination %s', (u) => {
    expect(() => validateEgressUrl(u, false)).not.toThrow();
  });

  it('delivery to every loopback spelling reaches NOTHING', async () => {
    let arrivals = 0;
    const s = createServer((_q, r) => { arrivals++; r.end('x'); });
    await new Promise<void>((ok) => s.listen(0, '::', () => ok())); servers.push(s);
    const a = s.address(); const port = typeof a === 'object' && a ? a.port : 0;
    for (const h of ['127.0.0.1', '[::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::7f00:1]', '[64:ff9b::7f00:1]']) {
      const r = await guardedRequest(new URL(`http://${h}:${port}/hook`), { method: 'POST', headers: {}, body: '{}', timeoutMs: 2000, allowPrivate: false });
      expect(r.status, h).toBe(0);
      expect(r.error, h).toMatch(/egress denied/);
    }
    expect(arrivals).toBe(0);
  });
});
