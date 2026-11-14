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
 *     plan over completed nodes that declare a compensation — node-level
 *     `compensation` (workflow-definition.schema.json `WorkflowNode.compensation`,
 *     RFC 0151 §B) or the legacy `config.compensation` — unwound when the run
 *     fails; GET /runs/{runId}/compensation projects plan + attempts. A node-level
 *     inverse of `core.conformance.compensable-effect` (RFC 0265) is PERFORMED and
 *     ledgered; a legacy declaration stays a recorded no-op.
 */
import { createHash } from 'node:crypto';
import { HOST_NAME } from './config.js';
import { guardedRequest, validateEgressUrl } from './egress.js';
import { err } from './errors.js';
import { readEvents } from './events.js';
import { nowIso, opaque } from './ids.js';
import type { Host, NodeCompensation, WorkflowNode } from './host.js';
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

/**
 * Reverse-completion plan over the completed nodes that declare a compensation (RFC 0151 §A):
 * node-level `compensation` (the v2 schema's home for it) or the legacy `config.compensation`,
 * which only the host's own `conformance-http-effect` workflow still uses. `irreversibleEffect`
 * is a legacy-form key; node-level `compensation` is closed and carries none.
 */
export function buildCompensationPlan(nodes: readonly WorkflowNode[], completedInOrder: readonly string[]): CompensationState['plan'] {
  const declared = new Map(nodes.filter((n) => n.compensation !== undefined || n.config['compensation'] !== undefined).map((n) => [n.id, n] as const));
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

export interface FetchOutcome { status: number; error?: string; suppressed?: boolean; /** the host's own egress guard refused the request (it never left) */ denied?: true }

/**
 * The registered code a failed fetch fails its node with (RFC 0228): the host's
 * egress guard refusing the destination is `egress_denied`; any other failure to
 * get an answer from the fetch target is `upstream_unavailable`.
 */
export function fetchFailureCode(outcome: FetchOutcome): 'egress_denied' | 'upstream_unavailable' {
  return outcome.denied === true ? 'egress_denied' : 'upstream_unavailable';
}

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

  if (run.fork_mode === 'replay' && run.source_run_id !== null) return replayRecordedEffect(host, run, node, execution, 'http.fetch');

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
      outcome = r.error === undefined ? { status: r.status } : { status: r.status, error: r.error, ...(r.error.startsWith('egress denied') ? { denied: true as const } : {}) };
    } catch (e) {
      const refused = (e as { code?: unknown }).code === 'webhook_url_rejected';
      outcome = { status: 0, error: (e as Error).message, ...(refused ? { denied: true as const } : {}) };
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
  if (outcome.error !== undefined) throw Object.assign(new Error(`http.fetch failed after ${ledgerAttempt - base} transport attempt(s): ${outcome.error}`), { code: fetchFailureCode(outcome) });
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

/**
 * replay.md §Suppression: a replay fork never performs a side effect. Execution n
 * of a side-effecting node resolves from the SOURCE run's recorded terminal
 * outcome for (sourceRunId, nodeId, n) — or fails closed with
 * replay_source_missing when the source recorded none (rule 3). Shared by every
 * side-effecting node this host runs (core.httpFetch, core.conformance.side-effect).
 */
export function replayRecordedEffect(host: Host, run: RunRow, node: WorkflowNode, execution: number, label: string): { outputs: Record<string, unknown>; effectId: string } {
  const sourceRunId = run.source_run_id as string;
  let recorded = host.store.effectOutcome(sourceRunId, node.id, execution);
  if (recorded === undefined) {
    // Execution n recorded no row of its own when it resolved to an earlier
    // execution's record of the same business identity; its node.completed names that effect.
    const effectId = executionEffectId(host, sourceRunId, node.id, execution);
    if (effectId !== undefined) recorded = host.store.effectOutcomeById(sourceRunId, effectId);
  }
  if (recorded === undefined || recorded.outcome_json === null) {
    throw Object.assign(new Error(`no recorded outcome for (${sourceRunId}, ${node.id}, ${execution}) — the effect is not performed`), { code: 'replay_source_missing' });
  }
  const outcome = JSON.parse(recorded.outcome_json) as FetchOutcome;
  // The fork's own ledger carries the SOURCE run's attempts for this execution as
  // inherited history, so the read projection stays whole-run — and records no
  // attempt the source did not make. Each row keeps the source's attempt number,
  // state and `at`: a replay proves recorded history and MUST NOT regenerate it
  // (replay.md §Suppression rule 1; RFC 0173 §C.2, suite 2.42.2).
  // An inverse row (RFC 0265) carries its forward's node and ordinal but is not the
  // forward's history: the fork's own unwind resolves it (performCompensationInverse).
  for (const src of host.store.effectsForRun(sourceRunId).filter((e) => e.node_id === node.id && (e.execution ?? 1) === execution && !isInverseRow(e))) {
    host.store.claimEffect({ ...src, run_id: run.run_id, invocation_id: `replay-of:${src.run_id}` });
  }
  // A recorded failure replays as the same failure: the outcome is derived, never re-decided.
  if (outcome.error !== undefined) throw Object.assign(new Error(`${label} failed in the source run (recorded, not performed): ${outcome.error}`), { code: fetchFailureCode(outcome) });
  return { outputs: { status: outcome.status, suppressed: true, sourceEffectId: recorded.effect_id }, effectId: recorded.effect_id };
}

/**
 * core.conformance.side-effect — the conformance-RESERVED side-effecting typeId
 * (fixtures.md §conformance-replay-side-effect): what matters is that the replay
 * classifier treats it as side-effecting, not what the effect is. Live, it
 * performs nothing outside the host but records one ledger row per execution,
 * keyed by the activity recipe (tenant, run, node, ordinal — idempotency.md: the
 * fallback when there is no business key), so each execution has its own
 * recorded outcome. In a replay it resolves execution n from the source or fails
 * closed. A re-delivery of the same execution resolves to its row.
 */
export function performConformanceSideEffect(host: Host, run: RunRow, node: WorkflowNode, execution: number): { outputs: Record<string, unknown>; effectId: string } {
  if (run.fork_mode === 'replay' && run.source_run_id !== null) return replayRecordedEffect(host, run, node, execution, 'core.conformance.side-effect');
  const recipe = `${run.tenant}|${run.run_id}|${node.id}|${execution}`;
  const effectId = `${run.tenant}/se-${createHash('sha256').update(recipe).digest('base64url').slice(0, 22)}`;
  const outcome: FetchOutcome = { status: 200 };
  const claim = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: 1, keying: 'activity-recipe', state: 'completed', provider_key: null, invocation_id: null, at: nowIso(), business_key: recipe, outcome_json: JSON.stringify(outcome), execution });
  return { outputs: { status: outcome.status, effectId, ...(claim.won ? {} : { deduplicated: true }) }, effectId };
}

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * core.conformance.compensable-effect — the conformance-RESERVED compensable typeId
 * (RFC 0265 §A; fixtures.md §"The compensate-unwind fixture"). A host that serves
 * `conformance-compensate-unwind` MUST record it on the Layer-2 ledger as exactly one
 * effect per execution, forward and inverse alike, and MUST run it as the inverse
 * action when its resolved inputs carry `inverse: true`. What the effect does is
 * irrelevant; like core.conformance.side-effect it performs nothing outside the host.
 */
export const COMPENSABLE_EFFECT_TYPE = 'core.conformance.compensable-effect';

/**
 * The business-key prefix of an INVERSE ledger row. The inverse is its own effect
 * (its own effectId, its own record) but is attributed to the forward node's id, so
 * the readers keyed (runId, nodeId, execution) — store.effectOutcome and the replay
 * copy above — must tell it from the forward record. `#` is outside the tenant
 * alphabet (ids.schema.json `tenantId`) and the hex of a business-identity key, so no
 * forward key can carry the prefix.
 */
const INVERSE_KEY_PREFIX = 'inverse#';
export function isInverseRow(e: EffectRow): boolean {
  return e.business_key.startsWith(INVERSE_KEY_PREFIX);
}

/**
 * The forward execution of `core.conformance.compensable-effect`: one activity-recipe
 * ledger row per execution, exactly as core.conformance.side-effect records (the
 * effect id differs only in its `ce-` prefix). In a replay it resolves execution n
 * from the source run's record or fails closed (replay.md §Suppression).
 */
export function performCompensableEffect(host: Host, run: RunRow, node: WorkflowNode, execution: number): { outputs: Record<string, unknown>; effectId: string } {
  if (run.fork_mode === 'replay' && run.source_run_id !== null) return replayRecordedEffect(host, run, node, execution, COMPENSABLE_EFFECT_TYPE);
  const recipe = `${run.tenant}|${run.run_id}|${node.id}|${execution}`;
  const effectId = `${run.tenant}/ce-${createHash('sha256').update(recipe).digest('base64url').slice(0, 22)}`;
  const outcome: FetchOutcome = { status: 200 };
  const claim = host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: node.id, attempt: 1, keying: 'activity-recipe', state: 'completed', provider_key: null, invocation_id: null, at: nowIso(), business_key: recipe, outcome_json: JSON.stringify(outcome), execution });
  return { outputs: { status: outcome.status, effectId, ...(claim.won ? {} : { deduplicated: true }) }, effectId };
}

/**
 * The forward record an inverse undoes: the node's latest forward row in this run's
 * ledger, else in its source's (a fork whose inherited prefix covered the node holds
 * no row of its own for it — the source performed it).
 */
function forwardRecord(host: Host, run: RunRow, nodeId: string): EffectRow | undefined {
  for (let r: RunRow | undefined = run; r !== undefined; r = r.source_run_id === null ? undefined : host.store.getRun(r.source_run_id)) {
    const rows = host.store.effectsForRun(r.run_id).filter((e) => e.node_id === nodeId && !isInverseRow(e) && e.state === 'completed');
    const latest = rows.sort((a, b) => (a.execution ?? 1) - (b.execution ?? 1) || Date.parse(a.at) - Date.parse(b.at)).at(-1);
    if (latest !== undefined) return latest;
  }
  return undefined;
}

/** An instant strictly after `iso`: the inverse is recorded after the effect it undoes, even inside one millisecond. */
function strictlyAfter(iso: string): string {
  return new Date(Math.max(Date.now(), Date.parse(iso) + 1)).toISOString();
}

export interface InverseOutcome { outcome: 'succeeded' | 'failed'; reason?: string; effectId?: string }

/**
 * One inverse action of a compensation plan step (RFC 0265 §A; RFC 0151 §B): node-level
 * `compensation.nodeTypeId` run with the resolved `inputMapping` as its inputs. Only
 * `core.conformance.compensable-effect` with `inverse: true` is executable here.
 *
 * Identity. The inverse is a SEPARATE effect with its own id, derived from the forward
 * record's effectId (`inverse#<forwardEffectId>`), so one forward effect has exactly one
 * inverse identity however often an unwind reaches it — a re-delivery of the same unwind
 * dedupes on the ledger claim. The row carries the forward node's id and ordinal, and an
 * `at` strictly after the forward's, which is what lets a reader attribute it by
 * elimination (the suite's `splitLedger`: a node's earliest row is the forward).
 *
 * Replay (replay.md §Suppression; invariant compensation-replay-no-refire). A replay
 * fork that fails and unwinds again performs NO inverse: it resolves the source run's
 * recorded inverse for the same forward identity and copies the source's row verbatim
 * (attempt, state, `at`) as inherited history, exactly as replayRecordedEffect does for
 * forward effects — so the fork's ledger holds no row the source never made. Absent a
 * recorded inverse, the step fails closed with `replay_source_missing`, recording nothing.
 */
export function performCompensationInverse(host: Host, run: RunRow, nodeId: string, compensation: NodeCompensation): InverseOutcome {
  // inputMapping derives from recorded facts only (workflow-definition.schema.json); the
  // fixture's mapping is the literal `{ inverse: true }`, so its values are the inputs.
  const inputs = compensation.inputMapping ?? {};
  if (compensation.nodeTypeId !== COMPENSABLE_EFFECT_TYPE) return { outcome: 'failed', reason: `capability_not_provided: ${compensation.nodeTypeId} is not executed as an inverse by this host` };
  if (inputs['inverse'] !== true) return { outcome: 'failed', reason: 'node_config_invalid: an inverse of core.conformance.compensable-effect carries inputs.inverse: true' };
  const forward = forwardRecord(host, run, nodeId);
  if (forward === undefined) return { outcome: 'failed', reason: `no forward effect is recorded for ${nodeId}, so there is nothing to invert` };
  const key = `${INVERSE_KEY_PREFIX}${forward.effect_id}`;
  if (run.fork_mode === 'replay' && run.source_run_id !== null) {
    const recorded = host.store.effectsForRun(run.source_run_id).filter((e) => e.business_key === key);
    const last = recorded.at(-1);
    if (last === undefined || last.outcome_json === null) return { outcome: 'failed', reason: `replay_source_missing: the source run recorded no inverse of ${forward.effect_id} — the inverse is not performed` };
    for (const src of recorded) host.store.claimEffect({ ...src, run_id: run.run_id, invocation_id: `replay-of:${src.run_id}` });
    const o = JSON.parse(last.outcome_json) as FetchOutcome;
    return o.error === undefined ? { outcome: 'succeeded', effectId: last.effect_id } : { outcome: 'failed', reason: `recorded, not performed: ${o.error}`, effectId: last.effect_id };
  }
  const effectId = `${run.tenant}/ci-${createHash('sha256').update(key).digest('base64url').slice(0, 22)}`;
  // A forward effect another run already compensated (a branch whose inherited prefix
  // covered the node) resolves to that inverse rather than undoing the effect twice.
  const done = host.store.completedEffect(key);
  if (done !== undefined && done.run_id !== run.run_id) {
    host.store.claimEffect({ ...done, run_id: run.run_id, at: nowIso(), invocation_id: `deduplicated-of:${done.run_id}` });
    return { outcome: 'succeeded', effectId: done.effect_id };
  }
  const outcome: FetchOutcome = { status: 200 };
  host.store.claimEffect({ effect_id: effectId, run_id: run.run_id, node_id: nodeId, attempt: 1, keying: 'activity-recipe', state: 'completed', provider_key: null, invocation_id: null, at: strictlyAfter(forward.at), business_key: key, outcome_json: JSON.stringify(outcome), execution: forward.execution ?? 1 });
  return { outcome: 'succeeded', effectId };
}

export function recordAttempt(host: Host, run: RunRow, state: CompensationState): void {
  host.store.updateRun(run.run_id, { compensation_json: JSON.stringify(state) });
  run.compensation_json = JSON.stringify(state);
}

export type EffectRowT = EffectRow;
