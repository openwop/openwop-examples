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
