/**
 * conversation.md §multiPartyConversation (RFC 0239) — the council roster.
 *
 * A `core.conversationGate` whose config names `participants` and sets
 * `mockAutoResume: false` opens a conversation carrying that roster and
 * suspends on a `conversation.exchange` interrupt the caller resumes with
 * `{ role, speakerId, content }`. A turn whose speaker is off the roster is
 * refused (`conversation_speaker_not_participant`) and the interrupt stays
 * open; a roster over {@link MAX_PARTICIPANTS} is refused at run creation
 * (`conversation_roster_exceeded`), never truncated.
 *
 * Served only when the installed contract registers both codes — a host
 * cannot emit an unregistered code (errors.ts) — and a council fixture is
 * installed, so the family is advertised exactly when it is honoured.
 */
import { loadArtifacts } from './artifacts.js';
import type { Host, WorkflowDefinition, WorkflowNode } from './host.js';
import type { RunRow } from './store.js';

/** The advertised `multiPartyConversation.maxParticipants`. Below the suite's 64-member fixture, so the refusal is witnessed. */
export const MAX_PARTICIPANTS = 8;

export function councilSupported(host: Host): boolean {
  const codes = loadArtifacts().errors;
  if (!codes.has('conversation_speaker_not_participant') || !codes.has('conversation_roster_exceeded')) return false;
  return [...host.workflows.values()].some((d) => d.nodes.some(isCouncilGate));
}

/** A gate the caller drives: a roster, and no conformance mock answering for it. */
export function isCouncilGate(node: WorkflowNode): boolean {
  return node.typeId === 'core.conversationGate' && node.config['mockAutoResume'] === false && rosterOf(node).length > 0;
}

/** The configured roster's agent ids, in order. */
export function rosterOf(node: WorkflowNode): string[] {
  const p = node.config['participants'];
  if (!Array.isArray(p)) return [];
  return p.map((x) => (x !== null && typeof x === 'object' ? (x as { agentId?: unknown }).agentId : x)).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** One conversation per gate per run; the opening and the resolution derive the same id. */
export function conversationIdFor(run: RunRow, nodeId: string): string {
  return `${run.run_id.split('/')[1] ?? run.run_id}:${nodeId}`;
}

/** The first gate whose roster exceeds the ceiling, if any (checked at run creation). */
export function oversizedRoster(def: WorkflowDefinition): { nodeId: string; size: number } | null {
  for (const n of def.nodes) {
    if (n.typeId !== 'core.conversationGate') continue;
    const size = rosterOf(n).length;
    if (size > MAX_PARTICIPANTS) return { nodeId: n.id, size };
  }
  return null;
}
