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
import { readEvents } from './events.js';
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
      ...(host.config.a2aPush ? [{ seam: 'a2a.push', kind: 'webhook-fanout', guarded: true, guardedBy: 'push-guard:replay-ness-of-the-run + configs keyed on their own task (a2a-push.ts subscribePush)', branchReFires: false, note: 'RFC 0214: a replay fork\'s events are never pushed, and no fork (replay or branch) inherits a source task\'s push configs, so a fork never pushes' }] : []),
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

/** Effect attempts THIS process holds the claim on and has not yet recorded an outcome for — see performHttpFetch. */
const inFlight = new Map<string, Promise<FetchOutcome>>();

/** The request one `core.httpFetch` node makes, with the run's input overrides applied. */
/**
 * The default transport budget for one attempt. 5 s is right for the production
 * path: a provider that has not answered in five seconds is not going to.
 *
 * It is NOT right for a conformance receiver behind a public tunnel. When the
 * round trip exceeds the ceiling and `transportRetries` is 0, the single attempt
 * is abandoned, the ledger row goes `released` and the node THROWS — while the
 * request itself already landed. The host then reports failure for work that
 * succeeded, which is a false report about its own effect.
 *
 * What this is NOT. It does not explain a receiver observing ZERO arrivals: a
 * receiver counts on request ARRIVAL, and a client-side timeout abandons the
 * wait for the response, not the request that already arrived. Measured
 * 2026-09-23 against a receiver that delays its response 6.5 s — past the old
 * 5 s ceiling — the arrival was still recorded. RFC 0158's `duplicate-delivery`
 * row failed once in four runs with zero arrivals and the cause of THAT is not
 * this: two suite legs handed the seam one byte-identical destination, so a
 * correctly deduplicating host fired the second zero times (openwop#1513).
 * Fixing this one is worth doing on its own terms.
 */
const DEFAULT_EFFECT_TIMEOUT_MS = 5_000;

function requestOf(run: RunRow, node: WorkflowNode): { method: string; url: string; body: string | undefined; transportRetries: number; timeoutMs: number } {
  const inputs = JSON.parse(run.inputs_json) as Record<string, unknown>;
  const url = String(inputs['url'] ?? node.config['url'] ?? '');
  const method = String(node.config['method'] ?? 'POST').toUpperCase();
  const body = node.config['body'] === undefined ? undefined : JSON.stringify(node.config['body']);
  const retries = Number(inputs['transportRetries'] ?? node.config['transportRetries'] ?? 0);
  // Bounded like `transportRetries` is, and for the same reason: a caller-named
  // budget is an input, and an unbounded one would let a workflow pin an
  // executor slot indefinitely.
  const declared = Number(inputs['timeoutMs'] ?? node.config['timeoutMs'] ?? DEFAULT_EFFECT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(declared) ? Math.max(1_000, Math.min(30_000, declared)) : DEFAULT_EFFECT_TIMEOUT_MS;
  return { method, url, body, transportRetries: Number.isFinite(retries) ? Math.max(0, Math.min(4, retries)) : 0, timeoutMs };
}

/**
 * The `http.fetch` seam. One logical invocation = one effect identity
 * (`effectId`, `providerKey`), assigned once and presented on every transport
 * attempt; each attempt is its own ledger row. A `replay` fork never calls out:
 * the SOURCE run's recorded outcome for `(sourceRunId, nodeId, n)` is the
 * result, or the node fails closed with `replay_source_missing`.
 *
 * `execution` is this execution's ordinal n: 1 + the node's `node.completed` +
 * `node.failed` events before it in the run's log, inherited fork prefix
 * included (replay.md §Suppression rule 2, as re-corrected on openwop#1718 —
 * terminals, not `node.started`, which a restart or a fork cut inside an
 * attempt re-emits for the same execution). Every ledger row records it, and a
 * replay of execution n resolves execution n's outcome, never simply the last.
 */
export async function performHttpFetch(host: Host, run: RunRow, node: WorkflowNode, execution: number): Promise<{ outputs: Record<string, unknown>; effectId: string }> {
  const request = requestOf(run, node);
  const key = businessKey(run, node, request);

  if (run.fork_mode === 'replay' && run.source_run_id !== null) {
    let recorded = host.store.effectOutcome(run.source_run_id, node.id, execution);
    if (recorded === undefined) {
      // Execution n recorded no row of its own when it resolved to an earlier
      // execution's record of the same business identity; its node.completed names that effect.
      const effectId = executionEffectId(host, run.source_run_id, node.id, execution);
      if (effectId !== undefined) recorded = host.store.effectOutcomeById(run.source_run_id, effectId);
    }
    if (recorded === undefined || recorded.outcome_json === null) {
      throw Object.assign(new Error(`no recorded outcome for (${run.source_run_id}, ${node.id}, ${execution}) — the effect is not performed`), { code: 'replay_source_missing' });
    }
    const outcome = JSON.parse(recorded.outcome_json) as FetchOutcome;
    // The fork's own ledger carries the SOURCE run's attempts for this node as
    // inherited history, so the read projection stays whole-run — and records
    // no attempt the source did not make. Each row keeps the source's attempt
    // number, state and `at`: a replay proves recorded history and MUST NOT
    // regenerate it (replay.md §Suppression rule 1). Until 2026-09-27 this wrote
    // one row stamped `attempt: 1`, `state: completed`, `at: now()`, which read
    // on GET /runs/{fork}/effects as a new attempt the host never made — a
    // re-fire on the host's own ledger (RFC 0173 §C.2, suite 2.42.2).
    for (const src of host.store.effectsForRun(run.source_run_id).filter((e) => e.node_id === node.id && (e.execution ?? 1) === execution)) {
      host.store.claimEffect({ ...src, run_id: run.run_id, invocation_id: `replay-of:${src.run_id}` });
    }
    // A recorded failure replays as the same failure: the outcome is derived, never re-decided.
    if (outcome.error !== undefined) throw err('validation_error', `http.fetch failed in the source run (recorded, not performed): ${outcome.error}`);
    return { outputs: { status: outcome.status, suppressed: true, sourceEffectId: recorded.effect_id }, effectId: recorded.effect_id };
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
    const mirror = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: 1, keying: 'business-identity', state: 'completed', provider_key: providerKey, invocation_id: `deduplicated-of:${done.run_id}`, at: nowIso(), business_key: key, outcome_json: done.outcome_json, execution });
    return { outputs: { ...(JSON.parse(done.outcome_json as string) as FetchOutcome), deduplicated: true }, effectId: mirror.row.effect_id };
  }
  // A LATER execution of this node in the same run (a loop visit, a retry after a
  // terminal failure) is a new logical invocation of the SAME business operation
  // (openwop-examples#132). idempotency.md §"Layer 2": the identity is the business
  // key — no runId, nodeId or ordinal — so it keeps its effectId and provider key,
  // and "a retried node MUST NOT issue a second external effect": an operation that
  // already COMPLETED resolves to that record. One that only FAILED was never
  // performed, so the new execution re-attempts it under the same identity (the
  // provider deduplicates on the key, RFC 0150 §B), on fresh ledger attempts
  // tagged with its own ordinal. Rows of THIS execution mean a re-delivery of it
  // (RFC 0158): its own attempt numbers are reused, so the claims below dedupe it
  // exactly as before — including a failure that execution already recorded.
  const prior = host.store.effectsForRun(run.run_id).filter((e) => e.effect_id === effectId);
  const mine = prior.filter((e) => (e.execution ?? 1) === execution);
  let base = 0;
  if (mine.length > 0) {
    base = Math.min(...mine.map((e) => e.attempt)) - 1;
  } else if (prior.length > 0) {
    const performed = prior.find((e) => e.state === 'completed' && e.outcome_json !== null && (JSON.parse(e.outcome_json) as FetchOutcome).error === undefined);
    if (performed !== undefined) return { outputs: { ...(JSON.parse(performed.outcome_json as string) as FetchOutcome), deduplicated: true }, effectId };
    base = Math.max(...prior.map((e) => e.attempt));
  }
  let outcome: FetchOutcome = { status: 0, error: 'not attempted' };
  let ledgerAttempt = 0;
  for (let i = 0; i <= request.transportRetries; i++) {
    ledgerAttempt = base + i + 1;
    const claim = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: ledgerAttempt, keying: 'business-identity', state: 'claimed', provider_key: providerKey, invocation_id: null, at: nowIso(), business_key: key, outcome_json: null, execution });
    if (!claim.won && claim.row?.outcome_json !== null && claim.row !== undefined) {
      // Another executor already completed this attempt: resolve to its outcome.
      return { outputs: { ...(JSON.parse(claim.row.outcome_json as string) as FetchOutcome), deduplicated: true }, effectId };
    }
    const flightKey = `${effectId}#${ledgerAttempt}`;
    if (!claim.won) {
      // The claim is held and has NO outcome yet. Two very different states
      // share that description, and until RFC 0158's duplicate-delivery row
      // counted this effect at its destination they were handled as one:
      //
      //   - the holder is ALIVE, in this process, mid-request. Firing here is a
      //     double-fire — measured: the same accepted work delivered twice
      //     landed TWO requests on the receiver. Wait for the holder's outcome.
      //   - the holder is a DEAD incarnation that claimed and never recorded.
      //     Whether its request left is unknowable. Taking the attempt over
      //     under the SAME `Idempotency-Key` is the only safe move (RFC 0150
      //     §B: the provider deduplicates), and is what the fall-through below
      //     always did.
      //
      // An in-memory map tells them apart exactly, because a claim this process
      // holds is in it and a dead incarnation's cannot be.
      const holder = inFlight.get(flightKey);
      if (holder !== undefined) return { outputs: { ...(await holder), deduplicated: true }, effectId };
    }
    let settle: (o: FetchOutcome) => void = () => undefined;
    inFlight.set(flightKey, new Promise<FetchOutcome>((resolve) => { settle = resolve; }));
    try {
      const target = validateEgressUrl(request.url, host.config.webhookAllowPrivate);
      // The effect identity IS the provider's idempotency key (RFC 0150 §B).
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': providerKey };
      const r = await guardedRequest(target, { method: request.method, headers, timeoutMs: request.timeoutMs, allowPrivate: host.config.webhookAllowPrivate, ...(request.body === undefined ? {} : { body: request.body }) });
      outcome = r.error === undefined ? { status: r.status } : { status: r.status, error: r.error };
    } catch (e) {
      outcome = { status: 0, error: (e as Error).message };
    }
    // A gateway 5xx (502/503/504) is a transport failure seen through a proxy:
    // a front that loses its upstream connection answers 502 where a direct
    // connection would have reset. Retrying it under the same Idempotency-Key
    // is safe (RFC 0150 §B), and it is what `transportRetries` exists for.
    // Measured: the suite's effect receiver resets the first attempt, and a
    // tunnelled cut turned the reset into a 502 this loop recorded as done —
    // one ledger row where RFC 0173's retry leg needs two.
    const gatewayRetry = outcome.error === undefined && GATEWAY_STATUSES.has(outcome.status) && i < request.transportRetries;
    host.store.updateEffect(run.run_id, effectId, ledgerAttempt, { state: outcome.error === undefined && !gatewayRetry ? 'completed' : 'released', outcome_json: JSON.stringify(outcome) });
    settle(outcome);
    inFlight.delete(flightKey);
    if (outcome.error === undefined && !gatewayRetry) break;
  }
  if (outcome.error !== undefined) throw err('validation_error', `http.fetch failed after ${ledgerAttempt - base} transport attempt(s): ${outcome.error}`);
  return { outputs: { status: outcome.status, attempts: ledgerAttempt - base }, effectId };
}

/** The effectId the source run's n-th execution of `nodeId` completed with: its n-th terminal event, if that is a node.completed naming one. */
function executionEffectId(host: Host, sourceRunId: string, nodeId: string, execution: number): string | undefined {
  const source = host.store.getRun(sourceRunId);
  if (!source) return undefined;
  let terminals = 0;
  for (const e of readEvents(host, source)) {
    if (e.nodeId !== nodeId || (e.type !== 'node.completed' && e.type !== 'node.failed')) continue;
    terminals++;
    if (terminals < execution) continue;
    if (e.type !== 'node.completed') return undefined;
    const id = ((e.payload as { outputs?: { effectId?: unknown } } | null)?.outputs)?.effectId;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function recordAttempt(host: Host, run: RunRow, state: CompensationState): void {
  host.store.updateRun(run.run_id, { compensation_json: JSON.stringify(state) });
  run.compensation_json = JSON.stringify(state);
}

export type EffectRowT = EffectRow;
