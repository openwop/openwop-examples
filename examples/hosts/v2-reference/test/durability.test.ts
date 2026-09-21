/**
 * RFC 0158 — the regression net under the durability rows.
 *
 * What this file CAN pin: the gate, the bound's arithmetic, and the three
 * PRODUCTION paths the rows land on — boot recovery, the effect claim under a
 * live holder, and the executor's duplicate-delivery guard. What it CANNOT pin
 * is the death: `POST /host/durability/kill` with a kill mode terminates the
 * process, which here is the test runner. That is witnessed only by the
 * supervised lane (scripts/supervisor.mjs + the conformance suite), and no test
 * in this file pretends otherwise — §D.9 forbids claiming a rung on tests "in
 * which no process was actually terminated", and these are such tests.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { acceptRun } from '../src/runs.js';
import { appendEvent } from '../src/events.js';

const K = 'test-key-durability';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
const enc = encodeURIComponent;
const BASE_CFG = { port: 0, apiKey: K, devValidate: 'strict' as const, webhookAllowPrivate: true, rateLimitPerMinute: 100_000 };

const open: RunningHost[] = []; const servers: Server[] = []; const dirs: string[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.close();
  for (const s of servers.splice(0)) await new Promise<void>((ok) => s.close(() => ok()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function boot(overrides: Record<string, unknown>): Promise<{ r: RunningHost; B: string }> {
  const r = await startHost({ ...BASE_CFG, dbPath: ':memory:', ...overrides }); open.push(r);
  return { r, B: `http://127.0.0.1:${r.port}` };
}
async function call(B: string, method: string, path: string, body?: unknown): Promise<{ s: number; b: any }> {
  const init: RequestInit = { method, headers: H }; if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${B}${path}`, init); const t = await res.text();
  let b: unknown; try { b = JSON.parse(t); } catch { b = t; }
  return { s: res.status, b };
}
async function log(B: string, runId: string): Promise<Array<{ type: string; sequence: number }>> {
  return (await call(B, 'GET', `/runs/${enc(runId)}/events/poll?timeout=1`)).b.events;
}
async function waitTerminal(B: string, runId: string): Promise<string> {
  const deadline = Date.now() + 8000;
  for (;;) { const s = (await call(B, 'GET', `/runs/${enc(runId)}`)).b?.status; if (['completed', 'failed', 'cancelled'].includes(s) || Date.now() > deadline) return s; await new Promise((ok) => setTimeout(ok, 50)); }
}
async function receiver(delayMs = 0): Promise<{ url: string; hits: Array<Record<string, string | string[] | undefined>> }> {
  const hits: Array<Record<string, string | string[] | undefined>> = [];
  const s = createServer((req, res) => { req.on('data', () => undefined); req.on('end', () => { hits.push(req.headers); setTimeout(() => { res.writeHead(204); res.end(); }, delayMs); }); });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok())); servers.push(s);
  const a = s.address(); return { url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/effect`, hits };
}

describe('the gate (RFC 0158 §E item 12): deployment-time, fail-closed', () => {
  it('is NOT mounted by default — every verb 404s, so the suite records `inapplicable` and this host claims no rung', async () => {
    const { B } = await boot({});
    expect((await call(B, 'GET', '/host/durability/kill')).s).toBe(404);
    expect((await call(B, 'POST', '/host/durability/kill', { mode: 'duplicate-delivery', effectUrl: 'http://127.0.0.1:9/x' })).s).toBe(404);
    expect((await call(B, 'GET', '/host/durability/bound')).s).toBe(404);
  });
  it('the durability flag alone cannot open it: with the seams profile off it stays 404 (the second flag only narrows)', async () => {
    const { B } = await boot({ durabilitySeam: true, seamsProfile: false });
    expect((await call(B, 'GET', '/host/durability/kill')).s).toBe(404);
  });
  it('mounted: the GET probe answers WITHOUT firing, and is not served under the 1.x contract', async () => {
    const { B } = await boot({ durabilitySeam: true });
    const p = await call(B, 'GET', '/host/durability/kill');
    expect(p.s).toBe(200); expect(p.b.modes).toEqual(['after-accept', 'during-execution', 'duplicate-delivery']);
    expect((await call(B, 'GET', '/.well-known/openwop')).s).toBe(200); // still alive: the probe killed nothing
    const v1 = await fetch(`${B}/host/durability/kill`, { headers: { ...H, 'OpenWOP-Version': '1.11' } });
    expect(v1.status).toBe(404);
  });
  it('advertises nothing (§E.10): discovery is byte-identical with the seam mounted and unmounted', async () => {
    const off = await boot({}); const on = await boot({ durabilitySeam: true });
    const d = async (B: string): Promise<unknown> => { const j = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as Record<string, unknown>; delete j['host']; return j; };
    expect(await d(on.B)).toEqual(await d(off.B));
  });
  it('refuses an unknown mode and an unknown key before doing anything', async () => {
    const { B } = await boot({ durabilitySeam: true });
    expect((await call(B, 'POST', '/host/durability/kill', { mode: 'nope' })).s).toBe(400);
    expect((await call(B, 'POST', '/host/durability/kill', { mode: 'duplicate-delivery', effectUrl: 'http://x', extra: 1 })).s).toBe(400);
    expect((await call(B, 'POST', '/host/durability/kill', { mode: 'duplicate-delivery' })).s).toBe(400); // effectUrl is the destination the effect is counted at
  });
});

describe('the recovery bound is arithmetic a reader can recompute', () => {
  it('Σ terms[].ms === bound, the terms follow the configuration, and the supervisor term is declared as the OPERATOR\'s', async () => {
    const { B } = await boot({ durabilitySeam: true, supervisorRestartMs: 1500, bootReentryBudgetMs: 4000 });
    const r = (await call(B, 'GET', '/host/durability/bound')).b;
    expect(r.bound).toBe(5500);
    expect(r.terms.reduce((a: number, t: { ms: number }) => a + t.ms, 0)).toBe(r.bound);
    expect(r.terms.map((t: { name: string }) => t.name)).toEqual(['supervisor.restartDelay', 'boot.reentryBudget']);
    expect(r.terms[0].enforcedBy).toMatch(/^OPERATOR/);
    expect(r.bootReentryWithinBudget).toBe(true);
  });
});

describe('boot recovery — PRODUCTION code, run on every boot whether or not the seam is mounted', () => {
  it('a run a previous process left mid-node is recorded `workflow.restored`, re-executed, and completed; one never dispatched just starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2ref-durability-')); dirs.push(dir);
    const dbPath = join(dir, 'host.sqlite');
    // Incarnation 1 leaves two runs behind exactly as a SIGKILL would: one
    // accepted and never dispatched, one that started a node and never finished.
    const first = await startHost({ ...BASE_CFG, dbPath });
    const B1 = `http://127.0.0.1:${first.port}`;
    // A real subject, read off a real run, so the rows below are what `POST /runs` would have written.
    const seed = await call(B1, 'POST', '/runs', { workflowId: 'conformance-noop' });
    await waitTerminal(B1, seed.b.runId);
    const owner = (await call(B1, 'GET', `/runs/${enc(seed.b.runId)}`)).b.owner as { subject: never };
    const held = acceptRun(first.host, owner.subject, 'conformance-noop', {}, {}, null);        // accepted, dispatch never called
    const midNode = acceptRun(first.host, owner.subject, 'conformance-noop', {}, {}, null);
    appendEvent(first.host, midNode, 'run.started', { workflowId: 'conformance-noop', inputs: {}, transport: 'rest', engineVersion: 1, owner });
    first.host.store.updateRun(midNode.run_id, { status: 'running', started_at: new Date().toISOString() });
    appendEvent(first.host, midNode, 'node.started', { nodeId: 'noop', typeId: 'core.noop', attempt: 0 }, { nodeId: 'noop' });
    await first.close();

    // Incarnation 2: the seam is NOT mounted. Recovery is not the seam's.
    const second = await startHost({ ...BASE_CFG, dbPath }); open.push(second);
    const B = `http://127.0.0.1:${second.port}`;
    expect(await waitTerminal(B, midNode.run_id)).toBe('completed');
    expect(await waitTerminal(B, held.run_id)).toBe('completed');
    const types = (await log(B, midNode.run_id)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(['run.started', 'node.started', 'workflow.restored']);
    expect(types.filter((t) => t === 'run.started')).toHaveLength(1);       // recovery is not a second start…
    expect(types.filter((t) => t === 'node.started')).toHaveLength(2);      // …it is a re-execution of the interrupted node
    expect(types.at(-1)).toBe('run.completed');
    const heldTypes = (await log(B, held.run_id)).map((e) => e.type);
    expect(heldTypes).not.toContain('workflow.restored');                   // nothing to restore: it had never started
    expect(heldTypes[0]).toBe('run.started');
  });
});

describe('duplicate delivery (RFC 0158 §C) — the effect is counted where it lands', () => {
  it('the same accepted work delivered twice fires ONE request while the first is still in flight, and the log carries one terminal event', async () => {
    const rx = await receiver(150); // slow enough that delivery 2 reaches the effect while delivery 1 holds the claim
    const { B } = await boot({ durabilitySeam: true });
    const fired = await call(B, 'POST', '/host/durability/kill', { mode: 'duplicate-delivery', effectUrl: rx.url });
    expect(fired.s).toBe(202); expect(fired.b.deliveries).toBe(2);
    expect(await waitTerminal(B, fired.b.runId)).toBe('completed');
    await new Promise((ok) => setTimeout(ok, 400)); // a wait for a second arrival that must not come
    expect(rx.hits).toHaveLength(1);
    expect(typeof rx.hits[0]?.['idempotency-key']).toBe('string');
    const types = (await log(B, fired.b.runId)).map((e) => e.type);
    expect(types.filter((t) => t === 'run.completed')).toHaveLength(1);     // measured before the executor guard: two
    expect(types.filter((t) => t === 'node.completed')).toHaveLength(1);
    expect(types.at(-1)).toBe('run.completed');                             // nothing appended past the terminal event
    const effects = (await call(B, 'GET', `/runs/${enc(fired.b.runId)}/effects`)).b.effects;
    expect(effects).toHaveLength(1);
  });
});
