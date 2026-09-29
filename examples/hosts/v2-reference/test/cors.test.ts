/**
 * CORS (openwop#1763, headers.cors-preflight-admits, suite 2.45.0): when a host
 * grants an origin it MUST admit, in the preflight, the operation's method and
 * every request header api/v2/openapi.yaml declares for it — plus Authorization
 * when authenticated and Content-Type when it takes a body. This host reflects
 * Access-Control-Request-Headers, echoes the Origin (never `*`, which would not
 * admit Authorization) and grants no credentials. Actual responses change only
 * by carrying Access-Control-Allow-Origin (with Vary: Origin).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

const ORIGIN = 'https://app.example';
let reflect: RunningHost; let allow: RunningHost; let off: RunningHost;
beforeAll(async () => {
  reflect = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-cors' });
  allow = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-cors', corsOrigins: [ORIGIN] });
  off = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'k-cors', corsOrigins: 'off' });
});
afterAll(async () => { await reflect.close(); await allow.close(); await off.close(); });

const base = (h: RunningHost): string => `http://127.0.0.1:${h.port}`;
const preflight = (h: RunningHost, path: string, method: string, headers: string, origin = ORIGIN) =>
  fetch(`${base(h)}${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } });
const admits = (list: string | null, header: string): boolean => (list ?? '').split(',').map((s) => s.trim().toLowerCase()).includes(header.toLowerCase());

describe('a CORS preflight admits the operation\'s method and requested headers', () => {
  it('getCapabilities with If-None-Match: GET and every requested header admitted, the origin echoed, no credentials', async () => {
    const r = await preflight(reflect, '/.well-known/openwop', 'GET', 'OpenWOP-Version, If-None-Match, OpenWOP-Client-Version');
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(admits(r.headers.get('access-control-allow-methods'), 'GET')).toBe(true);
    for (const h of ['OpenWOP-Version', 'If-None-Match', 'OpenWOP-Client-Version']) expect(admits(r.headers.get('access-control-allow-headers'), h), h).toBe(true);
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('createRun with OpenWOP-Force-Engine-Version: POST, Authorization and Content-Type admitted; never a `*`', async () => {
    const asked = 'Authorization, Content-Type, OpenWOP-Version, Idempotency-Key, OpenWOP-Force-Engine-Version, OpenWOP-Dedup';
    const r = await preflight(reflect, '/runs', 'POST', asked);
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(admits(r.headers.get('access-control-allow-methods'), 'POST')).toBe(true);
    for (const h of asked.split(', ')) expect(admits(r.headers.get('access-control-allow-headers'), h), h).toBe(true);
    expect(r.headers.get('access-control-allow-headers')).not.toBe('*');
  });
  it('an operation with a path parameter (resolveInterruptByRun) and the SSE stream (Last-Event-ID)', async () => {
    const r = await preflight(reflect, '/runs/tenant~2Fabc/interrupts/gate', 'POST', 'Authorization, Content-Type, OpenWOP-Version, Idempotency-Key');
    expect(r.status).toBe(204);
    expect(admits(r.headers.get('access-control-allow-headers'), 'Idempotency-Key')).toBe(true);
    const s = await preflight(reflect, '/runs/tenant~2Fabc/events', 'GET', 'Authorization, OpenWOP-Version, Last-Event-ID');
    expect(s.status).toBe(204);
    expect(admits(s.headers.get('access-control-allow-headers'), 'Last-Event-ID')).toBe(true);
  });
  it('a method no operation serves at the path is not admitted', async () => {
    const r = await preflight(reflect, '/.well-known/openwop', 'DELETE', 'OpenWOP-Version');
    expect(r.status).toBe(404);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the origin policy', () => {
  it('an allowlist grants only its origins; `off` grants none', async () => {
    expect((await preflight(allow, '/runs', 'POST', 'Authorization')).headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const other = await preflight(allow, '/runs', 'POST', 'Authorization', 'https://other.example');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(other.headers.get('access-control-allow-headers')).toBeNull();
    expect((await preflight(off, '/runs', 'POST', 'Authorization')).headers.get('access-control-allow-origin')).toBeNull();
    const actual = await fetch(`${base(allow)}/.well-known/openwop`, { headers: { Origin: 'https://other.example', 'OpenWOP-Version': '2.0' } });
    expect(actual.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('actual responses change only by the echoed origin', () => {
  it('the same body and ETag with or without Origin; ACAO and Vary: Origin only when one is granted', async () => {
    const plain = await fetch(`${base(reflect)}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } });
    const cross = await fetch(`${base(reflect)}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0', Origin: ORIGIN } });
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
    expect(cross.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(cross.headers.get('vary')).toContain('Origin');
    expect(cross.headers.get('etag')).toBe(plain.headers.get('etag'));
    expect(await cross.text()).toBe(await plain.text());
  });
  it('an OPTIONS that is not a preflight is served as before', async () => {
    const r = await fetch(`${base(reflect)}/runs`, { method: 'OPTIONS', headers: { 'OpenWOP-Version': '2.0' } });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('not_found');
  });
});
