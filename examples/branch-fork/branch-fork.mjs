// Branch-fork example — diverge a run's execution from a chosen sequence (v2 wire).
//
// `mode: 'branch'` re-executes from `fromSeq` with an optional
// `runOptionsOverlay`; events from `fromSeq` on MAY diverge by design. That is
// different from `mode: 'replay'`, which consumes the source run's events as
// fixed history for deterministic re-execution. A host advertises the modes it
// serves in the `replay` family's `modes[]`.
//
// 1. GET  /.well-known/openwop            — require `replay` with 'branch' in `modes`
// 2. POST /runs                           — a parent run that completes
// 3. POST /runs/{runId}:fork              — `{ mode: 'branch', fromSeq: 0 }` → 201
// 4. Poll the fork until terminal; read its ancestry
//
// Every request carries `OpenWOP-Version: 2`; run ids travel projected
// (`tenant~2Fopaque`, identity.md §5); creates carry an `Idempotency-Key`.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL     default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY      default openwop-v2-dev-key
//   OPENWOP_WORKFLOW_ID  default conformance-noop
//
// @see spec/v2/core/replay.md
// @see spec/v2/core/runs.md §Fork

import { randomUUID } from 'node:crypto';

// Tiny ANSI helpers — colors when stdout is a TTY, no-op when piped/CI.
const _tty = process.stdout.isTTY;
const _c = _tty
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', reset: '' };
const skip = (msg) => console.log(`${_c.dim}${msg}${_c.reset}`);
const fail = (msg) => console.error(`${_c.red}${msg}${_c.reset}`);
const ok = (msg) => console.log(`${_c.green}${msg}${_c.reset}`);

const BASE_URL = process.env.OPENWOP_BASE_URL || 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY || 'openwop-v2-dev-key';
const WORKFLOW_ID = process.env.OPENWOP_WORKFLOW_ID ?? 'conformance-noop';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const V2 = { 'OpenWOP-Version': '2' };

/** identity.md §5: every byte outside [A-Za-z0-9._-] becomes ~ plus two uppercase hex digits. */
function projectId(id) {
  return [...Buffer.from(id, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

async function http(method, path, body, { idempotencyKey } = {}) {
  const headers = { ...V2, Authorization: `Bearer ${API_KEY}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function pollUntil(runId, predicate, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await http('GET', `/runs/${projectId(runId)}`);
    if (res.status === 200 && res.json) {
      last = res.json;
      if (predicate(last)) return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out at ${timeoutMs}ms; last status: ${last?.status}`);
}

async function main() {
  console.log(`→ Discovery: ${BASE_URL}/.well-known/openwop (OpenWOP-Version: 2)`);
  const disco = await fetch(`${BASE_URL}/.well-known/openwop`, { headers: V2 });
  if (!disco.ok) throw new Error(`discovery failed: ${disco.status}`);
  if (!String(disco.headers.get('openwop-version') ?? '').startsWith('2')) {
    fail('✗ The host did not serve major 2. It may not implement v2 yet.');
    process.exit(1);
  }
  const doc = await disco.json();
  if (doc.replay == null) {
    skip('⊘ The `replay` family is not advertised by this host; it serves no fork.');
    process.exit(0);
  }
  const modes = Array.isArray(doc.replay.modes) ? doc.replay.modes : [];
  if (!modes.includes('branch')) {
    skip(`⊘ Fork mode 'branch' is not advertised by this host (replay.modes: [${modes.join(', ')}]).`);
    process.exit(0);
  }
  console.log(`  ✓ replay advertised; modes: [${modes.join(', ')}]`);

  // Phase 1 — parent run.
  const idemKey = `branch-fork-${randomUUID()}`;
  console.log(`→ POST /runs (parent) { workflowId: "${WORKFLOW_ID}" }`);
  const parent = await http('POST', '/runs', { workflowId: WORKFLOW_ID }, { idempotencyKey: idemKey });
  if (parent.status === 404) {
    skip(`⊘ Workflow "${WORKFLOW_ID}" is not installed on this host.`);
    process.exit(0);
  }
  if (parent.status !== 201) {
    fail(`✗ parent run failed: ${parent.status} ${JSON.stringify(parent.json)}`);
    process.exit(1);
  }
  const parentRunId = parent.json.runId;
  console.log(`  parentRunId: ${parentRunId}`);
  const parentSnap = await pollUntil(parentRunId, (s) => TERMINAL.has(s.status));
  console.log(`  ✓ parent reached terminal: ${parentSnap.status}`);

  // Phase 2 — branch-mode fork from sequence 0 (fromSeq is REQUIRED for branch).
  console.log(`→ POST /runs/${projectId(parentRunId)}:fork { mode: 'branch', fromSeq: 0 }`);
  const fork = await http(
    'POST',
    `/runs/${projectId(parentRunId)}:fork`,
    { mode: 'branch', fromSeq: 0 },
    { idempotencyKey: `${idemKey}-fork` },
  );
  if (fork.status !== 201) {
    fail(`✗ fork failed: ${fork.status} ${JSON.stringify(fork.json)}`);
    process.exit(1);
  }
  const forkRunId = fork.json.runId;
  console.log(`  forkRunId:   ${forkRunId}`);
  console.log(`  sourceRunId: ${fork.json.sourceRunId}`);
  console.log(`  mode:        ${fork.json.mode}`);
  console.log(`  eventsUrl:   ${fork.json.eventsUrl}`);

  // Phase 3 — the fork is a distinct run that reaches terminal on its own.
  if (forkRunId === parentRunId) {
    fail('✗ fork returned the parent runId; a fork MUST mint a new run');
    process.exit(1);
  }
  if (fork.json.sourceRunId !== parentRunId) {
    fail(`✗ fork sourceRunId ${fork.json.sourceRunId} does not name the parent`);
    process.exit(1);
  }
  const forkSnap = await pollUntil(forkRunId, (s) => TERMINAL.has(s.status));
  console.log(`  ✓ fork reached terminal: ${forkSnap.status}`);
  if (forkSnap.status !== 'completed') {
    fail(`✗ Expected the fork to complete, got ${forkSnap.status}`);
    process.exit(1);
  }

  const ancestry = await http('GET', `/runs/${projectId(forkRunId)}/ancestry`);
  if (ancestry.status === 200) console.log(`→ GET /runs/{fork}/ancestry\n  ${JSON.stringify(ancestry.json)}`);
  console.log('');
  ok('✓ Branch fork lifecycle complete');
  console.log('');
  console.log('Note: branch mode permits divergent execution by design.');
  console.log("For deterministic re-execution use mode: 'replay' (spec/v2/core/replay.md).");
}

main().catch((err) => {
  fail(`✗ ${err.message}`);
  process.exit(1);
});
