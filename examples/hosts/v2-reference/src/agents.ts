/**
 * The manifest-agent inventory (RFC 0072 §A, `installScope: "tenant"` per
 * RFC 0074) and the per-agent A2A routing value RFC 0202 publishes it through
 * (`spec/v2/core/interop.md` §"Per-agent cards").
 *
 *   GET /agents             the caller's tenant's installed agents, agentId-sorted
 *   GET /agents/{agentId}   one entry, or 404 — another tenant's agent 404s
 *                           exactly as one that was never installed
 *
 * What this host installs. It executes no third-party pack code and serves no
 * pack-install route for agents, so the agents are the host's own bundled
 * `core.conformance.agent-pack` (conformance/fixtures.md §"The per-agent card
 * pack"): `…resolver` is installed in the default tenant, `…escalator` in the
 * second tenant only (when `OPENWOP_TENANT_B_API_KEY` provisions one). The
 * install map is the only place a tenant meets an agent.
 *
 * Dispatch (RFC 0072 §B) is the run: the host routes ONE workflow to every
 * agent — the workflow its A2A interface routes (`OPENWOP_A2A_WORKFLOW_ID`),
 * because an A2A 1.0 Message carries no skill selector — and a run started
 * through an agent's routing value carries that agent on `RunSnapshot.agent`.
 * There is no model turn: the fixture workflow is what runs.
 *
 * The routing value R (RFC 0202 §B): `ag-` + a keyed MAC of `agentId` and the
 * host version under `OPENWOP_AGENT_CARD_SECRET`. It needs no storage, is the
 * same for every tenant that installed the agent, and encodes no tenant,
 * workspace or principal. It is resolved ONLY within the caller's inventory
 * (`resolveRoutingValue`), after the router authenticated the request.
 *
 * SR-1: the system-prompt body and the handoff schemas below never leave this
 * module — the inventory entry carries `hasHandoffSchemas`, and the card is
 * built from the entry, never from the manifest.
 */
import { createHmac } from 'node:crypto';
import { HOST_VERSION } from './config.js';
import { err } from './errors.js';
import type { Host, Subject } from './host.js';
import { route, type Route } from './router.js';

const PACK_NAME = 'core.conformance.agent-pack';
const PACK_VERSION = '1.0.0';

interface BundledAgent {
  readonly agentId: string;
  readonly persona: string;
  readonly label: string;
  readonly description: string;
  readonly modelClass: 'chat';
  /** Held in-process only (SR-1). The canary is the suite's (fixtures.md). */
  readonly systemPrompt: string;
  readonly handoff: { readonly taskSchema: Record<string, unknown>; readonly returnSchema: Record<string, unknown> };
}

const handoffSchema = (what: string): Record<string, unknown> => ({ type: 'object', description: `OPENWOP-CONFORMANCE-CANARY-0202-HANDOFF ${what}`, additionalProperties: true });

/** The bundled pack's agents[] (agent-manifest.schema.json), keyed by agentId. */
const BUNDLED: ReadonlyMap<string, BundledAgent> = new Map([
  ['core.conformance.agent-pack.resolver', {
    agentId: 'core.conformance.agent-pack.resolver', persona: 'Resolver', label: 'Resolver',
    description: 'Resolves a request by running the approval workflow the host routes to it.', modelClass: 'chat',
    systemPrompt: 'You are the resolver. OPENWOP-CONFORMANCE-CANARY-0202-PROMPT', handoff: { taskSchema: handoffSchema('task'), returnSchema: handoffSchema('return') },
  }],
  ['core.conformance.agent-pack.escalator', {
    agentId: 'core.conformance.agent-pack.escalator', persona: 'Escalator', label: 'Escalator',
    description: 'Escalates a request by running the approval workflow the host routes to it.', modelClass: 'chat',
    systemPrompt: 'You are the escalator. OPENWOP-CONFORMANCE-CANARY-0202-PROMPT', handoff: { taskSchema: handoffSchema('task'), returnSchema: handoffSchema('return') },
  }],
] as const);

/** RFC 0202 — advertised only when the installed contract defines `a2a.agentCards` (2.36.0+). */
export function agentCardsAdvertised(host: Host): boolean {
  return host.artifacts.agentCardsFacet;
}

/** tenant → the agentIds installed there (RFC 0074 `installScope: "tenant"`). */
function installsOf(host: Host, tenant: string): string[] {
  const c = host.config;
  if (tenant === c.tenant) return ['core.conformance.agent-pack.resolver'];
  if (c.tenantBApiKey !== null && tenant === c.tenantB) return ['core.conformance.agent-pack.escalator'];
  return [];
}

/** RFC 0202 §B.2 — stable for the agent and host version; encodes no tenant, workspace or principal. */
export function routingValue(host: Host, agentId: string): string {
  return `ag-${createHmac('sha256', host.config.agentCardSecret).update(`${agentId}\n${HOST_VERSION}`).digest('base64url').slice(0, 22)}`;
}

/** The workflows the host routes to an agent (RFC 0202 §B.3: none ⇒ no `a2aTenant`, no card). */
export function routedWorkflows(host: Host): string[] {
  return host.workflows.has(host.config.a2aWorkflowId) ? [host.config.a2aWorkflowId] : [];
}

export interface InventoryEntry extends Record<string, unknown> {
  agentId: string; persona: string; label: string; description: string; modelClass: string;
  packName: string; packVersion: string; toolAllowlist: string[]; hasHandoffSchemas: boolean; a2aTenant?: string;
}

function entryOf(host: Host, a: BundledAgent): InventoryEntry {
  const e: InventoryEntry = {
    agentId: a.agentId, persona: a.persona, label: a.label, description: a.description, modelClass: a.modelClass,
    packName: PACK_NAME, packVersion: PACK_VERSION, toolAllowlist: [], hasHandoffSchemas: true,
  };
  if (agentCardsAdvertised(host) && routedWorkflows(host).length > 0) e.a2aTenant = routingValue(host, a.agentId);
  return e;
}

export function inventoryFor(host: Host, subject: Subject): InventoryEntry[] {
  return installsOf(host, subject.tenant).map((id) => BUNDLED.get(id)).filter((a): a is BundledAgent => a !== undefined)
    .map((a) => entryOf(host, a)).sort((x, y) => (x.agentId < y.agentId ? -1 : x.agentId > y.agentId ? 1 : 0));
}

/**
 * RFC 0202 §D.6/§D.7 — resolve R within the CALLER'S inventory only. Another
 * tenant's agent and a value never minted both come back null, so every caller
 * of this renders the same refusal for both.
 */
export function resolveRoutingValue(host: Host, subject: Subject, r: string): InventoryEntry | null {
  return inventoryFor(host, subject).find((e) => e.a2aTenant === r) ?? null;
}

/** The AgentRef a run started through R carries on `RunSnapshot.agent` (agent-ref.schema.json). */
export function agentRefOf(e: InventoryEntry): Record<string, unknown> {
  return { agentId: e.agentId, name: e.persona, modelClass: e.modelClass };
}

export function agentRoutes(): Route[] {
  return [
    route('GET', '/agents', true, async (ctx) => {
      if (!agentCardsAdvertised(ctx.host)) throw err('not_found', 'agents.manifestRuntime is not advertised by this host');
      const agents = inventoryFor(ctx.host, ctx.subject!);
      const body = { agents, total: agents.length };
      ctx.host.validate('agent-inventory-response', body, 'GET /agents');
      return { status: 200, body };
    }),
    route('GET', '/agents/{agentId}', true, async (ctx) => {
      if (!agentCardsAdvertised(ctx.host)) throw err('not_found', 'agents.manifestRuntime is not advertised by this host');
      const e = inventoryFor(ctx.host, ctx.subject!).find((x) => x.agentId === ctx.params['agentId']);
      // RFC 0074: an agent the caller's tenant has not installed 404s exactly as one that does not exist.
      if (e === undefined) throw err('not_found', 'no such agent');
      return { status: 200, body: e };
    }),
  ];
}
