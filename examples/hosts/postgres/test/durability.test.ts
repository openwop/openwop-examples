/**
 * The postgres host's reasons to exist, tested.
 *
 * Always (PGlite, no server needed):
 *   1. the v2 floor end to end over HTTP — discovery, create, an approval
 *      interrupt resolved, a replay fork that takes the recorded resolution,
 *      no /v1 path space, 406 for another major, and a clean audit chain.
 *   2. a database the v1 host wrote — seeded with the v1 host's own DDL and
 *      rows — reads as era 2, forks into an era-3 child, and a run suspended
 *      at the cut resumes.
 *   3. crash-resume on one PGlite directory — a host process is SIGKILLed
 *      mid-run, the next one opens the directory and finishes the run once.
 *
 * With OPENWOP_PG_DSN (a real Postgres; CI runs a service container), the
 * multi-process properties the advisory locks exist for:
 *   4. takeover — two host processes on one database; the one executing a
 *      run is SIGKILLed; Postgres releases its lock and the other process's
 *      sweep finishes the run, with one `run.started` and one terminal.
 *   5. no double execution — while a live process holds a run's lock, a
 *      second process does not execute it; a cancel sent to the second
 *      process is carried out by the first.
 *
 *   npm test      (tsx test/durability.test.ts)
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { startHost } from '../src/server.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY = 'openwop-postgres-dev-key';
const TENANT = 'openwop-postgres-tenant';
const DSN = process.env['OPENWOP_PG_DSN'] || null;
const dir = mkdtempSync(join(tmpdir(), 'openwop-pg-test-'));
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

async function until<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

const statusOf = async (base: string, runId: string): Promise<string> => (await call(base, 'GET', `/runs/${project(runId)}`)).json.status as string;
const eventsOf = async (base: string, runId: string): Promise<Array<{ type: string; payload: any }>> =>
  (await call(base, 'GET', `/runs/${project(runId)}/events/poll?timeout=1`)).json.events as Array<{ type: string; payload: any }>;
const typesOf = async (base: string, runId: string): Promise<string[]> => (await eventsOf(base, runId)).map((e) => e.type);
const reach = (base: string, runId: string, status: string): Promise<true> => until(async () => ((await statusOf(base, runId)) === status ? true : undefined));

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
  });
}

/** A host in its own OS process, so it can really be killed. */
async function childHost(env: Record<string, string>): Promise<{ child: ChildProcess; base: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src/server.ts')], {
    cwd: ROOT,
    env: { ...process.env, OPENWOP_PORT: String(port), OPENWOP_AUDIT_KEY_DIR: join(dir, 'audit-key'), OPENWOP_CLAIM_SWEEP_MS: '300', ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${base}/.well-known/openwop`)).ok ? true : undefined; } catch { return undefined; } });
  return { child, base };
}
const kill = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
};

let failures = 0;
let skipped = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${(e as Error).stack}`); }
}
function skip(name: string, why: string): void { skipped++; console.log(`skip ${name} (${why})`); }

// ─── PGlite ──────────────────────────────────────────────────────────────────

await test('the v2 floor: discovery, create, interrupt, replay fork, audit', async () => {
  const host = await startHost({ port: 0, dsn: null, pgliteDir: null, auditKeyDir: null });
  try {
    const base = `http://127.0.0.1:${host.port}`;
    const disco = await fetch(`${base}/.well-known/openwop`);
    assert.equal(disco.headers.get('openwop-version'), '2.0');
    const doc = (await disco.json()) as Record<string, any>;
    assert.deepEqual(doc['protocolVersions'], ['2.0']);
    assert.equal(doc['eventLogSchemaVersion'], 3);
    assert.ok(doc['fixtures'].includes('conformance-approval'));
    assert.equal(doc['auditLogIntegrity']?.checkpointSignatureAlgorithm, 'ed25519');

    const run = (await call(base, 'POST', '/runs', { workflowId: 'conformance-approval' })).json.runId as string;
    await reach(base, run, 'waiting-approval');
    const resolved = await call(base, 'POST', `/runs/${project(run)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    assert.equal(resolved.status, 200);
    await reach(base, run, 'completed');
    const again = await call(base, 'POST', `/runs/${project(run)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    assert.equal(again.json.error, 'interrupt_already_resolved');

    const fork = await call(base, 'POST', `/runs/${project(run)}:fork`, { mode: 'replay' });
    assert.equal(fork.status, 201);
    const child = fork.json.runId as string;
    await reach(base, child, 'completed');
    assert.ok(!(await typesOf(base, child)).includes('interrupt.requested'), 'a replay takes the recorded resolution');

    assert.equal((await call(base, 'POST', '/v1/runs', { workflowId: 'conformance-noop' })).status, 404, 'there is no /v1 path space');
    assert.equal((await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '1' } })).status, 406);

    const verify = await call(base, 'GET', '/audit/verify?fromSeq=0&toSeq=1000');
    assert.equal(verify.status, 200);
    assert.equal(verify.json.chainValid, true);
    // host.started plus one entry per successful write: create, resolve, fork (the refused resolve is not one).
    const tip = await host.db.query<{ n: number }>('SELECT MAX(seq) AS n FROM audit_log');
    assert.equal(tip.rows[0]?.n, 4);
  } finally { await host.close(); }
});

await test('a v1 database: era-2 reads, an era-3 fork, a suspended run resumes', async () => {
  const dataDir = join(dir, 'v1-pglite');
  // The v1 host's own DDL (examples/hosts/postgres/src/schema.ts before the port) and the rows it wrote.
  const v1 = new PGlite(dataDir);
  await v1.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, inputs_json JSONB NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, error_json JSONB, claim_holder_id TEXT, claim_expires_at BIGINT,
      next_node_index INTEGER NOT NULL DEFAULT 0, next_event_seq INTEGER NOT NULL DEFAULT 0, parent_run_id TEXT,
      parent_node_id TEXT, configurable_json JSONB, variables_json JSONB, channels_json JSONB);
    CREATE TABLE events (run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL,
      node_id TEXT, data_json JSONB, timestamp TEXT NOT NULL, causation_id TEXT, PRIMARY KEY (run_id, seq));
    INSERT INTO runs (run_id, workflow_id, status, inputs_json, started_at, ended_at, next_event_seq)
      VALUES ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000001', 'conformance-noop', 'completed', '{}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z', 4),
             ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000002', 'conformance-approval', 'waiting-approval', '{}', '2026-09-01T00:00:00.000Z', NULL, 3);
    INSERT INTO events (run_id, seq, type, node_id, data_json, timestamp) VALUES
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000001', 0, 'run.started', NULL, NULL, '2026-09-01T00:00:00.000Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000001', 1, 'node.started', 'noop', '{"nodeId":"noop"}', '2026-09-01T00:00:00.100Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000001', 2, 'node.completed', 'noop', NULL, '2026-09-01T00:00:00.200Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000001', 3, 'run.completed', NULL, '{"outputs":{}}', '2026-09-01T00:00:01.000Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000002', 0, 'run.started', NULL, NULL, '2026-09-01T00:00:00.000Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000002', 1, 'node.started', 'gate', '{"nodeId":"gate"}', '2026-09-01T00:00:00.100Z'),
      ('run-5b2f0c1e-0d4a-4a8e-9f00-000000000002', 2, 'node.suspended', 'gate', '{"nodeId":"gate","data":{"kind":"approval","nodeId":"gate","config":{"actions":["accept","reject"]}}}', '2026-09-01T00:00:00.200Z');
  `);
  await v1.close();

  const host = await startHost({ port: 0, dsn: null, pgliteDir: dataDir, auditKeyDir: join(dir, 'v1-audit') });
  try {
    const base = `http://127.0.0.1:${host.port}`;
    const done = `${TENANT}/run-5b2f0c1e-0d4a-4a8e-9f00-000000000001`;
    const snap = (await call(base, 'GET', `/runs/${project(done)}`)).json;
    assert.equal(snap.status, 'completed');
    assert.equal(snap.eventLogSchemaVersion, 2, 'a v1 run stays era 2');
    assert.equal(snap.owner.subject.issuer, 'urn:openwop:legacy');
    assert.deepEqual(await typesOf(base, done), ['run.started', 'node.started', 'node.completed', 'run.completed']);
    assert.equal((await call(base, 'GET', '/runs/run-5b2f0c1e-0d4a-4a8e-9f00-000000000001')).status, 400, 'the bare v1 id is refused: v2 ids are tenant-bound');

    const fork = await call(base, 'POST', `/runs/${project(done)}:fork`, { mode: 'branch', fromSeq: 1 });
    assert.equal(fork.status, 201);
    await reach(base, fork.json.runId, 'completed');
    assert.equal((await call(base, 'GET', `/runs/${project(fork.json.runId)}`)).json.eventLogSchemaVersion, 3, 'the fork is an era-3 run');

    const gate = `${TENANT}/run-5b2f0c1e-0d4a-4a8e-9f00-000000000002`;
    assert.equal((await call(base, 'GET', `/runs/${project(gate)}`)).json.currentNodeId, 'gate');
    const r = await call(base, 'POST', `/runs/${project(gate)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await reach(base, gate, 'completed');
    const types = await typesOf(base, gate);
    assert.equal(types.at(-1), 'run.completed');
    assert.equal(types.filter((t) => t === 'run.started').length, 1);
    const era = await host.db.query<{ v: number | null }>(`SELECT event_log_schema_version AS v FROM runs WHERE run_id = 'run-5b2f0c1e-0d4a-4a8e-9f00-000000000002'`);
    assert.equal(era.rows[0]?.v, null, 'the v1 row was not rewritten as era 3');
  } finally { await host.close(); }
});

await test('crash-resume on a PGlite directory: SIGKILL mid-run, the next process finishes it once', async () => {
  const dataDir = join(dir, 'crash-pglite');
  const { child, base } = await childHost({ OPENWOP_PG_DSN: '', OPENWOP_PGLITE_DIR: dataDir });
  const created = await call(base, 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 1500 } });
  assert.equal(created.status, 201);
  const runId = created.json.runId as string;
  await reach(base, runId, 'running');
  await kill(child);
  const next = await startHost({ port: 0, dsn: null, pgliteDir: dataDir, auditKeyDir: join(dir, 'audit-key') });
  try {
    const nb = `http://127.0.0.1:${next.port}`;
    await reach(nb, runId, 'completed');
    const types = await typesOf(nb, runId);
    assert.equal(types.filter((t) => t === 'run.started').length, 1, types.join(','));
    assert.equal(types.filter((t) => t === 'run.completed').length, 1, types.join(','));
  } finally { await next.close(); }
});

// ─── A real Postgres, several processes ──────────────────────────────────────

if (DSN === null) {
  skip('takeover: a SIGKILLed process\'s run is finished by another process', 'OPENWOP_PG_DSN unset');
  skip('no double execution: a live lock keeps a second process off the run', 'OPENWOP_PG_DSN unset');
} else {
  // A fresh database per test run, dropped at the end.
  const admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  const dbName = `openwop_test_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  const testDsn = url.toString();
  const children: ChildProcess[] = [];
  try {
    await test('takeover: a SIGKILLed process\'s run is finished by another process', async () => {
      const a = await childHost({ OPENWOP_PG_DSN: testDsn });
      children.push(a.child);
      const b = await childHost({ OPENWOP_PG_DSN: testDsn });
      children.push(b.child);
      const runId = (await call(a.base, 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 1500 } })).json.runId as string;
      await reach(a.base, runId, 'running');
      const holder = await admin.query(`SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE d.datname = $1 AND l.locktype = 'advisory' AND l.classid = 28535 AND l.granted`, [dbName]);
      assert.ok(holder.rows.length >= 1, 'the executing process holds an advisory lock');
      await kill(a.child);
      await reach(b.base, runId, 'completed');
      const types = await typesOf(b.base, runId);
      assert.equal(types.filter((t) => t === 'run.started').length, 1, types.join(','));
      assert.equal(types.filter((t) => t === 'run.completed').length, 1, types.join(','));
      assert.equal(types.at(-1), 'run.completed');
      await kill(b.child);
    });

    await test('no double execution: a live lock keeps a second process off the run', async () => {
      const a = await childHost({ OPENWOP_PG_DSN: testDsn });
      children.push(a.child);
      const b = await childHost({ OPENWOP_PG_DSN: testDsn });
      children.push(b.child);
      const runId = (await call(a.base, 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 1500 } })).json.runId as string;
      await reach(a.base, runId, 'running');
      await sleep(900); // three sweeps of b
      await reach(b.base, runId, 'completed');
      assert.deepEqual(await typesOf(b.base, runId), ['run.started', 'node.started', 'node.completed', 'run.completed']);

      // A cancel sent to b, for a run a is executing, is carried out by a.
      const long = (await call(a.base, 'POST', '/runs', { workflowId: 'conformance-delay', inputs: { delayMs: 20_000 } })).json.runId as string;
      await reach(a.base, long, 'running');
      const c = await call(b.base, 'POST', `/runs/${project(long)}/cancel`, {});
      assert.equal(c.json.status, 'cancelling', 'b sees the run locked elsewhere and flags it');
      await reach(b.base, long, 'cancelled');
      const types = await typesOf(b.base, long);
      assert.deepEqual(types, ['run.started', 'node.started', 'node.cancelled', 'run.cancelled']);
      await kill(a.child);
      await kill(b.child);
    });
  } finally {
    for (const c of children) await kill(c);
    await sleep(200);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

rmSync(dir, { recursive: true, force: true });
if (failures > 0) { console.log(`${failures} test(s) failed`); process.exit(1); }
console.log(`all tests passed${skipped > 0 ? ` (${skipped} skipped)` : ''}`);
