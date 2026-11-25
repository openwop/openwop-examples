#!/usr/bin/env node
/**
 * Cross-host portability check at protocol v2 (docs/portability-v2.md).
 *
 * Runs the same workflows against two v2 hosts and compares, per workflow:
 * the terminal run status, the ordered RunEvent `type` sequence, the
 * `run.completed` outputs, and (for the approval workflow) a `mode: "replay"`
 * fork of the resolved run. Host-local fields (runId, eventId, timestamp) are
 * not compared. When `--schemas` names a `schemas/v2` directory and Ajv is
 * resolvable (`--ajv-from`), every captured event is validated against
 * `run-event.schema.json`.
 *
 *   node scripts/portability-v2.mjs \
 *     --host ts=http://127.0.0.1:3838=openwop-v2-dev-key \
 *     --host py=http://127.0.0.1:3840=openwop-python-dev-key \
 *     [--schemas <dir>/schemas/v2 --ajv-from examples/hosts/v2-reference] [--out <dir>]
 *
 * fetch only; exits 1 when any compared class differs.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const hosts = [];
let schemasDir = null;
let ajvFrom = null;
let outDir = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--host') {
    const [name, ...rest] = args[++i].split('=');
    const key = rest.pop();
    hosts.push({ name, base: rest.join('='), key });
  } else if (a === '--schemas') schemasDir = args[++i];
  else if (a === '--ajv-from') ajvFrom = args[++i];
  else if (a === '--out') outDir = args[++i];
}
if (hosts.length !== 2) {
  console.error('usage: --host <name>=<baseUrl>=<apiKey> twice');
  process.exit(2);
}

// ─── Optional schema validation ──────────────────────────────────────────────
let validateEvent = null;
if (schemasDir && ajvFrom) {
  const req = createRequire(join(resolve(ajvFrom), 'package.json'));
  const Ajv2020 = req('ajv/dist/2020').default;
  const addFormats = req('ajv-formats').default;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(schemasDir).filter((x) => x.endsWith('.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, f), 'utf8'))); } catch { /* duplicate id */ }
  }
  validateEvent = ajv.getSchema('https://openwop.dev/spec/v2/run-event.schema.json');
}

// ─── Driving one host ────────────────────────────────────────────────────────
const project = (id) => id.replace(/[^A-Za-z0-9._-]/g, (c) => [...Buffer.from(c)].map((b) => `~${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(host, method, path, body) {
  const headers = { 'OpenWOP-Version': '2', Authorization: `Bearer ${host.key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Idempotency-Key'] = randomBytes(18).toString('base64url');
  const res = await fetch(`${host.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Poll the log until the run is terminal or waiting; returns the snapshot. */
async function settle(host, runId) {
  for (let i = 0; i < 300; i++) {
    const snap = await call(host, 'GET', `/runs/${project(runId)}`);
    const s = snap.body?.status;
    if (['completed', 'failed', 'cancelled', 'waiting-approval', 'waiting-input', 'waiting-external'].includes(s)) return snap.body;
    await sleep(50);
  }
  throw new Error(`${host.name}: ${runId} did not settle`);
}

async function events(host, runId) {
  const r = await call(host, 'GET', `/runs/${project(runId)}/events/poll?timeout=1`);
  return r.body.events;
}

async function runCase(host, c) {
  const created = await call(host, 'POST', '/runs', { workflowId: c.workflowId, ...(c.inputs ? { inputs: c.inputs } : {}) });
  if (created.status !== 201) return { refused: { status: created.status, error: created.body?.error } };
  const runId = created.body.runId;
  let snap = await settle(host, runId);
  if (c.resolve && snap.status === 'waiting-approval') {
    const r = await call(host, 'POST', `/runs/${project(runId)}/interrupts/${c.resolve.nodeId}`, { resumeValue: c.resolve.resumeValue });
    if (r.status !== 200) throw new Error(`${host.name}: resolve answered ${r.status} ${JSON.stringify(r.body)}`);
    snap = await settle(host, runId);
  }
  const out = { status: snap.status, events: await events(host, runId) };
  if (c.replay) {
    const f = await call(host, 'POST', `/runs/${project(runId)}:fork`, { mode: 'replay' });
    if (f.status !== 201) throw new Error(`${host.name}: fork answered ${f.status} ${JSON.stringify(f.body)}`);
    const fs = await settle(host, f.body.runId);
    out.replay = { status: fs.status, events: await events(host, f.body.runId) };
  }
  return out;
}

// ─── Comparison ──────────────────────────────────────────────────────────────
const CASES = [
  { workflowId: 'conformance-noop', core: true },
  { workflowId: 'conformance-delay', core: true, inputs: { delayMs: 200 } },
  { workflowId: 'conformance-multi-node', core: true },
  { workflowId: 'conformance-failure' },
  { workflowId: 'conformance-approval', resolve: { nodeId: 'gate', resumeValue: { action: 'accept' } }, replay: true },
  { workflowId: 'conformance-identity', inputs: { payload: { hello: 'world' } } },
];

const types = (evs) => evs.map((e) => e.type);
const completedOutputs = (evs) => JSON.stringify(evs.find((e) => e.type === 'run.completed')?.payload?.outputs ?? null);
const resolvedValue = (evs) => JSON.stringify(evs.find((e) => e.type === 'interrupt.resolved')?.payload?.resumeValue ?? null);
const schemaErrors = (evs) => (validateEvent ? evs.filter((e) => !validateEvent(e)).length : null);

const rows = [];
let diverged = false;
const captures = {};
for (const c of CASES) {
  const [a, b] = await Promise.all(hosts.map((h) => runCase(h, c)));
  captures[c.workflowId] = { [hosts[0].name]: a, [hosts[1].name]: b };
  const row = { workflow: c.workflowId, core: !!c.core };
  if (a.refused || b.refused) {
    row.terminal = `${a.refused ? `refused ${a.refused.status} ${a.refused.error}` : a.status} / ${b.refused ? `refused ${b.refused.status} ${b.refused.error}` : b.status}`;
    row.same = JSON.stringify(a.refused) === JSON.stringify(b.refused);
    row.sequence = row.same ? 'n/a (both refused at creation)' : 'divergent';
  } else {
    const sameTypes = JSON.stringify(types(a.events)) === JSON.stringify(types(b.events));
    const sameOutputs = completedOutputs(a.events) === completedOutputs(b.events);
    row.terminal = `${a.status} / ${b.status}`;
    row.counts = `${a.events.length} / ${b.events.length}`;
    row.sequence = sameTypes ? types(a.events).join(' → ') : `A: ${types(a.events).join(' → ')}\nB: ${types(b.events).join(' → ')}`;
    row.outputs = sameOutputs ? 'equal' : `${completedOutputs(a.events)} vs ${completedOutputs(b.events)}`;
    row.schema = validateEvent ? `${schemaErrors(a.events)} / ${schemaErrors(b.events)} invalid` : 'not checked';
    row.same = a.status === b.status && sameTypes && sameOutputs;
    if (a.replay) {
      const sameReplay = a.replay.status === b.replay.status && JSON.stringify(types(a.replay.events)) === JSON.stringify(types(b.replay.events));
      const pinned = resolvedValue(a.replay.events) === resolvedValue(a.events) && resolvedValue(b.replay.events) === resolvedValue(b.events);
      row.replay = {
        terminal: `${a.replay.status} / ${b.replay.status}`,
        sequence: sameReplay ? types(a.replay.events).join(' → ') : `A: ${types(a.replay.events).join(' → ')}\nB: ${types(b.replay.events).join(' → ')}`,
        pinned,
        schema: validateEvent ? `${schemaErrors(a.replay.events)} / ${schemaErrors(b.replay.events)} invalid` : 'not checked',
        same: sameReplay && pinned,
      };
      row.same = row.same && row.replay.same;
    }
  }
  if (!row.same) diverged = true;
  rows.push(row);
}

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'captures.json'), JSON.stringify({ hosts: hosts.map(({ name, base }) => ({ name, base })), captures }, null, 2));
  writeFileSync(join(outDir, 'comparison.json'), JSON.stringify(rows, null, 2));
}
console.log(JSON.stringify(rows, null, 2));
process.exit(diverged ? 1 : 0);
