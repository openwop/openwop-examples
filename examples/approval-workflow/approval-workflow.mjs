// Approval-workflow example — the full HITL approval lifecycle on the v2 wire.
//
// 1. GET  /.well-known/openwop                       — require the `interrupt` family
// 2. POST /runs { workflowId }                       — a workflow that suspends at an approval gate
// 3. Poll GET /runs/{runId} until `waiting-approval`  — `currentNodeId` names the gate
// 4. POST /runs/{runId}/interrupts/{nodeId}          — `{ resumeValue: { action: 'accept', decidedAt } }`
// 5. Poll until `completed`
// 6. Read the event log: `interrupt.requested` then `interrupt.resolved`
//
// Every request carries `OpenWOP-Version: 2`. Run ids are tenant-bound and
// travel in a path projected (`tenant~2Fopaque`, identity.md §5). Creates and
// resolves carry an `Idempotency-Key` (idempotency.md), so a retried request
// never starts a second run or casts a second vote.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL     default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY      default openwop-v2-dev-key
//   OPENWOP_WORKFLOW_ID  default conformance-approval
//
// @see spec/v2/core/interrupt.md (§Resolve surfaces, §Approval)
// @see spec/v2/core/idempotency.md

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
const WORKFLOW_ID = process.env.OPENWOP_WORKFLOW_ID ?? 'conformance-approval';
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
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
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
  if (doc.interrupt == null) {
    skip('⊘ The `interrupt` family is not advertised by this host; nothing to resolve.');
    process.exit(0);
  }
  console.log(`  ✓ interrupt advertised (status: ${doc.interrupt.status}, tokenAlgs: [${(doc.interrupt.tokenAlgs ?? []).join(', ')}])`);
  if (Array.isArray(doc.fixtures) && !doc.fixtures.includes(WORKFLOW_ID)) {
    skip(`⊘ Workflow "${WORKFLOW_ID}" is not advertised by this host (discovery \`fixtures[]\`).`);
    skip('  Set OPENWOP_WORKFLOW_ID to a workflow with an approval gate.');
    process.exit(0);
  }

  console.log(`→ POST /runs { workflowId: "${WORKFLOW_ID}" }`);
  const create = await http('POST', '/runs', { workflowId: WORKFLOW_ID }, { idempotencyKey: `approval-workflow-${randomUUID()}` });
  if (create.status === 404) {
    skip(`⊘ Workflow "${WORKFLOW_ID}" not found on this host.`);
    skip('  Set OPENWOP_WORKFLOW_ID to a workflow with an approval gate.');
    process.exit(0);
  }
  if (create.status !== 201) {
    fail(`✗ run creation failed: ${create.status} ${JSON.stringify(create.json)}`);
    process.exit(1);
  }
  const { runId } = create.json;
  console.log(`  runId: ${runId}`);

  console.log('→ Polling until waiting-approval...');
  const suspended = await pollUntil(runId, (s) => s.status === 'waiting-approval' || TERMINAL.has(s.status));
  if (suspended.status !== 'waiting-approval') {
    fail(`✗ Expected waiting-approval, got ${suspended.status}`);
    process.exit(1);
  }
  const nodeId = suspended.currentNodeId;
  if (typeof nodeId !== 'string' || nodeId.length === 0) {
    fail('✗ Suspended snapshot missing currentNodeId; cannot drive approval.');
    process.exit(1);
  }
  console.log(`  ✓ Suspended at node ${nodeId}`);

  console.log(`→ POST /runs/${projectId(runId)}/interrupts/${nodeId} { resumeValue: { action: 'accept' } }`);
  const resolve = await http(
    'POST',
    `/runs/${projectId(runId)}/interrupts/${encodeURIComponent(nodeId)}`,
    { resumeValue: { action: 'accept', decidedAt: new Date().toISOString() } },
    { idempotencyKey: `approval-workflow-resolve-${randomUUID()}` },
  );
  if (resolve.status !== 200) {
    fail(`✗ approval resolve failed: ${resolve.status} ${JSON.stringify(resolve.json)}`);
    process.exit(1);
  }
  console.log('  ✓ accept recorded');

  console.log('→ Polling until terminal...');
  // Generous post-approval timeout: a real approval workflow may have delay
  // nodes or sub-workflows after the gate. `conformance-approval` completes
  // in milliseconds.
  const terminal = await pollUntil(runId, (s) => TERMINAL.has(s.status), { timeoutMs: 60000 });
  console.log(`  status: ${terminal.status}`);
  if (terminal.status !== 'completed') {
    fail(`✗ Expected completed, got ${terminal.status}`);
    process.exit(1);
  }

  console.log(`→ GET /runs/${projectId(runId)}/events/poll`);
  const log = await http('GET', `/runs/${projectId(runId)}/events/poll`);
  if (log.status !== 200) throw new Error(`events poll failed: ${log.status}`);
  const events = log.json?.events ?? [];
  for (const e of events) console.log(`  [${e.sequence}] ${e.type}${e.nodeId ? ` node=${e.nodeId}` : ''}`);
  const requested = events.findIndex((e) => e.type === 'interrupt.requested');
  const resolved = events.findIndex((e) => e.type === 'interrupt.resolved');
  if (requested < 0 || resolved < requested) {
    fail('✗ Expected interrupt.requested followed by interrupt.resolved in the event log');
    process.exit(1);
  }
  console.log(`  ✓ resolved action: ${events[resolved].payload?.action ?? events[resolved].payload?.resumeValue?.action ?? '<unrecorded>'}`);
  console.log('');
  ok('✓ Approval workflow round-trip complete');
}

main().catch((err) => {
  fail(`✗ ${err.message}`);
  process.exit(1);
});
