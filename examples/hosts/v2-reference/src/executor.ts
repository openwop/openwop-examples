/**
 * The run executor: an in-process loop that folds the log to find the nodes
 * still to run (so a resume, a pause/resume and a fork all re-enter the same
 * loop), executes them, and records every transition as a registered v2
 * event with a payload from the registry (events.md §Payloads).
 *
 * Node types: core.noop, core.delay, core.fail, core.approvalGate,
 * core.clarificationGate, core.interrupt, core.httpFetch. Anything else fails
 * the node (and the run) closed.
 */
import { appendEvent, ownerOf, readEvents } from './events.js';
import { buildCompensationPlan, compensationState, performHttpFetch, recordAttempt } from './effects.js';
import { err } from './errors.js';
import { mintInterrupt, payloadOf, validateResolve, type InterruptPayload } from './interrupts.js';
import { nowIso } from './ids.js';
import { TERMINAL, type Host, type Subject, type WorkflowDefinition, type WorkflowNode } from './host.js';
import type { InterruptRow, RunRow } from './store.js';

const active = new Set<string>();

class NodeFailure extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

function waitingStatusFor(kind: string): string {
  if (kind === 'external-event') return 'waiting-external';
  if (kind === 'clarification' || kind.startsWith('conversation.')) return 'waiting-input';
  return 'waiting-approval';
}

function orderNodes(def: WorkflowDefinition): WorkflowNode[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const e of def.edges) {
    const edge = e as { from?: string; to?: string; source?: string; target?: string; sourceNodeId?: string; targetNodeId?: string };
    const from = edge.from ?? edge.source ?? edge.sourceNodeId; const to = edge.to ?? edge.target ?? edge.targetNodeId;
    if (!from || !to || !byId.has(from) || !byId.has(to)) continue;
    out.set(from, [...(out.get(from) ?? []), to]);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }
  const ready = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: WorkflowNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(byId.get(id) as WorkflowNode);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if (indeg.get(next) === 0) ready.push(next);
    }
  }
  for (const n of def.nodes) if (!order.includes(n)) order.push(n);
  return order;
}

function resolveInput(node: WorkflowNode, name: string, run: RunRow, def: WorkflowDefinition): unknown {
  const binding = node.inputs[name] as { type?: string; variableName?: string; value?: unknown } | undefined;
  const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
  if (binding && typeof binding === 'object' && binding.type === 'variable' && binding.variableName) {
    if (inputs[binding.variableName] !== undefined) return inputs[binding.variableName];
    const v = def.variables.find((x) => x.name === binding.variableName);
    return v?.defaultValue;
  }
  if (binding && typeof binding === 'object' && 'value' in binding) return binding.value;
  return inputs[name] ?? node.config[name];
}

async function sleepUnlessCancelled(host: Host, runId: string, ms: number): Promise<'done' | 'cancelled' | 'paused'> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const fresh = host.store.getRun(runId);
    if (!fresh || fresh.cancel_requested === 1 || TERMINAL.has(fresh.status)) return 'cancelled';
    if (fresh.pause_requested === 1) return 'paused';
    await new Promise((r) => setTimeout(r, Math.min(50, deadline - Date.now())));
  }
  return 'done';
}

function interruptFor(node: WorkflowNode, run: RunRow): InterruptPayload {
  const key = `${run.run_id}:${node.id}:0`;
  const c = node.config;
  if (node.typeId === 'core.approvalGate') {
    const data: Record<string, unknown> = { artifactId: node.id, artifactType: 'conformance-artifact', title: String(c['title'] ?? `Approve ${node.id}`), actions: Array.isArray(c['actions']) ? c['actions'] : ['accept', 'reject'] };
    if (typeof c['description'] === 'string') data['description'] = c['description'];
    if (Array.isArray(c['approversList'])) data['approversList'] = c['approversList'];
    if (typeof c['requiredApprovals'] === 'number') data['requiredApprovals'] = c['requiredApprovals'];
    return { kind: 'approval', key, data };
  }
  if (node.typeId === 'core.clarificationGate') {
    return { kind: 'clarification', key, data: { questions: Array.isArray(c['questions']) ? c['questions'] : [{ id: 'q1', question: String(c['question'] ?? 'Please clarify') }] } };
  }
  const payload: InterruptPayload = { kind: String(c['kind'] ?? 'custom'), key, data: (c['data'] as Record<string, unknown>) ?? { customKind: node.id } };
  if (typeof c['timeoutMs'] === 'number') payload.timeoutMs = c['timeoutMs'];
  if (c['resumeSchema'] && typeof c['resumeSchema'] === 'object') payload.resumeSchema = c['resumeSchema'] as Record<string, unknown>;
  return payload;
}

type NodeResult = { outputs: Record<string, unknown> } | { suspend: InterruptPayload };

async function executeNode(host: Host, run: RunRow, def: WorkflowDefinition, node: WorkflowNode, attempt: number): Promise<NodeResult | 'cancelled' | 'paused'> {
  switch (node.typeId) {
    case 'core.noop':
      return { outputs: {} };
    case 'core.delay': {
      const ms = Math.max(0, Math.min(60_000, Number(resolveInput(node, 'delayMs', run, def) ?? 1000)));
      const r = await sleepUnlessCancelled(host, run.run_id, ms);
      return r === 'done' ? { outputs: { sleptMs: ms } } : r;
    }
    case 'core.fail':
      throw new NodeFailure('fixture_failure', String(node.config['message'] ?? 'the fixture node fails by design'));
    case 'core.approvalGate':
    case 'core.clarificationGate':
    case 'core.interrupt':
      return { suspend: interruptFor(node, run) };
    case 'core.httpFetch': {
      try {
        const r = await performHttpFetch(host, run, node, attempt);
        return { outputs: { ...r.outputs, effectId: r.effectId } };
      } catch (e) {
        const code = (e as { code?: string }).code;
        throw new NodeFailure(code === 'replay_source_missing' ? 'replay_source_missing' : 'http_fetch_failed', (e as Error).message);
      }
    }
    default:
      throw new NodeFailure('unsupported_node_type', `${node.typeId} is not executed by this host (capability not provided)`, { typeId: node.typeId });
  }
}

function fold(host: Host, run: RunRow): { started: boolean; completed: string[]; attempts: Map<string, number>; suspended: string | null; startedAt: string | null } {
  const events = readEvents(host, run);
  const completed: string[] = [];
  const attempts = new Map<string, number>();
  let started = false;
  let suspended: string | null = null;
  let startedAt: string | null = null;
  for (const e of events) {
    if (e.type === 'run.started') { started = true; startedAt = e.timestamp; }
    if (e.type === 'node.started' && e.nodeId) attempts.set(e.nodeId, (attempts.get(e.nodeId) ?? 0) + 1);
    if (e.type === 'node.completed' && e.nodeId && !completed.includes(e.nodeId)) completed.push(e.nodeId);
    if (e.type === 'node.suspended' && e.nodeId) suspended = e.nodeId;
    if (e.type === 'node.resumed' || e.type === 'node.completed' || e.type === 'node.failed') suspended = null;
  }
  return { started, completed, attempts, suspended, startedAt };
}

function setStatus(host: Host, run: RunRow, status: string, patch: Partial<RunRow> = {}): void {
  host.store.updateRun(run.run_id, { status, ...patch });
  run.status = status;
  Object.assign(run, patch);
}

function terminalCancel(host: Host, run: RunRow, reason: string, cancelledBy: string, startedAt: string | null): void {
  const durationMs = startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0;
  appendEvent(host, run, 'run.cancelled', { reason, cancelledBy, durationMs });
  host.store.invalidateInterruptsForRun(run.run_id);
  setStatus(host, run, 'cancelled', { completed_at: nowIso(), current_node_id: null, cancel_requested: 0, pause_requested: 0 });
}

/** Run the compensation plan (reverse completion) when a run fails after compensable nodes completed. */
function unwind(host: Host, run: RunRow, def: WorkflowDefinition, completed: string[]): void {
  const plan = buildCompensationPlan(def.nodes, completed);
  if (plan.length === 0) return;
  const state = compensationState(run);
  state.status = 'pending';
  state.plan = plan;
  recordAttempt(host, run, state);
  appendEvent(host, run, 'compensation.requested', { compensationId: `c-${run.run_id.split('/')[1] ?? ''}`, orderingModel: 'reverse-completion' });
  state.status = 'running';
  recordAttempt(host, run, state);
  appendEvent(host, run, 'compensation.started', { compensationId: `c-${run.run_id.split('/')[1] ?? ''}`, orderingModel: 'reverse-completion' });
  let failed = 0;
  for (const step of plan) {
    // The inverse action of every compensable fixture node is a recorded no-op.
    const outcome: 'succeeded' | 'skipped' = step.irreversibleEffect ? 'skipped' : 'succeeded';
    if (outcome === 'skipped') failed++;
    state.attempts.push(outcome === 'skipped' ? { nodeId: step.nodeId, attempt: 1, outcome, at: nowIso(), reason: 'irreversible-effect' } : { nodeId: step.nodeId, attempt: 1, outcome, at: nowIso() });
    recordAttempt(host, run, state);
  }
  state.status = failed === 0 ? 'completed' : failed === plan.length ? 'failed' : 'partial';
  recordAttempt(host, run, state);
  appendEvent(host, run, failed === 0 ? 'compensation.completed' : 'compensation.failed', failed === 0
    ? { compensationId: `c-${run.run_id.split('/')[1] ?? ''}`, orderingModel: 'reverse-completion' }
    : { compensationId: `c-${run.run_id.split('/')[1] ?? ''}`, orderingModel: 'reverse-completion', reason: 'operator-terminated' });
}

/** Enter (or re-enter) the loop for a run. Idempotent: one loop per run at a time. */
export function scheduleRun(host: Host, runId: string): void {
  if (active.has(runId)) return;
  active.add(runId);
  setImmediate(() => {
    continueRun(host, runId).catch((e: unknown) => process.stderr.write(`[executor] ${runId}: ${String((e as Error)?.stack ?? e)}\n`)).finally(() => active.delete(runId));
  });
}

export async function continueRun(host: Host, runId: string): Promise<void> {
  let run = host.store.getRun(runId);
  if (!run || TERMINAL.has(run.status) || run.status === 'paused' || run.status.startsWith('waiting-')) return;
  const def = host.workflows.get(run.workflow_id);
  const state = fold(host, run);
  if (!def) {
    appendEvent(host, run, 'run.failed', { error: { code: 'not_found', message: `workflow ${run.workflow_id} is not registered` } });
    setStatus(host, run, 'failed', { completed_at: nowIso(), error_json: JSON.stringify({ code: 'not_found', message: `workflow ${run.workflow_id} is not registered` }) });
    return;
  }
  const options = JSON.parse(run.options_json) as { tags?: string[]; metadata?: Record<string, unknown> };
  let startedAt = state.startedAt;
  if (!state.started) {
    const owner = ownerOf(host, run);
    const payload: Record<string, unknown> = { workflowId: run.workflow_id, inputs: JSON.parse(run.inputs_json), transport: 'rest', engineVersion: 1, owner };
    if (options.tags) payload['tags'] = options.tags;
    if (options.metadata) payload['metadata'] = options.metadata;
    const doc = appendEvent(host, run, 'run.started', payload);
    startedAt = doc.timestamp;
    setStatus(host, run, 'running', { started_at: doc.timestamp });
  } else if (run.status === 'pending') {
    setStatus(host, run, 'running');
  }
  const completed = [...state.completed];
  for (const node of orderNodes(def)) {
    if (completed.includes(node.id)) continue;
    run = host.store.getRun(runId) as RunRow;
    if (run.cancel_requested === 1) { terminalCancel(host, run, 'caller-requested', 'caller', startedAt); return; }
    if (run.pause_requested === 1) {
      appendEvent(host, run, 'run.paused', { reason: 'operator', drainPolicy: 'drain' });
      setStatus(host, run, 'paused', { pause_requested: 0 });
      return;
    }
    const attempt = state.attempts.get(node.id) ?? 0;
    state.attempts.set(node.id, attempt + 1);
    const nodeStart = Date.now();
    appendEvent(host, run, 'node.started', { nodeId: node.id, typeId: node.typeId, attempt }, { nodeId: node.id });
    let result: NodeResult | 'cancelled' | 'paused';
    try {
      result = await executeNode(host, run, def, node, attempt);
    } catch (e) {
      const failure = e instanceof NodeFailure ? e : new NodeFailure('internal_error', (e as Error).message);
      const error: Record<string, unknown> = { code: failure.code, message: failure.message };
      if (failure.details) error['details'] = failure.details;
      appendEvent(host, run, 'node.failed', { nodeId: node.id, error, attempts: attempt + 1 }, { nodeId: node.id });
      run = host.store.getRun(runId) as RunRow;
      unwind(host, run, def, completed);
      appendEvent(host, run, 'run.failed', { error, failedNodeId: node.id, durationMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0 });
      host.store.invalidateInterruptsForRun(run.run_id);
      setStatus(host, run, 'failed', { completed_at: nowIso(), current_node_id: null, error_json: JSON.stringify(error) });
      return;
    }
    if (result === 'cancelled') { run = host.store.getRun(runId) as RunRow; appendEvent(host, run, 'node.cancelled', { nodeId: node.id, reason: 'run-cancelled' }, { nodeId: node.id }); terminalCancel(host, run, 'caller-requested', 'caller', startedAt); return; }
    if (result === 'paused') {
      run = host.store.getRun(runId) as RunRow;
      appendEvent(host, run, 'run.paused', { reason: 'operator', drainPolicy: 'interrupt' });
      setStatus(host, run, 'paused', { pause_requested: 0 });
      return;
    }
    if ('suspend' in result) {
      const { row } = mintInterrupt(host, run, node.id, result.suspend);
      host.validate('suspend-request', result.suspend, `interrupt ${row.interrupt_id}`);
      appendEvent(host, run, 'interrupt.requested', result.suspend, { nodeId: node.id });
      appendEvent(host, run, 'node.suspended', { nodeId: node.id, interruptId: row.interrupt_id, kind: result.suspend.kind, key: result.suspend.key }, { nodeId: node.id });
      setStatus(host, run, waitingStatusFor(result.suspend.kind), { current_node_id: node.id });
      return;
    }
    appendEvent(host, run, 'node.completed', { nodeId: node.id, outputs: result.outputs, durationMs: Date.now() - nodeStart }, { nodeId: node.id });
    completed.push(node.id);
  }
  run = host.store.getRun(runId) as RunRow;
  if (run.cancel_requested === 1) { terminalCancel(host, run, 'caller-requested', 'caller', startedAt); return; }
  appendEvent(host, run, 'run.completed', { outputs: {}, durationMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0 });
  host.store.invalidateInterruptsForRun(run.run_id);
  setStatus(host, run, 'completed', { completed_at: nowIso(), current_node_id: null });
}

/** runs.md §Cancel — accepted immediately; the cascade completes in the loop when a node is executing. */
export function requestCancel(host: Host, run: RunRow, reason: string | undefined): { status: string } {
  if (TERMINAL.has(run.status)) return { status: run.status };
  const state = fold(host, run);
  if (run.status === 'pending' || run.status === 'paused' || run.status.startsWith('waiting-') || !active.has(run.run_id)) {
    if (state.suspended !== null) appendEvent(host, run, 'node.cancelled', { nodeId: state.suspended, reason: 'run-cancelled' }, { nodeId: state.suspended });
    terminalCancel(host, run, reason ?? 'caller-requested', 'caller', state.startedAt);
    return { status: 'cancelled' };
  }
  setStatus(host, run, 'cancelling', { cancel_requested: 1 });
  return { status: 'cancelling' };
}

export function requestPause(host: Host, run: RunRow, reason: string | undefined, drainPolicy: string): { pausedAt?: string } {
  if (run.status !== 'running' && run.status !== 'pending') throw err('run_terminal', `a run in status ${run.status} cannot be paused`);
  if (!active.has(run.run_id) || run.status === 'pending') {
    appendEvent(host, run, 'run.paused', { reason: reason ?? 'operator', drainPolicy: drainPolicy === 'immediate' ? 'interrupt' : 'drain' });
    setStatus(host, run, 'paused');
    return { pausedAt: nowIso() };
  }
  host.store.updateRun(run.run_id, { pause_requested: 1 });
  return {};
}

export function requestResume(host: Host, run: RunRow, reason: string | undefined): { resumedAt: string } {
  appendEvent(host, run, 'run.resumed', reason === undefined ? {} : { reason });
  setStatus(host, run, 'running');
  scheduleRun(host, run.run_id);
  return { resumedAt: nowIso() };
}

/** Both resolve surfaces converge here: validate, claim atomically, record, resume. */
export function resolveAndResume(host: Host, run: RunRow, row: InterruptRow, resumeValue: unknown, subject: Subject | null): { runId: string; nodeId: string; status: string } {
  const outcome = validateResolve(host, run, row, resumeValue, subject);
  if (!outcome.exitsSuspend) return { runId: run.run_id, nodeId: row.node_id, status: run.status };
  if (!host.store.resolveInterrupt(row.interrupt_id, JSON.stringify(resumeValue ?? null))) throw err('interrupt_already_resolved', 'a concurrent resolve won');
  const payload = payloadOf(row);
  const resolved: Record<string, unknown> = { nodeId: row.node_id, interruptId: row.interrupt_id, kind: payload.kind, resumeValue };
  if (subject !== null) resolved['resolvedBy'] = subject;
  if (outcome.decision !== undefined) resolved['decision'] = outcome.decision;
  appendEvent(host, run, 'interrupt.resolved', resolved, { nodeId: row.node_id });
  if (outcome.decision === 'rejected') {
    const error = { code: 'approval_rejected', message: 'the approval was rejected' };
    appendEvent(host, run, 'node.failed', { nodeId: row.node_id, error, attempts: 1 }, { nodeId: row.node_id });
    appendEvent(host, run, 'run.failed', { error, failedNodeId: row.node_id });
    host.store.invalidateInterruptsForRun(run.run_id);
    setStatus(host, run, 'failed', { completed_at: nowIso(), current_node_id: null, error_json: JSON.stringify(error) });
    return { runId: run.run_id, nodeId: row.node_id, status: 'failed' };
  }
  appendEvent(host, run, 'node.resumed', { nodeId: row.node_id, interruptId: row.interrupt_id, resumeValue }, { nodeId: row.node_id });
  appendEvent(host, run, 'node.completed', { nodeId: row.node_id, outputs: { resumeValue } }, { nodeId: row.node_id });
  setStatus(host, run, 'running', { current_node_id: null });
  scheduleRun(host, run.run_id);
  return { runId: run.run_id, nodeId: row.node_id, status: 'running' };
}

/** persistence.md §Runs pinned to v1 — applied at first v2 read of a non-terminal era-2 run. */
export function applyPinDisposition(host: Host, run: RunRow): RunRow {
  if (run.pin_checked === 1 || (run.era ?? 2) >= 3 || TERMINAL.has(run.status)) return run;
  const events = readEvents(host, run);
  const pins = events.filter((e) => e.type === 'version.pinned').map((e) => String((e.payload as { changeId?: unknown } | null)?.changeId ?? ''));
  const unsupported = pins.filter((id) => !host.config.implementedChangeIds.has(id));
  host.store.updateRun(run.run_id, { pin_checked: 1 });
  run.pin_checked = 1;
  if (unsupported.length > 0) {
    appendEvent(host, run, 'run.cancelled', { reason: 'v1_pin_unsupported', cancelledBy: 'v2-cutover' });
    host.store.invalidateInterruptsForRun(run.run_id);
    setStatus(host, run, 'cancelled', { completed_at: nowIso(), current_node_id: null });
  }
  return run;
}

export function isActive(runId: string): boolean {
  return active.has(runId);
}
