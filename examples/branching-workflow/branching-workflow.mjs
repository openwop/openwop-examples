// Branching-workflow example — DAG executor proof on the v2 wire.
//
// 1. GET  /.well-known/openwop              — confirm the host serves major 2
// 2. GET  /workflows/branching-demo         — confirm the host has the workflow installed
// 3. POST /runs { workflowId, inputs }      — start it
// 4. Poll GET /runs/{runId} until terminal
// 5. GET  /runs/{runId}/events/poll         — assert that branchA and branchB both
//    emitted node.started BEFORE either emitted node.completed: the witness that
//    the two branches ran concurrently, not serially.
//
// v2 has no workflow-registration operation: a host installs definitions
// through its own tooling (a workflow-chain pack, an admin surface, a seeded
// catalog). `workflow.json` here is the definition to install. When the host
// does not have it, the example says so and exits 0.
//
// Every request carries `OpenWOP-Version: 2`; run ids travel projected
// (`tenant~2Fopaque`, identity.md §5); the create carries an `Idempotency-Key`.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL  default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY   default openwop-v2-dev-key

import { randomUUID } from 'node:crypto';

const tty = process.stdout.isTTY;
const c = tty
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', cyan: '', reset: '' };
const skip = (m) => console.log(`${c.dim}${m}${c.reset}`);
const fail = (m) => console.error(`${c.red}${m}${c.reset}`);
const ok = (m) => console.log(`${c.green}${m}${c.reset}`);
const info = (m) => console.log(`${c.cyan}${m}${c.reset}`);

const BASE = process.env.OPENWOP_BASE_URL || 'http://127.0.0.1:3838';
const KEY = process.env.OPENWOP_API_KEY || 'openwop-v2-dev-key';
const WORKFLOW_ID = 'branching-demo';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const V2 = { 'OpenWOP-Version': '2' };

/** identity.md §5: every byte outside [A-Za-z0-9._-] becomes ~ plus two uppercase hex digits. */
function projectId(id) {
  return [...Buffer.from(id, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

async function http(method, path, body, extraHeaders = {}) {
  const headers = { ...V2, Authorization: `Bearer ${KEY}`, ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

async function pollUntilTerminal(runId, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await http('GET', `/runs/${projectId(runId)}`);
    if (res.status === 200 && res.json) {
      last = res.json;
      if (TERMINAL.has(last.status)) return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`run did not reach terminal within ${timeoutMs}ms; last status: ${last?.status ?? 'unknown'}`);
}

async function fetchEvents(runId) {
  const res = await http('GET', `/runs/${projectId(runId)}/events/poll`);
  if (res.status !== 200) throw new Error(`events poll failed: ${res.status}`);
  return res.json?.events ?? [];
}

function assertConcurrentBranches(events) {
  const sigs = {};
  for (const e of events) {
    if ((e.type === 'node.started' || e.type === 'node.completed') && (e.nodeId === 'branchA' || e.nodeId === 'branchB')) {
      sigs[`${e.nodeId}:${e.type.slice(5)}`] = e.sequence;
    }
  }
  const aStarted = sigs['branchA:started'];
  const bStarted = sigs['branchB:started'];
  const aCompleted = sigs['branchA:completed'];
  const bCompleted = sigs['branchB:completed'];
  if (aStarted === undefined || bStarted === undefined) {
    throw new Error(`missing node.started for one branch (sigs=${JSON.stringify(sigs)})`);
  }
  if (aCompleted === undefined || bCompleted === undefined) {
    throw new Error(`missing node.completed for one branch (sigs=${JSON.stringify(sigs)})`);
  }
  // Witness: both started BEFORE either completed.
  const lastStarted = Math.max(aStarted, bStarted);
  const firstCompleted = Math.min(aCompleted, bCompleted);
  if (lastStarted >= firstCompleted) {
    throw new Error(
      `branches ran serially, not concurrently. lastStarted=${lastStarted} firstCompleted=${firstCompleted}. ` +
        'Either the host executor is linear, or its node concurrency is 1.',
    );
  }
  return { aStarted, bStarted, aCompleted, bCompleted };
}

async function main() {
  info(`→ Discovery: ${BASE}/.well-known/openwop (OpenWOP-Version: 2)`);
  const disco = await http('GET', '/.well-known/openwop');
  if (disco.status !== 200) {
    fail(`✗ discovery failed: HTTP ${disco.status}`);
    process.exit(1);
  }
  const served = disco.headers.get('openwop-version') ?? '';
  if (!served.startsWith('2')) {
    fail(`✗ The host did not serve major 2 (served ${served || 'no OpenWOP-Version'}).`);
    process.exit(1);
  }
  ok(`  ✓ Host reachable (OpenWOP-Version ${served}, ${disco.json?.implementation?.name ?? 'unknown host'})`);

  info(`→ GET /workflows/${WORKFLOW_ID}`);
  const wf = await http('GET', `/workflows/${WORKFLOW_ID}`);
  if (wf.status === 404) {
    skip(`⊘ Workflow "${WORKFLOW_ID}" is not installed on this host.`);
    skip('  v2 defines no workflow-registration operation; install workflow.json through the');
    skip("  host's own tooling, then re-run. Its node types (local.sample.demo.*, core.flow.merge)");
    skip('  must be ones the host executes, and the executor must run DAG branches concurrently.');
    process.exit(0);
  }
  if (wf.status !== 200) {
    fail(`✗ workflow read failed: HTTP ${wf.status} ${JSON.stringify(wf.json)}`);
    process.exit(1);
  }
  ok(`  ✓ Installed: ${wf.json?.nodes?.length ?? '?'} nodes, ${wf.json?.edges?.length ?? '?'} edges`);

  info(`→ POST /runs { workflowId: "${WORKFLOW_ID}" }`);
  const startRes = await http(
    'POST',
    '/runs',
    { workflowId: WORKFLOW_ID, inputs: { message: 'hello' } },
    { 'Idempotency-Key': `branching-workflow-${randomUUID()}` },
  );
  if (startRes.status !== 201) {
    fail(`✗ run start failed: HTTP ${startRes.status} ${JSON.stringify(startRes.json)}`);
    process.exit(1);
  }
  const runId = startRes.json?.runId;
  ok(`  ✓ Run started: ${runId}`);

  info('→ Polling for terminal state…');
  const t0 = Date.now();
  const terminal = await pollUntilTerminal(runId);
  const durationMs = Date.now() - t0;
  if (terminal.status !== 'completed') {
    fail(`✗ run terminal: ${terminal.status}`);
    if (terminal.error) fail(`  error: ${JSON.stringify(terminal.error)}`);
    process.exit(1);
  }
  ok(`  ✓ Run completed in ${durationMs}ms`);

  info('→ Event log:');
  const events = await fetchEvents(runId);
  for (const e of events) {
    const tag = e.type.replace('node.', '').replace('run.', '').padEnd(12);
    console.log(`    seq=${String(e.sequence).padStart(2)}  ${tag}  ${e.nodeId ?? ''}`);
  }

  info('→ Concurrency witness:');
  const witness = assertConcurrentBranches(events);
  ok(`  ✓ Both branches emitted node.started (sequences ${witness.aStarted}, ${witness.bStarted})`);
  ok(`  ✓ before either emitted node.completed (sequences ${witness.aCompleted}, ${witness.bCompleted})`);
  ok('');
  ok('✓ branching-workflow PASSED — DAG executor ran branches concurrently.');
}

main().catch((err) => {
  fail(`✗ branching-workflow FAILED: ${err.message}`);
  process.exit(1);
});
