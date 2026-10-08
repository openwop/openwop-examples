/**
 * The run executor: an in-process loop that folds the log to find the nodes
 * still to run (so a resume, a pause/resume and a fork all re-enter the same
 * loop), executes them, and records every transition as a registered v2
 * event with a payload from the registry (events.md §Payloads).
 *
 * Node types: core.noop, core.delay, core.conformance.hold (pure), core.fail, core.approvalGate,
 * core.clarificationGate, core.interrupt, core.httpFetch, core.conversationGate
 * (the conformance mock), conformance.artifact.emit (RFC 0205), and (RFC 0204,
 * when `mcp.client` is advertised) core.conformance.mcp-client. Anything else fails
 * the node (and the run) closed.
 */
import { appendEvent, ownerOf, readEvents } from './events.js';
import { buildCompensationPlan, compensationState, performConformanceSideEffect, performHttpFetch, recordAttempt } from './effects.js';
import { SafeFetchRejection, safeFetch } from './safe-fetch.js';
import { BudgetExhausted, afterToolCall, beforeToolCall, reserveBudget } from './budget.js';
import { HostError, err } from './errors.js';
import { mintInterrupt, payloadOf, tallyVote, validateResolve, type InterruptPayload } from './interrupts.js';
import { nowIso } from './ids.js';
import { McpClientError, createCtxMcp } from './mcp-client.js';
import { ARTIFACT_EMIT_TYPE, artifactIdFor, corpusHasParts } from './run-artifacts.js';
import { NONDETERMINISM_TYPE, runNondeterminism } from './nondeterminism.js';
import { relay } from './purpose.js';
import { conversationIdFor, councilSupported, isCouncilGate, rosterOf } from './council.js';
import { TERMINAL, type Host, type Subject, type WorkflowDefinition, type WorkflowNode } from './host.js';
import type { InterruptRow, RunRow } from './store.js';
import { CREDENTIAL_RESUME_SCHEMA, OAUTH_USE_TYPE, acquireForNode, connectUrlFor, credentialInterruptAdvertised, oauthSupported, provider as oauthProvider, setGrantCompletedHandler } from './oauth.js';

const active = new Set<string>();

class NodeFailure extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

function waitingStatusFor(kind: string): string {
  if (kind === 'external-event') return 'waiting-external';
  if (kind === 'clarification' || kind === 'credential' || kind.startsWith('conversation.')) return 'waiting-input';
  return 'waiting-approval';
}

interface Link { from: string; to: string; triggerRule: string }

/** The definition's edges between known nodes, whichever spelling they use; `triggerRule` defaults to `all_success`. */
function links(def: WorkflowDefinition): Link[] {
  const ids = new Set(def.nodes.map((n) => n.id));
  const out: Link[] = [];
  for (const e of def.edges) {
    const edge = e as { from?: string; to?: string; source?: string; target?: string; sourceNodeId?: string; targetNodeId?: string; triggerRule?: unknown };
    const from = edge.from ?? edge.source ?? edge.sourceNodeId; const to = edge.to ?? edge.target ?? edge.targetNodeId;
    if (!from || !to || !ids.has(from) || !ids.has(to)) continue;
    out.push({ from, to, triggerRule: typeof edge.triggerRule === 'string' ? edge.triggerRule : 'all_success' });
  }
  return out;
}

/** The two `triggerRule` values a failed source can satisfy (interrupt.md §Rejection). */
const ADMITS_FAILED = new Set(['all_complete', 'any_failed']);

/** A failure the definition routes: the node has an outgoing edge that admits a failed source. */
function failureRouted(def: WorkflowDefinition, nodeId: string): boolean {
  return links(def).some((l) => l.from === nodeId && ADMITS_FAILED.has(l.triggerRule));
}

/**
 * Whether a node fires, from the states of its incoming edges' sources (the
 * scheduler reads `triggerRule` from the target's incoming edges, RFC 0125). A
 * node with no incoming edge always fires. One rule governs a target; if its
 * incoming edges disagree, the first edge's rule does.
 */
function fires(def: WorkflowDefinition, nodeId: string, state: { completed: string[]; failed: string[]; skipped: string[] }): { fires: boolean; rule: string } {
  const incoming = links(def).filter((l) => l.to === nodeId);
  if (incoming.length === 0) return { fires: true, rule: 'none' };
  const rule = (incoming[0] as Link).triggerRule;
  const ok = incoming.filter((l) => state.completed.includes(l.from)).length;
  const bad = incoming.filter((l) => state.failed.includes(l.from)).length;
  const done = incoming.filter((l) => state.completed.includes(l.from) || state.failed.includes(l.from) || state.skipped.includes(l.from)).length;
  const verdict = rule === 'any_success' ? ok > 0
    : rule === 'all_complete' ? done === incoming.length
    : rule === 'none_failed' ? bad === 0 && done === incoming.length
    : rule === 'any_failed' ? bad > 0
    : ok === incoming.length; // all_success
  return { fires: verdict, rule };
}

function orderNodes(def: WorkflowDefinition): WorkflowNode[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>();
  for (const { from, to } of links(def)) {
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

/**
 * Whether a source's outcome travels over a BACK edge (one that closes a cycle,
 * pointing at a node earlier in the order): only an outcome that satisfies the
 * edge's own triggerRule re-opens its target. A skip never does, so a skipped
 * loop body cannot re-open its gate and spin.
 */
function delivers(rule: string, type: string): boolean {
  if (rule === 'any_failed') return type === 'node.failed';
  if (rule === 'all_complete') return type === 'node.completed' || type === 'node.failed';
  return type === 'node.completed'; // all_success, any_success, none_failed
}

/**
 * The scheduler, derived from the log so a re-entered loop (resume, restart,
 * fork) picks up exactly where the run is. A node is OWED an evaluation when it
 * has no terminal yet, when it started and recorded no terminal, or when a
 * source finished after the node's last terminal: over a forward edge always,
 * over a back edge only when that edge delivers. The next node is the first owed
 * one, in order, whose forward-edge sources owe nothing — in a DAG that is the
 * old single pass, and a cycle re-opens its target each time the loop comes round.
 */
function nextNode(def: WorkflowDefinition, order: WorkflowNode[], st: Folded): WorkflowNode | null {
  const idx = new Map(order.map((n, i) => [n.id, i] as const));
  const ls = links(def);
  const owed = (id: string): boolean => {
    const t = st.outcome.get(id);
    if (t === undefined) return true;
    if ((st.lastStart.get(id) ?? -1) > t.seq) return true;
    return ls.some((l) => {
      if (l.to !== id) return false;
      const s = st.outcome.get(l.from);
      if (s === undefined || s.seq <= t.seq) return false;
      const back = (idx.get(l.from) ?? 0) >= (idx.get(id) ?? 0);
      return !back || delivers(l.triggerRule, s.type);
    });
  };
  for (const n of order) {
    if (!owed(n.id)) continue;
    const forward = ls.filter((l) => l.to === n.id && (idx.get(l.from) ?? 0) < (idx.get(n.id) ?? 0));
    if (forward.every((l) => !owed(l.from))) return n;
  }
  return null;
}

/** Each node's latest outcome, as the three lists `fires` reads. */
function latestOutcomes(st: Folded): { completed: string[]; failed: string[]; skipped: string[] } {
  const out = { completed: [] as string[], failed: [] as string[], skipped: [] as string[] };
  for (const [id, t] of st.outcome) (t.type === 'node.completed' ? out.completed : t.type === 'node.failed' ? out.failed : out.skipped).push(id);
  return out;
}

/** runs.md §`run` section: recursionLimit, clamped to limits.maxNodeExecutions (the default when absent). */
export const MAX_NODE_EXECUTIONS = 1000;
function recursionLimit(run: RunRow): number {
  const options = JSON.parse(run.options_json) as { configurable?: { run?: { recursionLimit?: unknown } } };
  const asked = options.configurable?.run?.recursionLimit;
  return typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_NODE_EXECUTIONS) : MAX_NODE_EXECUTIONS;
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
    // runs.md §Pause and resume: only `immediate` cuts the running attempt;
    // `drain-current-node` lets this node reach its terminal and the loop
    // pauses between nodes.
    if (fresh.pause_requested === 1 && pausePolicy.get(runId) === 'immediate') return 'paused';
    await new Promise((r) => setTimeout(r, Math.min(50, deadline - Date.now())));
  }
  return 'done';
}

/**
 * The run whose id roots the deterministic re-entry key K. replay.md §Suppression
 * keys a replay fork on `(sourceRunId, nodeId, attempt)`, never on the fork's own
 * runId — so a replay fork's K is its source's K (followed up a chain of replays),
 * and the source's recorded `interrupt.resolved` is the one it short-circuits to.
 * A branch is an independent run and keys on itself.
 */
function keyRunId(host: Host, run: RunRow): string {
  let r = run;
  while (r.fork_mode === 'replay' && r.source_run_id !== null) {
    const source = host.store.getRun(r.source_run_id);
    if (!source) break;
    r = source;
  }
  return r.run_id;
}

/**
 * replay.md §"Determinism caveats" 2 — `ctx.interrupt(K)` short-circuits to the
 * persisted `interrupt.resolved`. The log is consulted (interrupt.md §"Re-entry
 * and resume values"): the run's own, then each replay source's, since a replay
 * consumes its source's events as fixed history. Returns the recorded
 * `node.suspended` (which names the interrupt K was invoked as) and its
 * `interrupt.resolved`, or null when K was never resolved.
 */
function recordedResolution(host: Host, run: RunRow, key: string): { suspended: Record<string, unknown>; resolved: Record<string, unknown> } | null {
  for (let r: RunRow | undefined = run; r !== undefined; r = r.fork_mode === 'replay' && r.source_run_id !== null ? host.store.getRun(r.source_run_id) : undefined) {
    const events = readEvents(host, r);
    const suspended = events.find((e) => e.type === 'node.suspended' && (e.payload as { key?: unknown } | null)?.key === key);
    if (suspended === undefined) continue;
    const interruptId = (suspended.payload as { interruptId?: unknown }).interruptId;
    const resolved = events.find((e) => e.type === 'interrupt.resolved' && (e.payload as { interruptId?: unknown } | null)?.interruptId === interruptId);
    if (resolved !== undefined) return { suspended: suspended.payload as Record<string, unknown>, resolved: resolved.payload as Record<string, unknown> };
  }
  return null;
}

/**
 * interrupt.md §Re-entry and resume values: K derives from the run, the node and
 * the node's VISIT INDEX (its interrupts whose resolution was consumed before this
 * execution). A replay or recovery of the same execution re-derives the same K; a
 * later visit over an edge derives a different one and asks again.
 */
function interruptFor(host: Host, node: WorkflowNode, run: RunRow, visit: number): InterruptPayload {
  const key = `${keyRunId(host, run)}:${node.id}:${visit}`;
  const c = node.config;
  if (node.typeId === 'core.approvalGate') {
    const data: Record<string, unknown> = { artifactId: node.id, artifactType: 'conformance-artifact', title: String(c['title'] ?? `Approve ${node.id}`), actions: Array.isArray(c['actions']) ? c['actions'] : ['accept', 'reject'] };
    if (typeof c['description'] === 'string') data['description'] = c['description'];
    if (Array.isArray(c['approversList'])) data['approversList'] = c['approversList'];
    if (typeof c['requiredApprovals'] === 'number') data['requiredApprovals'] = c['requiredApprovals'];
    if (c['rejectionPolicy'] === 'single-veto' || c['rejectionPolicy'] === 'majority') data['rejectionPolicy'] = c['rejectionPolicy'];
    if (typeof c['onTimeout'] === 'string') data['onTimeout'] = c['onTimeout'];
    const payload: InterruptPayload = { kind: 'approval', key, data };
    // interrupt.md §Rejection: a non-zero timeoutMs is the gate's deadline (sweepApprovalTimeouts).
    if (typeof c['timeoutMs'] === 'number' && c['timeoutMs'] > 0) payload.timeoutMs = c['timeoutMs'];
    return payload;
  }
  if (node.typeId === 'core.clarificationGate') {
    return { kind: 'clarification', key, data: { questions: Array.isArray(c['questions']) ? c['questions'] : [{ id: 'q1', question: String(c['question'] ?? 'Please clarify') }] } };
  }
  const payload: InterruptPayload = { kind: String(c['kind'] ?? 'custom'), key, data: (c['data'] as Record<string, unknown>) ?? { customKind: node.id } };
  if (typeof c['timeoutMs'] === 'number') payload.timeoutMs = c['timeoutMs'];
  if (c['resumeSchema'] && typeof c['resumeSchema'] === 'object') payload.resumeSchema = c['resumeSchema'] as Record<string, unknown>;
  return payload;
}

/**
 * `core.conversationGate` with `lifecycle: open-exchange-close` and `mockAutoResume`
 * (fixture conformance-conversation-lifecycle): open, one exchange whose agent turn the
 * host's conformance mock supplies, close — `conversation.opened` → `.exchanged` →
 * `.closed` under one conversationId. RFC 0205 §B: the turn carries `parts` (one `text`
 * Part, with `content` the same text so a pre-0205 reader still renders it) only when the
 * installed contract declares the property on the closed v2 turn def.
 */
function runConversation(host: Host, run: RunRow, node: WorkflowNode): Record<string, unknown> {
  const c = node.config;
  if (c['lifecycle'] !== 'open-exchange-close' || c['mockAutoResume'] !== true) {
    throw new NodeFailure('node_config_invalid', 'core.conversationGate is executed only as open-exchange-close with mockAutoResume (the conformance mock)', { typeId: node.typeId });
  }
  const conversationId = `${run.run_id.split('/')[1] ?? run.run_id}:${node.id}`;
  appendEvent(host, run, 'conversation.opened', { conversationId }, { nodeId: node.id });
  const text = 'Conformance mock reply.';
  const turn: Record<string, unknown> = { messageId: `${conversationId}:1:agent`, from: 'host:conformance-mock', content: text, ts: Date.now(), role: 'agent', turnIndex: 1, speakerId: 'host:conformance-mock' };
  if (corpusHasParts(host)) turn['parts'] = [{ text }];
  appendEvent(host, run, 'conversation.exchanged', { conversationId, turnIndex: 1, turn }, { nodeId: node.id });
  appendEvent(host, run, 'conversation.closed', { conversationId, reason: 'goal-reached', turnCount: 1 }, { nodeId: node.id });
  return { conversationId, turnCount: 1 };
}

type NodeResult = { outputs: Record<string, unknown> } | { suspend: InterruptPayload };

/**
 * events.md §run.completed — a completed run's `outputs`: the latest outputs of each sink
 * node (one with no outgoing edge), merged in definition order. A workflow whose sinks
 * produce nothing completes with `{}`.
 */
function runOutputs(host: Host, run: RunRow, def: WorkflowDefinition): Record<string, unknown> {
  const sources = new Set(links(def).map((l) => l.from));
  const latest = new Map<string, Record<string, unknown>>();
  for (const e of readEvents(host, run)) {
    if (e.type !== 'node.completed') continue;
    const p = e.payload as { nodeId?: unknown; outputs?: unknown };
    if (typeof p.nodeId === 'string' && p.outputs !== null && typeof p.outputs === 'object') latest.set(p.nodeId, p.outputs as Record<string, unknown>);
  }
  const out: Record<string, unknown> = {};
  for (const n of def.nodes) if (!sources.has(n.id)) Object.assign(out, latest.get(n.id) ?? {});
  return out;
}

/**
 * conversation.md §multiPartyConversation (RFC 0239, council.ts): a council gate
 * opens its conversation with the configured roster and waits on one
 * `conversation.exchange` turn the caller supplies. The turn is checked against
 * the roster at resolve (interrupts.ts) and recorded by applyResolution.
 */
function openCouncil(host: Host, run: RunRow, node: WorkflowNode, visit: number): NodeResult {
  const conversationId = conversationIdFor(run, node.id);
  appendEvent(host, run, 'conversation.opened', { conversationId, participants: rosterOf(node).map((agentId) => ({ agentId })) }, { nodeId: node.id });
  return {
    suspend: {
      kind: 'conversation.exchange',
      key: `${keyRunId(host, run)}:${node.id}:${visit}`,
      data: { conversationId, prompt: String(node.config['prompt'] ?? 'The council takes its turn.'), turnIndex: 0 },
      resumeSchema: { type: 'object', required: ['speakerId', 'content'], properties: { role: { type: 'string' }, speakerId: { type: 'string' }, content: { type: 'string' } } },
    },
  };
}

/**
 * RFC 0199 / oauth.md — a node declaring `auth { type: oauth2, provider, scopes }`
 * (fixture conformance-credential). The host resolves the credential host-side
 * (refreshing it through the provider's token endpoint); the node sees a
 * credential REFERENCE only. When none resolves: under `oauth.credentialInterrupt`
 * the node suspends on a `credential` interrupt; otherwise RFC 0047 §C.3 —
 * `connector_auth_expired` after a terminal refresh failure, `credential_required`
 * when there never was one.
 */
async function useCredential(host: Host, run: RunRow, node: WorkflowNode, visit: number): Promise<NodeResult> {
  const auth = (node.config['auth'] ?? {}) as { type?: unknown; provider?: unknown; scopes?: unknown };
  const providerId = typeof auth.provider === 'string' ? auth.provider : '';
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.map(String) : [];
  if (!oauthSupported(host) || auth.type !== 'oauth2' || oauthProvider(host, providerId) === undefined) {
    throw new NodeFailure('oauth_provider_unsupported', `provider ${providerId} is not in oauth.providers`, { provider: providerId });
  }
  const got = await acquireForNode(host, run, providerId, scopes, node.id);
  if (got.ok) return { outputs: { provider: providerId, credentialRef: got.credentialRef } };
  if (!credentialInterruptAdvertised(host)) {
    if (got.reason === 'expired') throw new NodeFailure('connector_auth_expired', `the ${providerId} credential's refresh failed terminally`, { provider: providerId });
    throw new NodeFailure('credential_required', `no ${providerId} credential with scopes [${scopes.join(', ')}] resolves for the run's Subject`, { provider: providerId });
  }
  const data: Record<string, unknown> = { provider: providerId, scopes, reason: got.reason, connectUrl: connectUrlFor(host, run, node.id, providerId, scopes) };
  if (got.credentialRef !== undefined) data['credentialRef'] = { ref: got.credentialRef, scope: 'user' };
  return { suspend: { kind: 'credential', key: `${keyRunId(host, run)}:${node.id}:${visit}`, data, resumeSchema: { ...CREDENTIAL_RESUME_SCHEMA } as unknown as Record<string, unknown> } };
}

async function executeNode(host: Host, run: RunRow, def: WorkflowDefinition, node: WorkflowNode, attempt: number, execution: number, visit: number): Promise<NodeResult | 'cancelled' | 'paused'> {
  switch (node.typeId) {
    case 'core.noop':
      return { outputs: {} };
    case 'core.delay': {
      const ms = Math.max(0, Math.min(60_000, Number(resolveInput(node, 'delayMs', run, def) ?? 1000)));
      const r = await sleepUnlessCancelled(host, run.run_id, ms);
      return r === 'done' ? { outputs: { sleptMs: ms } } : r;
    }
    case NONDETERMINISM_TYPE: {
      // replay.md §Declared nondeterminism (RFC 0237): draw each listed source, or replay the recorded draw.
      const out = runNondeterminism(host, run, node, execution);
      if ('missing' in out) throw new NodeFailure('replay_source_missing', `the replay source recorded no draw for ${node.id} execution ${execution}`);
      return { outputs: out };
    }
    case 'core.conformance.a2a-invoke': {
      // fixtures.md §conformance-purpose-relay: forward the inbound A2A message, re-emitting its label
      // (security-defaults.md §Onward hops). A replay fork never re-sends it.
      if (node.config?.['forward'] !== 'inbound-message') throw new NodeFailure('node_config_invalid', 'this host runs core.conformance.a2a-invoke only with config.forward: "inbound-message"');
      if (run.fork_mode === 'replay') return { outputs: { relayed: 0, suppressed: true } };
      try {
        return { outputs: await relay(host, run) };
      } catch (e) {
        if (e instanceof HostError) throw new NodeFailure(e.code, e.message, e.details);
        throw e;
      }
    }
    case 'core.conformance.side-effect':
      // Side-effecting by classification: suppressed in a replay (effects.ts).
      try {
        const r = performConformanceSideEffect(host, run, node, execution);
        return { outputs: { ...r.outputs, effectId: r.effectId } };
      } catch (e) {
        const code = (e as { code?: string }).code;
        throw new NodeFailure(code === 'replay_source_missing' ? 'replay_source_missing' : 'internal_error', (e as Error).message);
      }
    case 'core.conformance.hold': {
      // A reserved, PURE conformance node: it holds for inputs.delayMs, then completes
      // with its resolved inputs as its outputs. It performs nothing observable outside
      // the run's log, is never side-effecting, and so re-executes live on replay (no
      // suppression, no recorded outcome to resolve).
      const inputs = Object.fromEntries(Object.keys(node.inputs).map((name) => [name, resolveInput(node, name, run, def)]));
      const ms = Math.max(0, Math.min(60_000, Number(resolveInput(node, 'delayMs', run, def) ?? 0) || 0));
      const r = await sleepUnlessCancelled(host, run.run_id, ms);
      return r === 'done' ? { outputs: inputs } : r;
    }
    case 'core.conformance.mock-agent': {
      // A reserved conformance node (fixtures.md §conformance-budget-tool-calls): it
      // makes the scripted tool calls and nothing else. Each call is charged to the
      // run's budget before it is recorded (budget.ts), so the call that does not fit
      // is never made.
      const agentId = String(node.agent?.agentId ?? `core.conformance.${node.id}`);
      const calls = Array.isArray(node.config['mockToolCalls']) ? (node.config['mockToolCalls'] as Array<Record<string, unknown>>) : [];
      for (const [i, call] of calls.entries()) {
        try { beforeToolCall(host, run, node.id); }
        catch (e) {
          if (e instanceof BudgetExhausted) throw new NodeFailure('budget_exhausted', e.message, { dimension: 'toolCalls', limit: e.limit });
          throw e;
        }
        const toolName = String(call['toolId'] ?? 'unnamed');
        const callId = `${node.id}.${execution}.${i + 1}`;
        appendEvent(host, run, 'agent.tool-called', { agentId, toolName, callId, inputs: call['arguments'] ?? {} }, { nodeId: node.id });
        afterToolCall(host, run, node.id);
        appendEvent(host, run, 'agent.tool-returned', { agentId, toolName, callId, outcome: call['result'] ?? null, durationMs: Number.isInteger(call['durationMs']) ? (call['durationMs'] as number) : 0 }, { nodeId: node.id });
      }
      const decision = node.config['mockDecision'] as { decision?: unknown; confidence?: unknown } | undefined;
      if (decision !== undefined && decision !== null && typeof decision === 'object') {
        appendEvent(host, run, 'agent.decided', { agentId, decision: decision.decision ?? null, ...(typeof decision.confidence === 'number' ? { confidence: decision.confidence } : {}) }, { nodeId: node.id });
      }
      return { outputs: { toolCalls: calls.length } };
    }
    case 'core.conformance.safefetch-probe': {
      // A reserved conformance node (fixtures.md §"The safeFetch probe fixture"): it calls this
      // host's own safeFetch with the run's `url`, unchanged, and outputs the status only. A
      // rejection fails the node with its code and details as given.
      const target = String(resolveInput(node, 'url', run, def) ?? '');
      try {
        const r = await safeFetch(target);
        return { outputs: { result: { status: r.status } } };
      } catch (e) {
        if (e instanceof SafeFetchRejection) throw new NodeFailure(e.code, e.message, e.details);
        throw e;
      }
    }
    case 'core.fail':
      // fixtures.md §core.fail: a vendor code under the registered `example` org (errors.md §The registry, openwop#1698).
      throw new NodeFailure('example.conformance_failure', String(node.config['message'] ?? 'Intentional conformance failure'));
    case 'core.approvalGate':
    case 'core.clarificationGate':
    case 'core.interrupt':
      return { suspend: interruptFor(host, node, run, visit) };
    case 'core.httpFetch': {
      try {
        const r = await performHttpFetch(host, run, node, execution);
        return { outputs: { ...r.outputs, effectId: r.effectId } };
      } catch (e) {
        const code = (e as { code?: string }).code;
        // No registered row for a failed fetch: a vendor code under the registered `example` org (openwop#1698).
        // RFC 0228: egress_denied (the host's guard refused it) or upstream_unavailable (no answer from the target).
        throw new NodeFailure(code === 'replay_source_missing' || code === 'egress_denied' || code === 'upstream_unavailable' ? code : 'upstream_unavailable', (e as Error).message);
      }
    }
    case 'core.conformance.mcp-client': {
      // RFC 0204 fixture node (conformance/fixtures.md §"The ctx.mcp fixture"):
      // call this host's own ctx.mcp with the run's inputs and record the
      // resolved value VERBATIM as outputs.result; a rejection fails the node
      // with the rejection's code. Nothing between the call and the output.
      const mcp = createCtxMcp(host, run);
      const method = String(resolveInput(node, 'method', run, def) ?? '');
      const serverId = resolveInput(node, 'serverId', run, def) as string;
      try {
        let result: unknown;
        if (method === 'callTool') {
          const args = resolveInput(node, 'arguments', run, def);
          result = await mcp.callTool({ serverId, name: String(resolveInput(node, 'name', run, def) ?? ''), ...(args && typeof args === 'object' ? { arguments: args as Record<string, unknown> } : {}), idempotencyKey: `${run.run_id}:${node.id}:${attempt}` });
        } else if (method === 'listTools') {
          const cursor = resolveInput(node, 'cursor', run, def);
          result = await mcp.listTools({ serverId, ...(typeof cursor === 'string' ? { cursor } : {}) });
        } else if (method === 'readResource') {
          result = await mcp.readResource({ serverId, uri: String(resolveInput(node, 'uri', run, def) ?? '') });
        } else if (method === 'serverHealth') {
          result = await mcp.serverHealth({ serverId });
        } else {
          throw new NodeFailure('node_config_invalid', `unknown ctx.mcp method ${JSON.stringify(method)}`);
        }
        return { outputs: { result } };
      } catch (e) {
        if (e instanceof McpClientError) throw new NodeFailure(e.code, e.message, e.details);
        throw e;
      }
    }
    case ARTIFACT_EMIT_TYPE: {
      // RFC 0205 (fixture conformance-artifact-emit): one artifact, announced by
      // artifact.created and readable through getArtifact (run-artifacts.ts), which
      // resolves it from this event and the node's config — nothing is stored twice.
      const artifactId = artifactIdFor(node.id);
      const payload: Record<string, unknown> = { artifactId, artifactType: String(node.config['artifactType'] ?? 'conformance.artifact.brief'), nodeId: node.id, registered: false };
      if (typeof node.config['summary'] === 'string') payload['summary'] = node.config['summary'];
      appendEvent(host, run, 'artifact.created', payload, { nodeId: node.id });
      return { outputs: { artifactId } };
    }
    case 'core.conversationGate':
      if (isCouncilGate(node) && councilSupported(host)) return openCouncil(host, run, node, visit);
      return { outputs: runConversation(host, run, node) };
    case OAUTH_USE_TYPE:
      return useCredential(host, run, node, visit);
    default:
      throw new NodeFailure('capability_not_provided', `${node.typeId} is not executed by this host (capability not provided)`, { typeId: node.typeId });
  }
}

interface Folded {
  started: boolean;
  completed: string[];
  attempts: Map<string, number>;
  /**
   * replay.md §Suppression rule 2 (Class 3 on openwop#1718): a node's execution
   * ordinal is 1 + its `node.completed` + `node.failed` events before this
   * execution — terminals, not `node.started`, which an immediate pause, a
   * restart or a fork cut inside an attempt re-emits for the SAME execution.
   */
  terminals: Map<string, number>;
  suspended: string | null;
  /** K of an `interrupt.requested` the node's current attempt recorded and nothing has resolved yet. */
  requested: Map<string, string>;
  /** `interrupt.resolved` recorded and the node not yet resumed — a fork cut between the two. */
  resolved: Map<string, Record<string, unknown>>;
  /** `node.resumed` recorded and the node not yet completed, with its resumeValue. */
  resumed: Map<string, unknown>;
  /** `approval.rejected` already recorded for a resolution not yet applied — a fork cut after it. */
  rejectedEmitted: Set<string>;
  /** Nodes that failed while the run went on: an edge admitting a failed source routed the failure. */
  failed: string[];
  /** Nodes whose incoming edges' triggerRule was not satisfied. */
  skipped: string[];
  /** Each node's LATEST terminal event (node.completed / node.failed / node.skipped) and its sequence — the scheduler's view of a visit. */
  outcome: Map<string, { seq: number; type: string }>;
  /** Each node's latest node.started sequence: a start with no terminal after it is an execution still owed. */
  lastStart: Map<string, number>;
  /** node.started events in the run (inherited prefix included) — what configurable.run.recursionLimit counts. */
  starts: number;
  /**
   * interrupt.md §Re-entry: the node's visit index — its interrupts whose
   * resolution was consumed before this execution — which the key K derives from.
   */
  resolvedCount: Map<string, number>;
  startedAt: string | null;
}

function fold(host: Host, run: RunRow): Folded {
  const events = readEvents(host, run);
  const completed: string[] = [];
  const attempts = new Map<string, number>();
  const terminals = new Map<string, number>();
  const resolved = new Map<string, Record<string, unknown>>();
  const resumed = new Map<string, unknown>();
  const requested = new Map<string, string>();
  const rejectedEmitted = new Set<string>();
  const failed: string[] = [];
  const skipped: string[] = [];
  const outcome = new Map<string, { seq: number; type: string }>();
  const lastStart = new Map<string, number>();
  const resolvedCount = new Map<string, number>();
  let starts = 0;
  let started = false;
  let suspended: string | null = null;
  let startedAt: string | null = null;
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === 'run.started') { started = true; startedAt = e.timestamp; }
    if (e.type === 'node.started' && e.nodeId) { attempts.set(e.nodeId, (attempts.get(e.nodeId) ?? 0) + 1); requested.delete(e.nodeId); resolved.delete(e.nodeId); resumed.delete(e.nodeId); lastStart.set(e.nodeId, e.sequence); starts++; }
    if ((e.type === 'node.completed' || e.type === 'node.failed' || e.type === 'node.skipped') && e.nodeId) outcome.set(e.nodeId, { seq: e.sequence, type: e.type });
    if (e.type === 'interrupt.resolved' && e.nodeId) resolvedCount.set(e.nodeId, (resolvedCount.get(e.nodeId) ?? 0) + 1);
    if (e.type === 'node.completed' && e.nodeId && !completed.includes(e.nodeId)) completed.push(e.nodeId);
    if ((e.type === 'node.completed' || e.type === 'node.failed') && e.nodeId) terminals.set(e.nodeId, (terminals.get(e.nodeId) ?? 0) + 1);
    if (e.type === 'node.suspended' && e.nodeId) suspended = e.nodeId;
    if (e.type === 'interrupt.requested' && e.nodeId && typeof payload['key'] === 'string') requested.set(e.nodeId, payload['key']);
    if (e.type === 'interrupt.resolved' && e.nodeId) { requested.delete(e.nodeId); resolved.set(e.nodeId, payload); }
    if (e.type === 'approval.rejected' && e.nodeId) rejectedEmitted.add(e.nodeId);
    if (e.type === 'node.failed' && e.nodeId && !failed.includes(e.nodeId)) failed.push(e.nodeId);
    if (e.type === 'node.skipped' && e.nodeId && !skipped.includes(e.nodeId)) skipped.push(e.nodeId);
    if (e.type === 'node.resumed' && e.nodeId) { resolved.delete(e.nodeId); resumed.set(e.nodeId, payload['resumeValue']); }
    if ((e.type === 'node.completed' || e.type === 'node.failed') && e.nodeId) { requested.delete(e.nodeId); resolved.delete(e.nodeId); resumed.delete(e.nodeId); rejectedEmitted.delete(e.nodeId); }
    if (e.type === 'node.resumed' || e.type === 'node.completed' || e.type === 'node.failed') suspended = null;
  }
  return { started, completed, attempts, terminals, suspended, requested, resolved, resumed, rejectedEmitted, failed, skipped, outcome, lastStart, starts, resolvedCount, startedAt };
}

function setStatus(host: Host, run: RunRow, status: string, patch: Partial<RunRow> = {}): void {
  host.store.updateRun(run.run_id, { status, ...patch });
  run.status = status;
  Object.assign(run, patch);
  // conformance.md §Production profile: a host claiming `production` logs, per terminal run, its
  // id, tenant, terminal status, error code and a correlation id. The run id is the correlation
  // id: every event, snapshot and audit entry of the run carries it.
  if (host.config.inflightCap !== null && TERMINAL.has(status)) {
    const error = typeof run.error_json === 'string' ? (JSON.parse(run.error_json) as { code?: unknown }) : null;
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'run.terminal', runId: run.run_id, tenant: run.tenant, status, errorCode: typeof error?.code === 'string' ? error.code : null, correlationId: run.run_id })}\n`);
  }
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

/**
 * runs.md `run.started.transport` — the surface that ACCEPTED the run. REST is
 * the default; the A2A interface and the MCP mount (RFC 0208) record theirs in
 * the run's options at acceptance, so a re-entered loop (restart, fork) still
 * reports the surface the run actually came in through.
 */
const TRANSPORTS = new Set(['rest', 'mcp', 'a2a', 'ui']);
function runTransport(t: unknown): string {
  return typeof t === 'string' && TRANSPORTS.has(t) ? t : 'rest';
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
  const options = JSON.parse(run.options_json) as { tags?: string[]; metadata?: Record<string, unknown>; transport?: unknown };
  let startedAt = state.startedAt;
  if (!state.started) {
    const owner = ownerOf(host, run);
    const payload: Record<string, unknown> = { workflowId: run.workflow_id, inputs: JSON.parse(run.inputs_json), transport: runTransport(options.transport), engineVersion: 1, owner };
    if (options.tags) payload['tags'] = options.tags;
    if (options.metadata) payload['metadata'] = options.metadata;
    const doc = appendEvent(host, run, 'run.started', payload);
    startedAt = doc.timestamp;
    setStatus(host, run, 'running', { started_at: doc.timestamp });
    reserveBudget(host, run);
  } else if (run.status === 'pending') {
    setStatus(host, run, 'running');
  }
  const order = orderNodes(def);
  const limit = recursionLimit(run);
  for (;;) {
    // Re-folded every step: the log is the scheduler's only state, so a cycle, a
    // resumed suspend, a restart and a fork all continue from what is recorded.
    run = host.store.getRun(runId) as RunRow;
    const state = fold(host, run);
    const node = nextNode(def, order, state);
    if (node === null) break;
    if (run.cancel_requested === 1) { terminalCancel(host, run, takeCancelReason(runId), 'caller', startedAt); return; }
    if (run.pause_requested === 1) {
      // Between nodes: the requested policy is echoed verbatim (runs.md §Pause
      // and resume); under `drain-current-node` this is where a drained node's
      // run pauses, under `immediate` only when the request landed between attempts.
      appendEvent(host, run, 'run.paused', { reason: 'operator', drainPolicy: pausePolicy.get(runId) ?? 'drain-current-node' });
      pausePolicy.delete(runId);
      setStatus(host, run, 'paused', { pause_requested: 0 });
      return;
    }
    // The scheduler: a node fires only when its incoming edges' triggerRule is
    // satisfied by its sources' latest outcomes — so a failed source satisfies an
    // `all_complete` / `any_failed` edge and never an `all_success` one.
    const gate = fires(def, node.id, latestOutcomes(state));
    if (!gate.fires) {
      appendEvent(host, run, 'node.skipped', { nodeId: node.id, reason: `triggerRule ${gate.rule} not satisfied` }, { nodeId: node.id });
      continue;
    }
    // Re-entry past a recorded resolution (interrupt.md §"Re-entry and resume
    // values"): a fork whose fixed history already resolved this node's interrupt
    // continues from the log — no fresh attempt, no second `interrupt.requested`.
    if (state.resumed.has(node.id)) {
      appendEvent(host, run, 'node.completed', { nodeId: node.id, outputs: { resumeValue: state.resumed.get(node.id) } }, { nodeId: node.id });
      continue;
    }
    let recorded = state.resolved.get(node.id);
    const requestedKey = state.requested.get(node.id);
    if (recorded === undefined && requestedKey !== undefined && run.fork_mode === 'replay') {
      // The history stops after K was invoked; the source's resolution of the same K
      // is the one this replay takes: the recorded interrupt.resolved, and nothing
      // re-emitted before it (openwop 0223.replay-derives-rejection).
      const replayed = recordedResolution(host, run, requestedKey);
      if (replayed !== null) {
        appendEvent(host, run, 'interrupt.resolved', replayed.resolved, { nodeId: node.id });
        recorded = replayed.resolved;
      }
    }
    if (recorded !== undefined) {
      if (applyResolution(host, run, node.id, recorded, state.rejectedEmitted.has(node.id)) === 'failed') return;
      continue;
    }
    // runs.md §`run` section: a breach of recursionLimit, counted in node starts,
    // emits cap.breached { kind: node-executions } and fails the run — the runaway
    // guard a cycle needs (settings.maxLoopbackIterations is advisory, openwop#1748).
    if (state.starts >= limit) {
      appendEvent(host, run, 'cap.breached', { kind: 'node-executions', limit, observed: state.starts + 1 });
      const error = { code: 'recursion_limit_exceeded', message: `starting ${node.id} would exceed recursionLimit ${limit} node executions`, details: { limit, nodeId: node.id } };
      appendEvent(host, run, 'run.failed', { error, durationMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0 });
      host.store.invalidateInterruptsForRun(run.run_id);
      setStatus(host, run, 'failed', { completed_at: nowIso(), current_node_id: null, error_json: JSON.stringify(error) });
      return;
    }
    const attempt = state.attempts.get(node.id) ?? 0;
    const execution = 1 + (state.terminals.get(node.id) ?? 0);
    const visit = state.resolvedCount.get(node.id) ?? 0;
    const nodeStart = Date.now();
    appendEvent(host, run, 'node.started', { nodeId: node.id, typeId: node.typeId, attempt }, { nodeId: node.id });
    let result: NodeResult | 'cancelled' | 'paused';
    try {
      result = await executeNode(host, run, def, node, attempt, execution, visit);
    } catch (e) {
      const failure = e instanceof NodeFailure ? e : new NodeFailure('internal_error', (e as Error).message);
      const error: Record<string, unknown> = { code: failure.code, message: failure.message };
      if (failure.details) error['details'] = failure.details;
      // A hard budget stops the RUN (runs.md §budget section): a failure edge cannot route around it.
      if (failNode(host, host.store.getRun(runId) as RunRow, def, node.id, error, attempt + 1, failure.code !== 'budget_exhausted') === 'failed') return;
      continue;
    }
    if (result === 'cancelled') { run = host.store.getRun(runId) as RunRow; appendEvent(host, run, 'node.cancelled', { nodeId: node.id, reason: 'run-cancelled' }, { nodeId: node.id }); terminalCancel(host, run, takeCancelReason(runId), 'caller', startedAt); return; }
    if (result === 'paused') {
      // `immediate` cut the attempt between events: no terminal node event is
      // recorded for it (runs.md §Pause and resume); the payload names the
      // interrupted node and attempt (1-based, run-event-payloads.schema.json)
      // so a reader can tell the cut from a drained pause; the resumed
      // `node.started` is a fresh attempt.
      run = host.store.getRun(runId) as RunRow;
      appendEvent(host, run, 'run.paused', { reason: 'operator', drainPolicy: 'immediate', interruptedNodeId: node.id, interruptedAttempt: attempt + 1 });
      pausePolicy.delete(runId);
      setStatus(host, run, 'paused', { pause_requested: 0 });
      return;
    }
    if ('suspend' in result) {
      // replay.md §"Determinism caveats" 2: in a replay, ctx.interrupt(K) short-circuits
      // to the source's persisted resolution. No interrupt.requested is emitted and
      // nothing is minted to resolve (interrupt.md §"Re-entry and resume values";
      // openwop 0223.replay-derives-rejection): the fork records the source's
      // interrupt.resolved verbatim and applies it, so a rejection is derived, never
      // re-decided, and a resume on the fork answers 409 interrupt_already_resolved.
      const replayed = run.fork_mode === 'replay' ? recordedResolution(host, run, result.suspend.key) : null;
      if (replayed !== null) {
        host.validate('suspend-request', result.suspend, `replayed interrupt ${String(replayed.suspended['interruptId'])}`);
        appendEvent(host, run, 'interrupt.resolved', replayed.resolved, { nodeId: node.id });
        if (applyResolution(host, run, node.id, replayed.resolved) === 'failed') return;
        continue;
      }
      const { row } = mintInterrupt(host, run, node.id, result.suspend);
      host.validate('suspend-request', result.suspend, `interrupt ${row.interrupt_id}`);
      appendEvent(host, run, 'interrupt.requested', result.suspend, { nodeId: node.id });
      appendEvent(host, run, 'node.suspended', { nodeId: node.id, interruptId: row.interrupt_id, kind: result.suspend.kind, key: result.suspend.key }, { nodeId: node.id });
      setStatus(host, run, waitingStatusFor(result.suspend.kind), { current_node_id: node.id });
      return;
    }
    // DUPLICATE DELIVERY (RFC 0158 §C). `scheduleRun` admits one loop per run,
    // but the same accepted work can still reach this function twice, and the
    // `await` above is where the two interleave. Whatever the other delivery
    // recorded while this one waited is authoritative: a run it already ended
    // stays ended, and a node it already completed is not completed again.
    // Measured before this check: one effect (the ledger claim held) and a log
    // carrying TWO `run.completed` — the second appended past the terminal
    // event. From the re-read to the append is synchronous, so nothing can
    // interleave between the check and the write it guards.
    run = host.store.getRun(runId) as RunRow;
    if (TERMINAL.has(run.status)) return;
    if ((fold(host, run).terminals.get(node.id) ?? 0) >= execution) continue; // the other delivery already ended THIS execution
    appendEvent(host, run, 'node.completed', { nodeId: node.id, outputs: result.outputs, durationMs: Date.now() - nodeStart }, { nodeId: node.id });
  }
  run = host.store.getRun(runId) as RunRow;
  if (TERMINAL.has(run.status)) return; // the other delivery of this work already ended it
  if (run.cancel_requested === 1) { terminalCancel(host, run, takeCancelReason(runId), 'caller', startedAt); return; }
  appendEvent(host, run, 'run.completed', { outputs: runOutputs(host, run, def), durationMs: startedAt ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0 });
  host.store.invalidateInterruptsForRun(run.run_id);
  setStatus(host, run, 'completed', { completed_at: nowIso(), current_node_id: null });
}

/**
 * The reason a `cancelling` run's cancel was requested with, consumed by the
 * loop that records `run.cancelled`. In memory beside the loop, like
 * `pausePolicy`: a restart re-enters the run and the default is recorded.
 */
const cancelReasons = new Map<string, string>();
function takeCancelReason(runId: string): string {
  const r = cancelReasons.get(runId) ?? 'caller-requested';
  cancelReasons.delete(runId);
  return r;
}

/** runs.md §Cancel — accepted immediately; the cascade completes in the loop when a node is executing. */
export function requestCancel(host: Host, run: RunRow, reason: string | undefined): { status: string } {
  // runs.md §Cancel (rc.48): a cancel on a terminal run is refused 409
  // run_terminal — the 200 grammar is only { runId, status: cancelling |
  // cancelled }, so echoing `completed` was outside it. Both the single and
  // the bulk endpoint route through here; the bulk entry becomes
  // { ok: false, error: <envelope> } from the throw.
  if (TERMINAL.has(run.status)) throw err('run_terminal', `a ${run.status} run cannot be cancelled`, { runStatus: run.status });
  const state = fold(host, run);
  if (run.status === 'pending' || run.status === 'paused' || run.status.startsWith('waiting-') || !active.has(run.run_id)) {
    if (state.suspended !== null) appendEvent(host, run, 'node.cancelled', { nodeId: state.suspended, reason: 'run-cancelled' }, { nodeId: state.suspended });
    terminalCancel(host, run, reason ?? 'caller-requested', 'caller', state.startedAt);
    return { status: 'cancelled' };
  }
  // The reason travels with the request to the loop that completes the cascade
  // (e.g. RFC 0198 `mcp-request-cancelled`), instead of being replaced there.
  if (!cancelReasons.has(run.run_id)) cancelReasons.set(run.run_id, reason ?? 'caller-requested');
  setStatus(host, run, 'cancelling', { cancel_requested: 1 });
  return { status: 'cancelling' };
}

/**
 * runs.md §Pause and resume (rc.52): the `run.paused` payload echoes the
 * request's `drainPolicy` literally — `immediate` | `drain-current-node` —
 * and the two mean different things to the executor: `immediate` cuts the
 * running attempt between events (no terminal node event is recorded; the
 * resumed `node.started` is a fresh attempt), `drain-current-node` lets the
 * executing node reach a terminal first. The requested policy lives here, in
 * memory, next to the executor that consumes it: `pause_requested` is
 * consumed by the loop that is running, so it never needs to survive a restart.
 */
const pausePolicy = new Map<string, 'immediate' | 'drain-current-node'>();

export function requestPause(host: Host, run: RunRow, reason: string | undefined, drainPolicy: string): { pausedAt?: string } {
  if (run.status !== 'running' && run.status !== 'pending') throw err('run_state_conflict', `a run in status ${run.status} cannot be paused`, { runStatus: run.status });
  const policy: 'immediate' | 'drain-current-node' = drainPolicy === 'immediate' ? 'immediate' : 'drain-current-node';
  if (!active.has(run.run_id) || run.status === 'pending') {
    appendEvent(host, run, 'run.paused', { reason: reason ?? 'operator', drainPolicy: policy });
    setStatus(host, run, 'paused');
    return { pausedAt: nowIso() };
  }
  pausePolicy.set(run.run_id, policy);
  host.store.updateRun(run.run_id, { pause_requested: 1 });
  return {};
}

export function requestResume(host: Host, run: RunRow, reason: string | undefined): { resumedAt: string } {
  appendEvent(host, run, 'run.resumed', reason === undefined ? {} : { reason });
  setStatus(host, run, 'running');
  scheduleRun(host, run.run_id);
  return { resumedAt: nowIso() };
}

/** Both resolve surfaces converge here: validate, count the vote, claim atomically, record, resume. */
export function resolveAndResume(host: Host, run: RunRow, row: InterruptRow, resumeValue: unknown, subject: Subject | null): { runId: string; nodeId: string; status: string } {
  const outcome = validateResolve(host, run, row, resumeValue, subject);
  if (!outcome.exitsSuspend) return { runId: run.run_id, nodeId: row.node_id, status: run.status };
  const payload = payloadOf(row);
  let decision = outcome.decision;
  let reason: string | undefined;
  if (payload.kind === 'approval' && decision !== undefined) {
    // A vote that does not decide a quorum gate records nothing on the log (interrupt.md §Rejection).
    const tally = tallyVote(host, row, resumeValue, subject, decision);
    if (tally === null) return { runId: run.run_id, nodeId: row.node_id, status: run.status };
    decision = tally.decision;
    reason = tally.reason;
  }
  if (!host.store.resolveInterrupt(row.interrupt_id, JSON.stringify(resumeValue ?? null))) throw err('interrupt_already_resolved', 'a concurrent resolve won');
  const resolved: Record<string, unknown> = { nodeId: row.node_id, interruptId: row.interrupt_id, kind: payload.kind, resumeValue };
  if (subject !== null) resolved['resolvedBy'] = subject;
  if (decision !== undefined) resolved['decision'] = decision;
  if (payload.kind === 'approval') {
    // interrupt.md §Events (RFC 0183) / §Rejection (RFC 0223): the applied action, and the field it requires.
    const rv = resumeValue as { action?: unknown; refineFeedback?: unknown; editedArtifactData?: unknown };
    resolved['action'] = rv.action;
    if (rv.action === 'refine') resolved['refineFeedback'] = rv.refineFeedback;
    if (rv.action === 'edit-accept') resolved['editedArtifactData'] = rv.editedArtifactData;
  }
  if (reason !== undefined) resolved['reason'] = reason;
  return { runId: run.run_id, nodeId: row.node_id, status: recordResolution(host, run, row.node_id, resolved) };
}

/** Append a claimed resolution, apply it, and put the run back in the scheduler unless it ended. */
function recordResolution(host: Host, run: RunRow, nodeId: string, resolved: Record<string, unknown>): string {
  appendEvent(host, run, 'interrupt.resolved', resolved, { nodeId });
  if (applyResolution(host, run, nodeId, resolved) === 'failed') return 'failed';
  setStatus(host, run, 'running', { current_node_id: null });
  scheduleRun(host, run.run_id);
  return 'running';
}

/**
 * What an `interrupt.resolved` does to its node, whether it was just recorded by
 * a resolve or is being re-entered from the log by a fork (the same events either
 * way, so a replay reproduces its source and never re-decides): the node resumes
 * and completes with the resumeValue, or a rejection / declined credential fails
 * it through the scheduler — `routed` when an edge admits the failed source,
 * `failed` when the run ended.
 */
function applyResolution(host: Host, run: RunRow, nodeId: string, resolved: Record<string, unknown>, rejectedEmitted = false): 'resumed' | 'routed' | 'failed' {
  const resumeValue = resolved['resumeValue'];
  let error: Record<string, unknown> | null = null;
  // RFC 0199 §C.4 — `declined` fails the node with connector_auth_declined.
  if (resolved['kind'] === 'credential' && (resumeValue as { outcome?: unknown } | null)?.outcome === 'declined') error = { code: 'connector_auth_declined', message: 'the user declined the credential interrupt' };
  else if (resolved['decision'] === 'rejected') {
    // interrupt.md §Rejection (RFC 0223): approval.rejected (SHOULD), then the gate fails
    // not retryable — and it is never retried: nothing re-executes a failed node.
    if (resolved['kind'] === 'approval' && !rejectedEmitted) appendEvent(host, run, 'approval.rejected', resolved, { nodeId });
    error = { code: 'approval_rejected', message: resolved['action'] === 'timeout' ? 'the approval gate timed out and resolved rejected' : 'the approval was rejected', retryable: false };
  }
  if (error !== null) return failNode(host, run, host.workflows.get(run.workflow_id), nodeId, error, 1);
  appendEvent(host, run, 'node.resumed', { nodeId, interruptId: resolved['interruptId'], resumeValue }, { nodeId });
  if (resolved['kind'] === 'conversation.exchange') {
    // RFC 0239: the accepted council turn, then the close — one exchange per gate.
    const rv = (resumeValue ?? {}) as { role?: unknown; speakerId?: unknown; content?: unknown };
    const conversationId = conversationIdFor(run, nodeId);
    const speakerId = String(rv.speakerId);
    const turn: Record<string, unknown> = { messageId: `${conversationId}:0:${speakerId}`, from: speakerId, content: String(rv.content), ts: Date.now(), role: rv.role === 'user' ? 'user' : 'agent', turnIndex: 0, speakerId };
    if (corpusHasParts(host)) turn['parts'] = [{ text: turn['content'] }];
    appendEvent(host, run, 'conversation.exchanged', { conversationId, turnIndex: 0, turn }, { nodeId });
    appendEvent(host, run, 'conversation.closed', { conversationId, reason: 'goal-reached', turnCount: 1 }, { nodeId });
  }
  appendEvent(host, run, 'node.completed', { nodeId, outputs: { resumeValue } }, { nodeId });
  return 'resumed';
}

/**
 * A node's terminal failure, decided by the scheduler. `node.failed` is always
 * recorded; when an outgoing edge admits a failed source (`all_complete`,
 * `any_failed`) the failure is routed and the run goes on (`routed`). Otherwise
 * the run ends: compensation unwinds, then `run.failed { failedNodeId }` (`failed`).
 */
function failNode(host: Host, run: RunRow, def: WorkflowDefinition | undefined, nodeId: string, error: Record<string, unknown>, attempts: number, routable = true): 'routed' | 'failed' {
  appendEvent(host, run, 'node.failed', { nodeId, error, attempts }, { nodeId });
  if (routable && def !== undefined && failureRouted(def, nodeId)) return 'routed';
  const state = fold(host, run);
  if (def !== undefined) unwind(host, run, def, state.completed);
  appendEvent(host, run, 'run.failed', { error, failedNodeId: nodeId, durationMs: state.startedAt ? Math.max(0, Date.now() - Date.parse(state.startedAt)) : 0 });
  host.store.invalidateInterruptsForRun(run.run_id);
  // The snapshot's `error` is closed over { code, message, details? }: `retryable` belongs to the event error object.
  const { retryable: _retryable, ...snapshotError } = error;
  setStatus(host, run, 'failed', { completed_at: nowIso(), current_node_id: null, error_json: JSON.stringify(snapshotError) });
  return 'failed';
}

/**
 * interrupt.md §Rejection — the timeout disposition. An approval gate whose
 * non-zero `timeoutMs` elapsed unresolved is resolved rejected by the host
 * itself, WHATEVER `onTimeout` holds: `action: timeout`, `decision: rejected`,
 * `reason: timeout`, no `resolvedBy`. It then fails like any reject. A timeout
 * MUST NOT grant a gate: `approve` is treated as reject, and `escalate` may
 * notify but MUST NOT extend or grant (openwop#1696) — this host notifies no one.
 * Swept on a timer, so a deadline that passed while the process was down is
 * applied at the first tick after boot.
 */
export function sweepApprovalTimeouts(host: Host): void {
  for (const row of host.store.expiredPendingInterrupts('approval', nowIso())) {
    const payload = payloadOf(row);
    if (!(typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0)) continue;
    const run = host.store.getRun(row.run_id);
    if (!run || TERMINAL.has(run.status) || !run.status.startsWith('waiting-')) continue;
    if (!host.store.resolveInterrupt(row.interrupt_id, 'null')) continue; // a caller's resolve won
    recordResolution(host, run, row.node_id, { nodeId: row.node_id, interruptId: row.interrupt_id, kind: 'approval', decision: 'rejected', action: 'timeout', reason: 'timeout' });
  }
}

export function startApprovalTimeoutSweep(host: Host): () => void {
  const timer = setInterval(() => { try { sweepApprovalTimeouts(host); } catch (e) { process.stderr.write(`[executor] approval timeout sweep: ${String((e as Error)?.stack ?? e)}\n`); } }, 100);
  timer.unref();
  return () => clearInterval(timer);
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

/**
 * RFC 0199 §C.4 — the host resolves a credential interrupt ITSELF once the grant
 * its connectUrl began has completed (oauth.ts callback). The same resolve path
 * a caller uses, so the re-check runs and the log records
 * `interrupt.resolved { resumeValue: { outcome: authorized } }`.
 */
setGrantCompletedHandler((host, runId, nodeId, subject) => {
  const run = host.store.getRun(runId);
  if (!run || TERMINAL.has(run.status)) return;
  const row = host.store.pendingInterruptForNode(runId, nodeId);
  if (!row || row.kind !== 'credential') return;
  try { resolveAndResume(host, run, row, { outcome: 'authorized' }, subject); } catch { /* a concurrent resolve won, or the credential no longer covers the scopes */ }
});
