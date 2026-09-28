// Cross-host parent-child sample — an OpenWOP parent hands a child task to an
// A2A 1.0 peer and projects the peer's task state back onto `run.status`.
//
// The peer is a real v2 host's A2A interface (the v2 reference host serves one:
// `a2a.profiles: [a2a-1.0]`, an Agent Card at `a2a.agentCardUrl`, one JSONRPC
// interface). This script plays the parent host's bridge node:
//
//   1. GET  /.well-known/openwop (OpenWOP-Version: 2) — find `a2a.agentCardUrl`
//   2. GET  the Agent Card — pick the JSONRPC interface at protocolVersion 1.0
//   3. SendMessage → the peer starts a run; its approval gate suspends the task
//      (TASK_STATE_INPUT_REQUIRED). Reply on the task with a `data` part:
//        accept → TASK_STATE_COMPLETED → run.status `completed`
//        reject → TASK_STATE_FAILED    → run.status `failed`
//   4. SendMessage + CancelTask → TASK_STATE_CANCELED → run.status `cancelled`
//   5. The projection table's remaining rows (auth-required, rejected, an
//      unknown state) and its determinism, checked as a pure function.
//
// `message.messageId` is the peer's idempotency seed (a repeat answers the task
// it already reached), so the bridge derives it from (parentRunId, nodeId,
// step): a retried send never starts a second child.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL  default http://127.0.0.1:3838  (the v2 reference host, as the A2A peer)
//   OPENWOP_API_KEY   default openwop-v2-dev-key     (the credential the peer's card asks for)
//
// @see spec/v2/core/interop.md
// @see spec/v2/interop-map.json (the `a2a.*` rows)
// @see schemas/v2/a2a-task-state.schema.json (the stored state vocabulary)

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.OPENWOP_BASE_URL || 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY || 'openwop-v2-dev-key';
const A2A_VERSION = '1.0';
const TERMINAL_WIRE = new Set(['completed', 'failed', 'canceled', 'rejected']);

/**
 * A2A 1.0 renders the stored state as `TASK_STATE_*`; the stored vocabulary is
 * lowercase-hyphen (a2a-task-state.schema.json). The bijection between them.
 */
function normalizeState(wire) {
  return wire.startsWith('TASK_STATE_') ? wire.slice('TASK_STATE_'.length).toLowerCase().replace(/_/g, '-') : wire;
}

/**
 * The reverse projection: an A2A task state (either spelling) → the parent's
 * `run.status`. `input-required` is conservative (`waiting-input`); a bridge
 * that reads the task's status message MAY choose `waiting-approval`.
 */
export function projectA2AStateToOpenWop(wireState) {
  switch (normalizeState(wireState)) {
    case 'submitted':
    case 'working':
      return { status: 'running' };
    case 'input-required':
      return { status: 'waiting-input' };
    case 'auth-required':
      return { status: 'waiting-input', reason: 'auth_required_by_remote' };
    case 'completed':
      return { status: 'completed' };
    case 'failed':
      return { status: 'failed' };
    case 'canceled':
      return { status: 'cancelled' };
    case 'rejected':
      return { status: 'failed', reason: 'rejected_by_remote' };
    default:
      return { status: 'failed', reason: 'unknown_remote_state' };
  }
}

/** Validate the Task at the boundary; a bridge never trusts unverified JSON-RPC results. */
function assertTask(x, method) {
  if (!x || typeof x !== 'object') throw new Error(`${method}: result is not an object`);
  const task = 'task' in x ? x.task : x;
  if (typeof task?.id !== 'string' || task.id.length === 0) throw new Error(`${method}: task.id missing`);
  if (typeof task?.status?.state !== 'string') throw new Error(`${method}: task.status.state missing`);
  return task;
}

function makeRpc(url) {
  let seq = 0;
  return async function rpc(method, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'A2A-Version': A2A_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
    });
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(`${method}: JSON-RPC ${body.error.code} ${body.error.message}`);
    if (!res.ok || !body?.result) throw new Error(`${method}: HTTP ${res.status}`);
    return body.result;
  };
}

/** The parent's bridge node: send, then follow the task to a settled state. */
async function sendAndSettle(rpc, message) {
  let task = assertTask(await rpc('SendMessage', { message }), 'SendMessage');
  const transitions = [task.status.state];
  for (let i = 0; i < 40 && ['submitted', 'working'].includes(normalizeState(task.status.state)); i++) {
    await new Promise((r) => setTimeout(r, 100));
    task = assertTask(await rpc('GetTask', { id: task.id }), 'GetTask');
    if (transitions.at(-1) !== task.status.state) transitions.push(task.status.state);
  }
  return { task, transitions };
}

function userMessage(parentRunId, step, parts, extra = {}) {
  return { messageId: `${parentRunId}:delegate:${step}`, role: 'ROLE_USER', parts, ...extra };
}

async function childThroughApproval(rpc, action) {
  const parentRunId = `parent-${randomUUID()}`;
  const first = await sendAndSettle(rpc, userMessage(parentRunId, 'start', [{ text: 'Research the brief and hold for sign-off.' }]));
  assert.equal(normalizeState(first.task.status.state), 'input-required', `expected the child to wait on its approval gate, got ${first.task.status.state}`);
  assert.equal(projectA2AStateToOpenWop(first.task.status.state).status, 'waiting-input');
  const reply = userMessage(parentRunId, action, [{ data: { action, decidedAt: new Date().toISOString() } }], { taskId: first.task.id, contextId: first.task.contextId });
  const second = await sendAndSettle(rpc, reply);
  // Resending the same message is idempotent: the peer answers the task it already reached.
  const again = assertTask(await rpc('SendMessage', { message: reply }), 'SendMessage');
  assert.equal(again.id, first.task.id, 'a repeated messageId must answer the same task');
  return { taskId: first.task.id, transitions: [...first.transitions, ...second.transitions], final: second.task.status.state };
}

async function main() {
  console.log(`→ Discovery: ${BASE_URL}/.well-known/openwop (OpenWOP-Version: 2)`);
  const disco = await fetch(`${BASE_URL}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  if (!disco.ok) throw new Error(`discovery failed: ${disco.status}`);
  const doc = await disco.json();
  const cardUrl = doc.a2a?.agentCardUrl;
  if (!cardUrl || !(doc.a2a.profiles ?? []).includes('a2a-1.0')) {
    console.log('⊘ An A2A 1.0 server interface is not advertised by this host (no `a2a.agentCardUrl` with profile a2a-1.0).');
    process.exit(0);
  }
  const card = await (await fetch(cardUrl)).json();
  const iface = (card.supportedInterfaces ?? []).find((i) => i.protocolBinding === 'JSONRPC' && i.protocolVersion === A2A_VERSION);
  if (!iface) {
    console.log(`⊘ The Agent Card lists no JSONRPC interface at protocolVersion ${A2A_VERSION}.`);
    process.exit(0);
  }
  console.log(`  peer: ${card.name} — skill ${card.skills?.[0]?.id ?? '<unnamed>'} at ${iface.url}`);
  const rpc = makeRpc(iface.url);

  const accepted = await childThroughApproval(rpc, 'accept');
  assert.equal(projectA2AStateToOpenWop(accepted.final).status, 'completed');
  const rejected = await childThroughApproval(rpc, 'reject');
  assert.equal(projectA2AStateToOpenWop(rejected.final).status, 'failed');

  const parentRunId = `parent-${randomUUID()}`;
  const toCancel = await sendAndSettle(rpc, userMessage(parentRunId, 'start', [{ text: 'Start, then be cancelled by the parent.' }]));
  let cancelled = assertTask(await rpc('CancelTask', { id: toCancel.task.id }), 'CancelTask');
  for (let i = 0; i < 40 && !TERMINAL_WIRE.has(normalizeState(cancelled.status.state)); i++) {
    await new Promise((r) => setTimeout(r, 100));
    cancelled = assertTask(await rpc('GetTask', { id: toCancel.task.id }), 'GetTask');
  }
  assert.equal(projectA2AStateToOpenWop(cancelled.status.state).status, 'cancelled');

  // The rows a live peer does not reach on demand, checked as a pure function.
  assert.deepEqual(projectA2AStateToOpenWop('TASK_STATE_AUTH_REQUIRED'), { status: 'waiting-input', reason: 'auth_required_by_remote' });
  assert.deepEqual(projectA2AStateToOpenWop('TASK_STATE_REJECTED'), { status: 'failed', reason: 'rejected_by_remote' });
  assert.deepEqual(projectA2AStateToOpenWop('TASK_STATE_SOMETHING_NEW'), { status: 'failed', reason: 'unknown_remote_state' });
  assert.deepEqual(projectA2AStateToOpenWop('TASK_STATE_REJECTED'), projectA2AStateToOpenWop('rejected'));

  const row = (label, t) => `  ${label.padEnd(15)} ${t.transitions.join(' → ')} ⇒ OpenWOP=${projectA2AStateToOpenWop(t.final).status}`;
  console.log('ok multi-agent-cross-host — A2A 1.0 peer state projected onto run.status end-to-end');
  console.log(row('accept:', accepted));
  console.log(row('reject:', rejected));
  console.log(`  ${'cancel:'.padEnd(15)} ${toCancel.task.status.state} → ${cancelled.status.state} ⇒ OpenWOP=${projectA2AStateToOpenWop(cancelled.status.state).status}`);
  console.log('  AUTH_REQUIRED:  ⇒ OpenWOP=waiting-input (reason=auth_required_by_remote)  [pure]');
  console.log('  REJECTED:       ⇒ OpenWOP=failed (reason=rejected_by_remote)  [pure]');
  console.log('  idempotent:     a repeated messageId answered the same task');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
