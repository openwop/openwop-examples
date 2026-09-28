// Tiny workflow example — the smallest possible OpenWOP v2 run lifecycle.
//
// 1. GET  /.well-known/openwop  — discover the host's capabilities
// 2. POST /runs                 — start a run of the conformance-noop workflow
// 3. Poll GET /runs/{runId} until terminal
//
// Every request carries `OpenWOP-Version: 2`. Through the v1 overlap a request
// without it on `/.well-known/openwop` is answered as v1 (versioning.md §1.3).
// v2 run ids are tenant-bound (`tenant/opaque`) and travel in a path as one
// projected segment (`tenant~2Fopaque`, identity.md §5 "Wire form").
//
// Runnable against any v2 host that seeds the `conformance-noop` fixture, such
// as the v2 reference host (`examples/hosts/v2-reference`).
//
// Configuration via env vars:
//   OPENWOP_BASE_URL  default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY   default openwop-v2-dev-key     (the v2 reference host's key)
//
// Zero external dependencies — just `fetch` from Node 20+.

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.OPENWOP_BASE_URL ?? 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY ?? 'openwop-v2-dev-key';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const V2 = { 'OpenWOP-Version': '2' };

/** identity.md §5: every byte outside [A-Za-z0-9._-] becomes ~ plus two uppercase hex digits. */
function projectId(id) {
  return [...Buffer.from(id, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

async function discover() {
  const res = await fetch(`${BASE_URL}/.well-known/openwop`, { headers: V2 });
  if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
  return { version: res.headers.get('openwop-version'), doc: await res.json() };
}

async function createRun(workflowId) {
  const res = await fetch(`${BASE_URL}/runs`, {
    method: 'POST',
    headers: {
      ...V2,
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      // A retry with the same key returns the same run instead of starting a second one (idempotency.md).
      'Idempotency-Key': `tiny-workflow-${randomUUID()}`,
    },
    body: JSON.stringify({ workflowId }),
  });
  if (res.status !== 201) throw new Error(`Run create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getRun(runId) {
  const res = await fetch(`${BASE_URL}/runs/${projectId(runId)}`, {
    headers: { ...V2, Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Snapshot failed: ${res.status}`);
  return res.json();
}

async function pollUntilTerminal(runId, { intervalMs = 250, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await getRun(runId);
    if (TERMINAL_STATUSES.has(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Run ${runId} did not terminate within ${timeoutMs}ms`);
}

async function main() {
  console.log(`→ Discovery: ${BASE_URL}/.well-known/openwop (OpenWOP-Version: 2)`);
  const { version, doc } = await discover();
  console.log(`  served as:         OpenWOP-Version ${version}`);
  console.log(`  protocolVersions:  ${(doc.protocolVersions ?? []).join(', ')}`);
  console.log(`  implementation:   ${doc.implementation?.name ?? '<unknown>'}`);
  if (!String(version ?? '').startsWith('2')) {
    console.error('✗ The host did not serve major 2. It may not implement v2 yet.');
    process.exit(1);
  }

  console.log('→ POST /runs { workflowId: "conformance-noop" }');
  const created = await createRun('conformance-noop');
  console.log(`  runId:  ${created.runId}`);
  console.log(`  status: ${created.status}`);

  console.log('→ Polling until terminal...');
  const terminal = await pollUntilTerminal(created.runId);
  console.log(`  status: ${terminal.status}`);

  if (terminal.status !== 'completed') {
    console.error(`✗ Expected completed, got ${terminal.status}`);
    process.exit(1);
  }
  console.log('✓ Run completed successfully');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
