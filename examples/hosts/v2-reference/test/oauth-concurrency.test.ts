/**
 * openwop-examples#115 — two OAuth grants in flight at once on ONE provider id,
 * each pointed at its own authorization server (as two conformance scenarios
 * running in parallel do through the authorize-start seam). Each grant is bound
 * to the authorization server it was sent to: its callback checks RFC 9207 `iss`
 * against THAT issuer and exchanges its code at THAT token endpoint, however the
 * shared provider was repointed meanwhile. The iss check itself is not relaxed.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const K = 'test-key-oauth-race';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };

interface Double { issuer: string; tokenCalls: number; close(): Promise<void> }
/** A minimal authorization server: RFC 8414 metadata promising iss, an authorize redirect carrying iss, a token endpoint. */
async function double(): Promise<Double> {
  let issuer = '';
  const d = { issuer: '', tokenCalls: 0, close: async () => { await new Promise<void>((r) => srv.close(() => r())); } };
  const srv: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, authorization_response_iss_parameter_supported: true }));
    }
    if (url.pathname === '/authorize') {
      const to = new URL(url.searchParams.get('redirect_uri') as string);
      to.searchParams.set('code', `code-${randomBytes(8).toString('hex')}`);
      to.searchParams.set('state', url.searchParams.get('state') as string);
      to.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      d.tokenCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `at-${randomBytes(8).toString('hex')}`, token_type: 'Bearer', expires_in: 3600 }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  d.issuer = issuer;
  return d;
}

let running: RunningHost;
let B = '';
let a: Double; let b: Double;
beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, oauthAllowPrivate: true });
  B = `http://127.0.0.1:${running.port}`;
  [a, b] = await Promise.all([double(), double()]);
});
afterAll(async () => { await running.close(); await a.close(); await b.close(); });

/** authorize-start pointing `synthetic` at `d`, then play the user agent to the authorization server: the callback URL it redirects to. */
async function start(d: Double): Promise<string> {
  const r = await fetch(`${B}/conformance/seams/sample/oauth/authorize-start`, { method: 'POST', headers: H, body: JSON.stringify({ provider: 'synthetic', authUrl: `${d.issuer}/authorize`, tokenUrl: `${d.issuer}/token`, issuer: d.issuer }) });
  expect(r.status).toBe(201);
  const { authorizationUrl } = await r.json() as { authorizationUrl: string };
  const consent = await fetch(authorizationUrl, { redirect: 'manual' });
  // The redirect URI is built from the configured port (0 here); the user agent reaches the bound one.
  const cb = new URL(consent.headers.get('location') as string);
  return `${B}${cb.pathname}${cb.search}`;
}
const complete = async (cb: string) => { const r = await fetch(cb, { headers: H }); return { s: r.status, b: await r.json() as Record<string, unknown> }; };

describe('two grants in flight on one provider id (#115)', () => {
  it('each callback is judged against the authorization server its grant was sent to', async () => {
    const cbA = await start(a); // synthetic → A, grant A sent to A
    const cbB = await start(b); // synthetic repointed → B while A is in flight
    expect(new URL(cbA).searchParams.get('iss')).toBe(a.issuer);
    const doneA = await complete(cbA);
    expect(doneA.s, JSON.stringify(doneA.b)).toBe(200);
    const doneB = await complete(cbB);
    expect(doneB.s, JSON.stringify(doneB.b)).toBe(200);
    // Each code was exchanged at the token endpoint of the server that issued it.
    expect([a.tokenCalls, b.tokenCalls]).toEqual([1, 1]);
  });
  it('the RFC 9207 check still refuses an iss that is not the grant\'s own issuer', async () => {
    const cb = new URL(await start(a));
    cb.searchParams.set('iss', b.issuer); // a real issuer — but not the one this grant was sent to
    const r = await complete(cb.toString());
    expect(r.s).toBe(400);
    expect(r.b['message']).toMatch(/another issuer/);
    // and a missing iss is refused, since A's metadata promises it
    const cb2 = new URL(await start(a));
    cb2.searchParams.delete('iss');
    expect((await complete(cb2.toString())).s).toBe(400);
  });
});
