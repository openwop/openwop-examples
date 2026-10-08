/**
 * replay.md §Declared nondeterminism (RFC 0237) — the sources this host declares
 * rather than suppresses, and the conformance node that draws from them.
 *
 * `core.conformance.nondeterminism` (fixture `conformance-nondeterminism`) draws one
 * value per listed source and outputs it under the source's name. The draw is
 * recorded where it is read: in the node's own `node.completed` outputs. A `replay`
 * fork does not draw again; it takes the value its source run recorded for the
 * same node and execution, following a chain of replays. A branch draws afresh.
 */
import { randomBytes } from 'node:crypto';
import type { Host, WorkflowNode } from './host.js';
import type { RunRow } from './store.js';
import { readEvents } from './events.js';
import { nowIso } from './ids.js';

export const NONDETERMINISM_TYPE = 'core.conformance.nondeterminism';

/** The listed sources. `env` is not listed: this host reads no configuration during a run. */
export const DECLARED_SOURCES = ['clock', 'random', 'id'] as const;

/** Advertised only when the installed contract seats `nondeterminismPolicy.sources`. */
export function nondeterminismAdvertised(host: Host): boolean {
  return host.artifacts.nondeterminismSourcesFacet;
}

function draw(source: (typeof DECLARED_SOURCES)[number]): string {
  if (source === 'clock') return nowIso();
  if (source === 'random') return randomBytes(16).toString('hex');
  return `nd-${randomBytes(12).toString('hex')}`;
}

/** The outputs the source run (or its own replay source, recursively) recorded for this node's `execution`-th completion. */
function recorded(host: Host, run: RunRow, nodeId: string, execution: number): Record<string, unknown> | null {
  for (let r: RunRow | undefined = run.source_run_id !== null ? host.store.getRun(run.source_run_id) : undefined; r !== undefined;
    r = r.fork_mode === 'replay' && r.source_run_id !== null ? host.store.getRun(r.source_run_id) : undefined) {
    const done = readEvents(host, r).filter((e) => e.type === 'node.completed' && (e.payload as { nodeId?: unknown }).nodeId === nodeId);
    const hit = done[execution - 1];
    if (hit !== undefined) return ((hit.payload as { outputs?: Record<string, unknown> }).outputs) ?? {};
  }
  return null;
}

/** Execute the reserved node: replay the recorded draw on a `replay` fork, else draw and record. */
export function runNondeterminism(host: Host, run: RunRow, node: WorkflowNode, execution: number): Record<string, unknown> | { missing: true } {
  if (run.fork_mode === 'replay') {
    const prior = recorded(host, run, node.id, execution);
    if (prior === null) return { missing: true };
    return Object.fromEntries(DECLARED_SOURCES.map((s) => [s, prior[s]]));
  }
  return Object.fromEntries(DECLARED_SOURCES.map((s) => [s, draw(s)]));
}
