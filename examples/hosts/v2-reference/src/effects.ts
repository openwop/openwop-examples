/**
 * The outbound-effect side of the host, in one place so replay.md's
 * suppression rules bind at every seam:
 *
 *   - Layer-2 effect identity (idempotency.md §Layer 2, security-defaults.md):
 *     an effect is keyed on its business identity (tenant, workflow, node
 *     config, request digest — no runId, nodeId ordinal or attempt), claimed
 *     insert-if-absent, its outcome recorded; GET /runs/{runId}/effects projects it.
 *   - replay.md §Suppression: a `replay` fork resolves a side-effecting node
 *     from the SOURCE run's recorded outcome keyed (sourceRunId, nodeId,
 *     attempt); absent ⇒ node fails closed with replay_source_missing.
 *   - The effect-seam manifest (GET /host/effect-seams) enumerates both seams
 *     this runtime can reach: `http.fetch` and `webhook.fanout`.
 *   - Compensation (security-defaults.md §Compensation): a reverse-completion
 *     plan over completed nodes that declare `config.compensation`, unwound
 *     when the run fails; GET /runs/{runId}/compensation projects plan + attempts.
 */
import { createHash } from 'node:crypto';
import { HOST_NAME } from './config.js';
import { guardedRequest, validateEgressUrl } from './egress.js';
import { err } from './errors.js';
import { nowIso, opaque } from './ids.js';
import type { Host, WorkflowNode } from './host.js';
import type { EffectRow, RunRow } from './store.js';

export function effectSeamManifest(host: Host): Record<string, unknown> {
  return {
    manifestVersion: '1',
    host: { name: HOST_NAME, build: host.config.hostBuild },
    seams: [
      { seam: 'http.fetch', kind: 'http', guarded: true, guardedBy: 'effects-ledger:recorded-outcome (effects.ts performHttpFetch)', branchReFires: false, note: "the core.httpFetch node. A replay fork resolves the source run's recorded outcome keyed (sourceRunId, nodeId, attempt). A BRANCH does not re-fire it either: the Layer-2 key is the business identity and carries no runId, so a branch reaching the same operation resolves to the recorded outcome (idempotency.md §Layer 2 Keying) rather than calling out." },
      { seam: 'webhook.fanout', kind: 'webhook-fanout', guarded: true, guardedBy: 'fanout-guard:replay-ness-of-the-run (webhooks.ts subscribeFanout)', branchReFires: true, note: 'a replay fork\'s events are never delivered; a branch delivers only events >= fromSeq' },
    ],
  };
}

export function effectsProjection(host: Host, run: RunRow): Record<string, unknown> {
  const effects = host.store.effectsForRun(run.run_id).map((e) => {
    const row: Record<string, unknown> = { effectId: e.effect_id, nodeId: e.node_id, attempt: e.attempt, keying: e.keying, state: e.state, at: e.at };
    if (e.invocation_id !== null) row['invocationId'] = e.invocation_id;
    if (e.provider_key !== null) row['providerKey'] = e.provider_key;
    return row;
  });
  return { runId: run.run_id, effects };
}

interface CompensationState {
  status: 'none' | 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  plan: Array<{ nodeId: string; order: number; irreversibleEffect?: boolean }>;
  attempts: Array<{ nodeId: string; attempt: number; outcome: 'succeeded' | 'failed' | 'skipped' | 'manual'; at: string; reason?: string }>;
}

export function compensationState(run: RunRow): CompensationState {
  return run.compensation_json === null ? { status: 'none', plan: [], attempts: [] } : (JSON.parse(run.compensation_json) as CompensationState);
}

export function compensationProjection(host: Host, run: RunRow): Record<string, unknown> {
  const s = compensationState(run);
  return { runId: run.run_id, status: s.status, plan: s.plan, attempts: s.attempts };
}

/** RunSnapshot.compensationStatus (runs.md §Snapshot) — `none` when never requested. */
export function compensationStatusOf(run: RunRow): string {
  return compensationState(run).status;
}

/** Reverse-completion plan over the completed nodes that declare a compensation (RFC 0151 §A). */
export function buildCompensationPlan(nodes: readonly WorkflowNode[], completedInOrder: readonly string[]): CompensationState['plan'] {
  const declared = new Map(nodes.filter((n) => n.config['compensation'] !== undefined).map((n) => [n.id, n] as const));
  const plan: CompensationState['plan'] = [];
  let order = 0;
  for (const id of [...completedInOrder].reverse()) {
    const n = declared.get(id);
    if (!n) continue;
    const c = n.config['compensation'] as { irreversibleEffect?: boolean } | undefined;
    plan.push(c?.irreversibleEffect === true ? { nodeId: id, order: order++, irreversibleEffect: true } : { nodeId: id, order: order++ });
  }
  return plan;
}

/**
 * Business-identity key: the business operation, never the run, the node
 * ordinal or the attempt (idempotency.md §Layer 2 Keying). A caller-supplied
 * business key (`inputs.businessKey`, the order id an provider would carry)
 * identifies the logical invocation; absent one, the operation's own shape does.
 */
export function businessKey(run: RunRow, node: WorkflowNode, request: { method: string; url: string; body: string | undefined }): string {
  const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
  const supplied = typeof inputs['businessKey'] === 'string' ? inputs['businessKey'] : node.config['businessKey'];
  const material = JSON.stringify({ tenant: run.tenant, workflow: run.workflow_id, node: node.id, method: request.method, url: request.url, body: request.body ?? null, key: supplied ?? null });
  return createHash('sha256').update(material).digest('hex');
}

export interface FetchOutcome { status: number; error?: string; suppressed?: boolean }

/** The request one `core.httpFetch` node makes, with the run's input overrides applied. */
function requestOf(run: RunRow, node: WorkflowNode): { method: string; url: string; body: string | undefined; transportRetries: number } {
  const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
  const url = String(inputs['url'] ?? node.config['url'] ?? '');
  const method = String(node.config['method'] ?? 'POST').toUpperCase();
  const body = node.config['body'] === undefined ? undefined : JSON.stringify(node.config['body']);
  const retries = Number(inputs['transportRetries'] ?? node.config['transportRetries'] ?? 0);
  return { method, url, body, transportRetries: Number.isFinite(retries) ? Math.max(0, Math.min(4, retries)) : 0 };
}

/**
 * The `http.fetch` seam. One logical invocation = one effect identity
 * (`effectId`, `providerKey`), assigned once and presented on every transport
 * attempt; each attempt is its own ledger row. A `replay` fork never calls out:
 * the SOURCE run's recorded outcome for `(sourceRunId, nodeId, attempt)` is the
 * result, or the node fails closed with `replay_source_missing`.
 */
export async function performHttpFetch(host: Host, run: RunRow, node: WorkflowNode, attempt: number): Promise<{ outputs: Record<string, unknown>; effectId: string }> {
  const request = requestOf(run, node);
  const key = businessKey(run, node, request);

  if (run.fork_mode === 'replay' && run.source_run_id !== null) {
    const recorded = host.store.effectOutcome(run.source_run_id, node.id, attempt);
    if (recorded === undefined || recorded.outcome_json === null) {
      throw Object.assign(new Error(`no recorded outcome for (${run.source_run_id}, ${node.id}, ${attempt}) — the effect is not performed`), { code: 'replay_source_missing' });
    }
    const outcome = JSON.parse(recorded.outcome_json) as FetchOutcome;
    // The fork's own ledger carries the resolved (suppressed) row so the read
    // projection is whole-run; no attempt is added beyond the source's.
    const mirror = host.store.claimEffect({ effect_id: recorded.effect_id, run_id: run.run_id, node_id: node.id, attempt: 1, keying: 'business-identity', state: 'completed', provider_key: recorded.provider_key, invocation_id: `replay-of:${recorded.run_id}`, at: nowIso(), business_key: key, outcome_json: JSON.stringify({ ...outcome, suppressed: true }) });
    return { outputs: { status: outcome.status, suppressed: true, sourceEffectId: recorded.effect_id }, effectId: mirror.row.effect_id };
  }

  // The identity is assigned once per business key and reused by every attempt.
  const identity = host.store.effectIdentity(key);
  const effectId = identity?.effect_id ?? `${run.tenant}/${opaque()}`;
  const providerKey = identity?.provider_key ?? `idem-${key.slice(0, 24)}`;
  // Business identity is the guard, not the run: a business operation already
  // performed resolves to its recorded outcome instead of being performed
  // again — which is why the `http.fetch` manifest row states branchReFires:
  // false (a branch reaching the same operation re-uses the record).
  const done = host.store.completedEffect(key);
  if (done !== undefined && done.run_id !== run.run_id) {
    const mirror = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: 1, keying: 'business-identity', state: 'completed', provider_key: providerKey, invocation_id: `deduplicated-of:${done.run_id}`, at: nowIso(), business_key: key, outcome_json: done.outcome_json });
    return { outputs: { ...(JSON.parse(done.outcome_json as string) as FetchOutcome), deduplicated: true }, effectId: mirror.row.effect_id };
  }
  let outcome: FetchOutcome = { status: 0, error: 'not attempted' };
  let ledgerAttempt = 0;
  for (let i = 0; i <= request.transportRetries; i++) {
    ledgerAttempt = i + 1;
    const claim = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: ledgerAttempt, keying: 'business-identity', state: 'claimed', provider_key: providerKey, invocation_id: null, at: nowIso(), business_key: key, outcome_json: null });
    if (!claim.won && claim.row?.outcome_json !== null && claim.row !== undefined) {
      // Another executor already completed this attempt: resolve to its outcome.
      return { outputs: { ...(JSON.parse(claim.row.outcome_json as string) as FetchOutcome), deduplicated: true }, effectId };
    }
    try {
      const target = validateEgressUrl(request.url, host.config.webhookAllowPrivate);
      // The effect identity IS the provider's idempotency key (RFC 0150 §B).
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': providerKey };
      const r = await guardedRequest(target, { method: request.method, headers, timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate, ...(request.body === undefined ? {} : { body: request.body }) });
      outcome = r.error === undefined ? { status: r.status } : { status: r.status, error: r.error };
    } catch (e) {
      outcome = { status: 0, error: (e as Error).message };
    }
    host.store.updateEffect(run.run_id, effectId, ledgerAttempt, { state: outcome.error === undefined ? 'completed' : 'released', outcome_json: JSON.stringify(outcome) });
    if (outcome.error === undefined) break;
  }
  if (outcome.error !== undefined) throw err('validation_error', `http.fetch failed after ${ledgerAttempt} transport attempt(s): ${outcome.error}`);
  return { outputs: { status: outcome.status, attempts: ledgerAttempt }, effectId };
}

export function recordAttempt(host: Host, run: RunRow, state: CompensationState): void {
  host.store.updateRun(run.run_id, { compensation_json: JSON.stringify(state) });
  run.compensation_json = JSON.stringify(state);
}

export type EffectRowT = EffectRow;
