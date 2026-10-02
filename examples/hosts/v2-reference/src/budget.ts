/**
 * runs.md §`budget` section — the run budget, for the one dimension this host
 * enforces: `toolCalls`.
 *
 * The policy rides on `createRun` (`configurable.budget`). Consumption is
 * derived from the log: every `agent.tool-called` event counts once, so a
 * restart, a fork and a replay all read the same number and nothing is
 * measured twice.
 *
 * What this host does NOT do, and says so:
 *   - `tokens`, `cost`, `retries` and `model` are not in `budget.dimensions`:
 *     the host calls no model and retries no node, so it has nothing to count.
 *     Limits on them are accepted and never enforced.
 *   - `onExhaustion: "interrupt"` is refused at create (`budgetRefusal`). The
 *     host does not raise an approval that extends a budget.
 */

import { appendEvent, readEvents } from './events.js';
import type { Host } from './host.js';
import type { RunRow } from './store.js';

export const BUDGET_DIMENSIONS = ['toolCalls'] as const;
const DIMENSION = 'toolCalls';
const CAP_KIND = 'budget-tool-calls';
const DEFAULT_THRESHOLD_PERCENT = 80;
const POLICY_KEYS = new Set(['maxTokens', 'maxCostUsd', 'maxToolCalls', 'maxRetries', 'modelAllow', 'modelDeny', 'thresholdPercent', 'onExhaustion']);

export interface BudgetPolicy { readonly maxToolCalls?: number; readonly thresholdPercent: number }

/** Raised when the next tool call does not fit; the executor fails the run with it. */
export class BudgetExhausted extends Error {
  constructor(readonly limit: number, readonly observed: number) { super(`the run's budget allows ${limit} tool call(s); call ${observed} does not fit`); }
}

/** Why a `configurable.budget` cannot be honoured, as `[code, message, path]`, or `null`. */
export function budgetRefusal(budget: unknown): readonly [string, string, string] | null {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) return ['validation_error', 'configurable.budget MUST be an object', 'configurable.budget'];
  const b = budget as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!POLICY_KEYS.has(k)) return ['validation_error', `unknown key ${k} in configurable.budget (closed schema)`, `configurable.budget.${k}`];
  const max = b['maxToolCalls'];
  if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1)) return ['validation_error', 'budget.maxToolCalls MUST be an integer of at least 1', 'configurable.budget.maxToolCalls'];
  const pct = b['thresholdPercent'];
  if (pct !== undefined && (typeof pct !== 'number' || pct < 0 || pct > 100)) return ['validation_error', 'budget.thresholdPercent MUST be between 0 and 100', 'configurable.budget.thresholdPercent'];
  const on = b['onExhaustion'];
  if (on !== undefined && on !== 'fail' && on !== 'interrupt') return ['validation_error', 'budget.onExhaustion MUST be fail or interrupt', 'configurable.budget.onExhaustion'];
  if (on === 'interrupt') return ['capability_not_provided', 'this host does not raise a budget-extending approval; onExhaustion: interrupt is not served', 'configurable.budget.onExhaustion'];
  return null;
}

function policyOf(run: RunRow): BudgetPolicy | null {
  const options = JSON.parse(run.options_json) as { configurable?: { budget?: Record<string, unknown> } };
  const b = options.configurable?.budget;
  if (b === undefined || b === null || typeof b !== 'object') return null;
  const max = b['maxToolCalls'];
  const pct = b['thresholdPercent'];
  return { ...(typeof max === 'number' ? { maxToolCalls: max } : {}), thresholdPercent: typeof pct === 'number' ? pct : DEFAULT_THRESHOLD_PERCENT };
}

/** `budget.reserved`, once, right after `run.started`: the budget the host will enforce. */
export function reserveBudget(host: Host, run: RunRow): void {
  const policy = policyOf(run);
  if (policy === null) return;
  const effectiveBudget: Record<string, unknown> = { thresholdPercent: policy.thresholdPercent, onExhaustion: 'fail' };
  if (policy.maxToolCalls !== undefined) effectiveBudget['maxToolCalls'] = policy.maxToolCalls;
  appendEvent(host, run, 'budget.reserved', { effectiveBudget, scope: 'run' });
}

/**
 * Before a tool call. Throws {@link BudgetExhausted} when the call does not
 * fit, after recording `budget.exhausted` and `cap.breached`. Exhaustion is
 * "the next call would exceed", so a run that spends exactly its budget ends
 * normally.
 */
export function beforeToolCall(host: Host, run: RunRow, nodeId: string): void {
  const limit = policyOf(run)?.maxToolCalls;
  if (limit === undefined) return;
  const consumed = readEvents(host, run).filter((e) => e.type === 'agent.tool-called').length;
  if (consumed < limit) return;
  appendEvent(host, run, 'budget.exhausted', { dimension: DIMENSION, consumed, limit }, { nodeId });
  appendEvent(host, run, 'cap.breached', { kind: CAP_KIND, limit, observed: consumed + 1, nodeId }, { nodeId });
  throw new BudgetExhausted(limit, consumed + 1);
}

/** After a tool call was recorded: `budget.consumed`, and the threshold once. */
export function afterToolCall(host: Host, run: RunRow, nodeId: string): void {
  const policy = policyOf(run);
  const limit = policy?.maxToolCalls;
  if (policy === null || limit === undefined) return;
  const log = readEvents(host, run);
  const consumed = log.filter((e) => e.type === 'agent.tool-called').length;
  appendEvent(host, run, 'budget.consumed', { dimension: DIMENSION, consumed, limit, remaining: Math.max(0, limit - consumed) }, { nodeId });
  const crossed = log.some((e) => e.type === 'budget.threshold-crossed' && (e.payload as { dimension?: unknown } | null)?.dimension === DIMENSION);
  if (!crossed && (consumed / limit) * 100 >= policy.thresholdPercent) {
    appendEvent(host, run, 'budget.threshold-crossed', { dimension: DIMENSION, consumed, limit, percent: policy.thresholdPercent }, { nodeId });
  }
}
