/**
 * The sqlite host's reason to exist: a run outlives the process executing it.
 *
 *   1. crash-resume — a host process is SIGKILLed mid-run; its claim lapses;
 *      the next host to open the file resumes the run from its event log and
 *      completes it, with one `run.started` and one terminal event.
 *   2. no double execution — while a live process holds a run's claim, a
 *      second process on the same file does not execute it.
 *   3. the v2 floor end to end over HTTP — discovery, create, poll, an
 *      approval interrupt resolved, a replay fork that short-circuits to the
 *      recorded resolution.
 *
 *   npm test      (tsx test/durability.test.ts)
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../src/server.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY = 'openwop-sqlite-dev-key';
const dir = mkdtempSync(join(tmpdir(), 'openwop-sqlite-test-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const project = (id: string): string => id.replace('/', '~2F');

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'OpenWOP-Version': '2', Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

const statusOf = async (base: string, runId: string): Promise<string> => (await call(base, 'GET', `/runs/${project(runId)}`)).json.status as string;
const typesOf = async (base: string, runId: string): Promise<string[]> =>
  ((await call(base, 'GET', `/runs/${project(runId)}/events/poll?timeout=1`)).json.events as Array<{ type: string }>).map((e) => e.type);

/** A host in its own OS process, so it can really be killed. */
async function childHost(dbPath: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/server.ts')], {
    cwd: ROOT,
    env: { ...process.env, OPENWOP_PORT: String(port), OPENWOP_SQLITE_PATH: dbPath, OPENWOP_CLAIM_TTL_MS: '1000', OPENWOP_HEARTBEAT_INTERVAL_MS: '250' },
    stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/.well-known/openwop`)).ok ? true : undefined; } catch { return undefined; } });
  return child;
}

let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${(e as Error).stack}`); }
}

await test('crash-resume: a SIGKILLed host\'s run is resumed by the next host and completes once', async () => {
  const dbPath = join(dir, 'crash.sqlite');
  const child = await childHost(dbPath, 4971);
  const created = await call('http://127.0.0.1:4971', 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 1500 } });
  assert.equal(created.status, 201);
  const runId = created.json.runId as string;
  await until(async () => ((await statusOf('http://127.0.0.1:4971', runId)) === 'running' ? true : undefined));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  await sleep(1200); // the dead process's claim lapses (TTL 1000 ms)
  const next = await startHost({ port: 0, dbPath, claimTtlMs: 1000, heartbeatMs: 250 });
  try {
    const base = `http://127.0.0.1:${next.port}`;
    await until(async () => ((await statusOf(base, runId)) === 'completed' ? true : undefined));
    const types = await typesOf(base, runId);
    assert.equal(types.filter((t) => t === 'run.started').length, 1, `one run.started: ${types.join(',')}`);
    assert.equal(types.filter((t) => t === 'run.completed').length, 1, `one run.completed: ${types.join(',')}`);
    assert.equal(types.at(-1), 'run.completed');
  } finally { await next.close(); }
});

await test('no double execution: a live claim keeps a second process off the run', async () => {
  const dbPath = join(dir, 'claim.sqlite');
  const child = await childHost(dbPath, 4972);
  try {
    const created = await call('http://127.0.0.1:4972', 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 1500 } });
    const runId = created.json.runId as string;
    await until(async () => ((await statusOf('http://127.0.0.1:4972', runId)) === 'running' ? true : undefined));
    const second = await startHost({ port: 0, dbPath, claimTtlMs: 1000, heartbeatMs: 250 });
    try {
      const base = `http://127.0.0.1:${second.port}`;
      await until(async () => ((await statusOf(base, runId)) === 'completed' ? true : undefined));
      const types = await typesOf(base, runId);
      assert.deepEqual(types, ['run.started', 'node.started', 'node.completed', 'run.completed']);
    } finally { await second.close(); }
  } finally { child.kill('SIGKILL'); }
});

await test('the v2 floor: discovery, create, interrupt, replay fork', async () => {
  const host = await startHost({ port: 0, dbPath: join(dir, 'floor.sqlite') });
  try {
    const base = `http://127.0.0.1:${host.port}`;
    const disco = await fetch(`${base}/.well-known/openwop`);
    assert.equal(disco.headers.get('openwop-version'), '2.0');
    const doc = (await disco.json()) as Record<string, any>;
    assert.deepEqual(doc['protocolVersions'], ['2.0']);
    assert.equal(doc['eventLogSchemaVersion'], 3);
    assert.ok(doc['fixtures'].includes('conformance-approval'));

    const run = (await call(base, 'POST', '/runs', { workflowId: 'conformance-approval' })).json.runId as string;
    await until(async () => ((await statusOf(base, run)) === 'waiting-approval' ? true : undefined));
    const resolved = await call(base, 'POST', `/runs/${project(run)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    assert.equal(resolved.status, 200);
    await until(async () => ((await statusOf(base, run)) === 'completed' ? true : undefined));
    const again = await call(base, 'POST', `/runs/${project(run)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    assert.equal(again.json.error, 'interrupt_already_resolved');

    const fork = await call(base, 'POST', `/runs/${project(run)}:fork`, { mode: 'replay' });
    assert.equal(fork.status, 201);
    const child = fork.json.runId as string;
    await until(async () => ((await statusOf(base, child)) === 'completed' ? true : undefined));
    const types = await typesOf(base, child);
    assert.ok(!types.includes('interrupt.requested'), `a replay takes the recorded resolution: ${types.join(',')}`);

    const v1 = await call(base, 'POST', '/v1/runs', { workflowId: 'conformance-noop' });
    assert.equal(v1.status, 404, 'there is no /v1 path space');
    const refused = await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '1' } });
    assert.equal(refused.status, 406);
  } finally { await host.close(); }
});

rmSync(dir, { recursive: true, force: true });
if (failures > 0) { console.log(`${failures} test(s) failed`); process.exit(1); }
console.log('all tests passed');
