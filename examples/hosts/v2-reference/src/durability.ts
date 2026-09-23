/**
 * RFC 0158 — the `durable-single-instance` exercises, as a NON-NORMATIVE
 * host-extension seam (`host-extensions.md`; RFC 0158 §E). It advertises
 * nothing: §E.10 mints no capability field, and a host that never runs the
 * exercises mounts no such route — which is how this host says, by default,
 * that it claims no rung.
 *
 *   GET  /host/durability/kill    the PROBE. Answers without firing.
 *   POST /host/durability/kill    { mode } — after-accept | during-execution | duplicate-delivery
 *   GET  /host/durability/bound   { bound, terms[] } — the recovery bound, derived
 *
 * ── The gate (§E item 12) ─────────────────────────────────────────────────────
 * Mounted only when BOTH `OPENWOP_SEAMS_PROFILE` and `OPENWOP_DURABILITY_SEAM`
 * are set at boot. Item 12 warns against minting a second flag because "one
 * gets set in a context the other does not". That hazard is a second flag that
 * can OPEN the seam alone; this one can only narrow it. It exists because the
 * seams profile defaults ON for this reference host, and a default-on flag
 * cannot be the sole gate of a route that terminates the process — item 12's
 * other clause is that the seam is unset in production and FAIL-CLOSED. Both
 * are read once, at boot: a per-request toggle would be a denial-of-service
 * surface. Unset ⇒ 404 on every verb, so the suite records `inapplicable`.
 *
 * ── What is seam and what is host ─────────────────────────────────────────────
 * The seam does exactly three things production code does not: it HOLDS
 * dispatch, it KILLS the process, and it delivers accepted work TWICE. It does
 * not recover anything. Acceptance is `acceptRun` (runs.ts) — the function
 * `POST /runs` calls. Recovery is `recoverInFlightRuns` below, which `startHost`
 * runs on every boot whether or not this seam is mounted. The effect fired under
 * duplicate delivery goes through `performHttpFetch` and the egress guard. So
 * every assertion the suite makes lands on production code; GOVERNANCE.md's
 * seam rule ("a PRECONDITION, not the path being asserted on") holds.
 *
 * The death is `SIGKILL` to this process — no handler runs, no `finally`, no
 * flush. §D.9: a rung MUST NOT be claimed on tests "in which no process was
 * actually terminated". Something else must restart it: scripts/supervisor.mjs.
 */
import { err } from './errors.js';
import { appendEvent, readEvents } from './events.js';
import { continueRun, scheduleRun } from './executor.js';
import { ENGINE_VERSION } from './config.js';
import { acceptRun } from './runs.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import type { AppendedEvent, Host } from './host.js';

const MODES = ['after-accept', 'during-execution', 'duplicate-delivery'] as const;
type Mode = (typeof MODES)[number];
const NOOP = 'conformance-noop';
const EFFECTFUL = 'conformance-http-effect';

export function durabilitySeamMounted(host: Host): boolean {
  return host.config.seamsProfile && host.config.durabilitySeam;
}

/**
 * The recovery bound, as ARITHMETIC a reader can recompute (§E, Unresolved
 * Question 1: per-term, not a single total). This host has one recovery class:
 * a single process that re-enters every in-flight run at boot, before the
 * listener opens. So the interval from a death to the work being eligible to
 * resume is the restart delay plus the boot re-entry — and the first term is
 * NOT this process's to enforce. It is the operator's supervisor, declared as
 * an operator term rather than absorbed into a number that looks intrinsic.
 *
 * `bound-is-derived` is a paper check by construction and the RFC says so: it
 * shows the number follows from the mechanism, not that the mechanism runs.
 * Only the kill rows witness that. `lastBootReentryMs` is reported so a boot
 * that blew its own budget is visible here rather than merely undetected.
 */
/**
 * This host's ONE recovery class. The bound response and both kill responses name
 * it with the same constant, because suite 2.34.0 publishes the rung in the
 * bundle only when each kill row's class names a DECLARED entry (RFC 0158 §E):
 * a bound that does not say which class it governs cannot be bound to the
 * exercise that was judged against it.
 */
export const RECOVERY_CLASS = 'single-instance-restart';

export function recoveryBound(host: Host): { class: string; bound: number; terms: Array<{ name: string; ms: number; enforcedBy: string }>; lastBootReentryMs: number | null; bootReentryWithinBudget: boolean | null } {
  const terms = [
    { name: 'supervisor.restartDelay', ms: host.config.supervisorRestartMs, enforcedBy: 'OPERATOR — the restart supervisor (scripts/supervisor.mjs); declared via OPENWOP_SUPERVISOR_RESTART_MS, not enforceable from inside the process it restarts' },
    { name: 'boot.reentryBudget', ms: host.config.bootReentryBudgetMs, enforcedBy: 'recoverInFlightRuns() — every non-terminal run is re-entered at boot, before the listener opens; the measured duration is reported beside this budget' },
  ];
  return { class: RECOVERY_CLASS, bound: terms.reduce((a, t) => a + t.ms, 0), terms, lastBootReentryMs, bootReentryWithinBudget: lastBootReentryMs === null ? null : lastBootReentryMs <= host.config.bootReentryBudgetMs };
}

let lastBootReentryMs: number | null = null;

/**
 * PRODUCTION CODE, run on every boot. Runs a previous process left non-terminal
 * re-enter the loop. A run that had already started is recorded as recovered
 * with the event the registry minted for exactly this — `workflow.restored`,
 * "an in-flight run is recovered from the event log on a fresh engine boot".
 * Until RFC 0158 this host re-entered such runs SILENTLY: the log of a run that
 * survived a crash was indistinguishable from one that never saw one, so
 * neither an operator nor a witness could tell recovery had happened.
 * A run accepted but never dispatched has nothing to restore; its first
 * `run.started` is the record.
 */
export function recoverInFlightRuns(host: Host): number {
  const t0 = Date.now();
  let recovered = 0;
  for (const r of host.store.nonTerminalRuns()) {
    if ((r.era ?? 2) < 3 || !(r.status === 'running' || r.status === 'pending' || r.status === 'cancelling')) continue;
    const log = readEvents(host, r);
    if (log.some((e) => e.type === 'run.started')) {
      appendEvent(host, r, 'workflow.restored', { fromSnapshotSeq: log.length === 0 ? 0 : Math.max(...log.map((e) => e.sequence)), engineVersion: ENGINE_VERSION });
    }
    scheduleRun(host, r.run_id);
    recovered++;
  }
  lastBootReentryMs = Date.now() - t0;
  if (lastBootReentryMs > host.config.bootReentryBudgetMs) {
    process.stderr.write(`[durability] boot re-entry took ${lastBootReentryMs}ms, over its declared ${host.config.bootReentryBudgetMs}ms budget — the recovery bound this host states was NOT produced on this boot\n`);
  }
  return recovered;
}

/** A real death. No handler runs; nothing is flushed that SQLite has not already committed. */
function die(): never {
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL is delivered asynchronously on some platforms; never let a caller continue past the kill point.
  for (;;) { /* unreachable once the signal lands */ }
}

async function probe(): Promise<Reply> {
  return { status: 200, body: { seam: 'rfc-0158-durability', modes: MODES, firesOn: 'POST' } };
}

async function bound(ctx: Ctx): Promise<Reply> {
  return { status: 200, body: recoveryBound(ctx.host) };
}

async function kill(ctx: Ctx): Promise<Reply> {
  const body = await ctx.json<{ mode?: unknown; workflowId?: unknown; effectUrl?: unknown }>();
  for (const k of Object.keys(body)) if (!['mode', 'workflowId', 'effectUrl'].includes(k)) throw err('validation_error', `unknown key ${k}`);
  if (typeof body.mode !== 'string' || !(MODES as readonly string[]).includes(body.mode)) throw err('validation_error', `mode is one of ${MODES.join(' | ')}`);
  const mode = body.mode as Mode;
  const subject = ctx.subject;
  if (subject === null) throw err('unauthenticated', 'the durability seam needs a credential');
  const host = ctx.host;
  const recoveryBoundMs = recoveryBound(host).bound;

  if (mode === 'duplicate-delivery') {
    // The suite counts the effect WHERE IT LANDS, so the staged work's one
    // outbound effect is addressed to the receiver it names. The request goes
    // through performHttpFetch and the egress guard — the code under test.
    if (typeof body.effectUrl !== 'string' || body.effectUrl.length === 0) throw err('validation_error', 'mode=duplicate-delivery needs effectUrl — the destination the one staged effect is counted at');
    const def = host.workflows.get(EFFECTFUL);
    if (!def) throw err('not_found', `${EFFECTFUL} is not registered`);
    // The raised timeout is NOT a fix for the zero-arrivals failure this row saw
    // on 2026-09-23 — that cause is still unknown, and a slow response provably
    // still lands (measured). It removes a DIFFERENT false report: a receiver
    // slower than the ceiling makes the node throw for an effect that arrived.
    //
    // `transportRetries` STAYS 0 and the timeout is raised instead. A retry would
    // re-POST under the same `Idempotency-Key`, which the ledger deduplicates —
    // but the suite counts ARRIVALS at its receiver, not deduplicated effects, so
    // a retry after a response that was merely slow (not lost) would land a
    // SECOND arrival and fail the row for two. Turning a false negative into a
    // false positive is a worse trade. A longer single attempt removes the
    // failure without adding a way to double-count.
    const run = acceptRun(host, subject, EFFECTFUL, { url: body.effectUrl, transportRetries: 0, timeoutMs: 20_000 }, {}, null);
    // Delivered TWICE, to the executor's own entry point and concurrently —
    // BELOW `scheduleRun`'s in-process one-loop-per-run guard, which would
    // otherwise absorb the second delivery before it reached anything worth
    // testing. What must hold the line is the effect ledger's claim.
    const deliveries = [continueRun(host, run.run_id), continueRun(host, run.run_id)];
    void Promise.allSettled(deliveries).then((settled) => {
      for (const s of settled) if (s.status === 'rejected') process.stderr.write(`[durability] duplicate delivery: ${String((s.reason as Error)?.message ?? s.reason)}\n`);
    });
    return { status: 202, body: { runId: run.run_id, mode, deliveries: deliveries.length } };
  }

  const workflowId = typeof body.workflowId === 'string' ? body.workflowId : NOOP;
  if (!host.workflows.get(workflowId)) throw err('not_found', `workflow ${workflowId} is not registered on this host`, { workflowId });
  const run = acceptRun(host, subject, workflowId, {}, {}, null);

  if (mode === 'after-accept') {
    // HOLD-DISPATCH (§E item 11): the run is durably accepted and `scheduleRun`
    // is never called. The kill lands once the response — which carries the
    // runId the suite follows across the death — has been flushed.
    ctx.res.once('finish', () => die());
    return { status: 202, body: { runId: run.run_id, mode, recoveryClass: RECOVERY_CLASS, recoveryBoundMs } };
  }

  // during-execution: dispatch for real, and die at the run's first
  // `node.started` — AFTER `run.started` and AFTER the status write to
  // `running`, i.e. once this host's execution claim on the run is held. Dying
  // at `run.started` would witness the easy class (accepted, never claimed)
  // under the hard one's name. `appendEvent` has committed the row before it
  // emits, so the log the next boot reads shows a node that started and never
  // finished.
  ctx.res.once('finish', () => {
    host.bus.on(`run:${run.run_id}`, (a: AppendedEvent) => { if (a.doc.type === 'node.started') die(); });
    scheduleRun(host, run.run_id);
  });
  return { status: 202, body: { runId: run.run_id, mode, recoveryClass: RECOVERY_CLASS, recoveryBoundMs } };
}

export function durabilityRoutes(host: Host): Route[] {
  if (!durabilitySeamMounted(host)) return [];
  return [
    route('GET', '/host/durability/kill', true, probe, 2),
    route('POST', '/host/durability/kill', true, kill, 2),
    route('GET', '/host/durability/bound', true, bound, 2),
  ];
}
