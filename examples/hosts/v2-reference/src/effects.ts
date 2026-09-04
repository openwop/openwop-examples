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
      { seam: 'http.fetch', kind: 'http', guarded: true, guardedBy: 'effects-ledger:recorded-outcome (effects.ts performHttpFetch)', branchReFires: true, note: 'the core.httpFetch node; a replay fork resolves the source run\'s recorded outcome keyed (sourceRunId, nodeId, attempt)' },
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

/** Business-identity key: the operation, never the run or the ordinal. */
export function businessKey(run: RunRow, node: WorkflowNode, request: { method: string; url: string; body: string | undefined }): string {
  const material = JSON.stringify({ tenant: run.tenant, workflow: run.workflow_id, node: node.id, method: request.method, url: request.url, body: request.body ?? null, key: node.config['idempotencyKey'] ?? null });
  return createHash('sha256').update(material).digest('hex');
}

export interface FetchOutcome { status: number; error?: string; suppressed?: boolean }

/**
 * The `http.fetch` seam. Replay forks never call out: the source outcome for
 * (sourceRunId, nodeId, attempt) is the result, or the node fails closed.
 */
export async function performHttpFetch(host: Host, run: RunRow, node: WorkflowNode, attempt: number): Promise<{ outputs: Record<string, unknown>; effectId: string }> {
  const url = String(node.config['url'] ?? '');
  const method = String(node.config['method'] ?? 'POST').toUpperCase();
  const body = node.config['body'] === undefined ? undefined : JSON.stringify(node.config['body']);
  const key = businessKey(run, node, { method, url, body });

  if (run.fork_mode === 'replay' && run.source_run_id !== null) {
    const recorded = host.store.effectOutcome(run.source_run_id, node.id, attempt);
    if (recorded === undefined || recorded.outcome_json === null) {
      throw Object.assign(new Error(`no recorded outcome for (${run.source_run_id}, ${node.id}, ${attempt}) — the effect is not performed`), { code: 'replay_source_missing' });
    }
    const outcome = JSON.parse(recorded.outcome_json) as FetchOutcome;
    // The fork's own ledger carries the resolved (suppressed) row so the read projection is whole-run.
    const mirror = host.store.claimEffect({ effect_id: `${run.tenant}/${opaque()}`, run_id: run.run_id, node_id: node.id, attempt, keying: 'business-identity', state: 'completed', provider_key: recorded.provider_key, invocation_id: `replay-of:${recorded.effect_id.split('/')[1] ?? ''}`, at: nowIso(), business_key: `${key}:replay:${run.run_id}:${attempt}`, outcome_json: JSON.stringify({ ...outcome, suppressed: true }) });
    return { outputs: { status: outcome.status, suppressed: true, sourceEffectId: recorded.effect_id }, effectId: mirror.effect_id };
  }

  const claim = host.store.claimEffect({ effect_id: `${run.tenant}/${opaque()}`, run_id: run.run_id, node_id: node.id, attempt, keying: 'business-identity', state: 'claimed', provider_key: `idem-${key.slice(0, 24)}`, invocation_id: null, at: nowIso(), business_key: key, outcome_json: null });
  if (claim.state === 'completed' && claim.outcome_json !== null) {
    // A retried logical invocation resolves to the same effect record.
    return { outputs: { ...(JSON.parse(claim.outcome_json) as FetchOutcome), deduplicated: true }, effectId: claim.effect_id };
  }
  let outcome: FetchOutcome;
  try {
    const target = validateEgressUrl(url, host.config.webhookAllowPrivate);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': claim.provider_key ?? key.slice(0, 32) };
    const r = await guardedRequest(target, { method, headers, timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate, ...(body === undefined ? {} : { body }) });
    outcome = r.error === undefined ? { status: r.status } : { status: r.status, error: r.error };
  } catch (e) {
    outcome = { status: 0, error: (e as Error).message };
  }
  host.store.updateEffect(claim.effect_id, { state: outcome.error === undefined ? 'completed' : 'released', outcome_json: JSON.stringify(outcome) });
  if (outcome.error !== undefined) throw err('validation_error', `http.fetch failed: ${outcome.error}`);
  return { outputs: { status: outcome.status }, effectId: claim.effect_id };
}

export function recordAttempt(host: Host, run: RunRow, state: CompensationState): void {
  host.store.updateRun(run.run_id, { compensation_json: JSON.stringify(state) });
  run.compensation_json = JSON.stringify(state);
}

export type EffectRowT = EffectRow;
