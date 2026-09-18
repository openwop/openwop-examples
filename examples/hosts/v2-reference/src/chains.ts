/**
 * `workflow-chain-packs.md` — registering a chain pack, expanding its
 * sub-chains, and the four rules that make an expansion reproducible.
 *
 * A host that advertises `workflowChainPacks` owes all of this, not just the
 * pin check the suite can see:
 *
 *   §Exact pins       every reference pins an exact version; a range or a bare
 *                     typeId is REFUSED at register.
 *   §Co-registered    a child is registered under a DETERMINISTIC id, so two
 *     children        parents composing the same child share one registration;
 *                     each parent is counted; the child is deleted when its
 *                     last parent is; and the parent's ownership record
 *                     persists the RESOLVED child version, so a
 *                     re-instantiation or `:fork` reproduces the same child.
 *   §Parameters       `{{params.<name>}}` is substituted at expansion time. A
 *                     persisted definition MUST NOT contain one — this host
 *                     asserts that after substitution rather than trusting it.
 *   §Depth            nesting is bounded by `subChains.maxDepth` (default 8);
 *                     exceeding it, or composing yourself transitively, fails
 *                     closed. The depth check and the cycle check are ONE
 *                     guard, because a cycle is only observable as depth.
 *   §Edge conditions  `condition` and `triggerRule` are carried through
 *                     expansion verbatim.
 */
import { createHash } from 'node:crypto';
import { err } from './errors.js';
import type { Host, WorkflowDefinition } from './host.js';

/** `core.ai.callPrompt@1.0.0` — the only reference spelling v2.0 admits (§Exact pins). The advertised `subChains.maxDepth` lives in config, so the advert and the guard cannot drift. */
const PINNED_REF = /^[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+@[0-9]+\.[0-9]+\.[0-9]+$/;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PARAM_TOKEN = /\{\{\s*params\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

interface ChainNode { id?: unknown; typeId?: unknown; config?: unknown }
interface ChainDag { nodes?: unknown; edges?: unknown }
interface Chain { chainId?: unknown; version?: unknown; dag?: unknown; subChains?: unknown; parameters?: unknown }

/**
 * §Exact pins. Every node reference and every `subChainRef` MUST carry
 * `@<exact>`; a range (`@^1`) and a bare id are both refused, and the refusal
 * says which reference so the author can fix it without bisecting the manifest.
 */
export function assertExactPins(manifest: Record<string, unknown>): void {
  const chains = Array.isArray(manifest['chains']) ? (manifest['chains'] as Chain[]) : [];
  for (const chain of chains) {
    const dag = (chain.dag ?? {}) as ChainDag;
    const nodes = Array.isArray(dag.nodes) ? (dag.nodes as ChainNode[]) : [];
    for (const n of nodes) {
      const ref = typeof n.typeId === 'string' ? n.typeId : '';
      if (!PINNED_REF.test(ref)) {
        throw err('pack_validation_failed', `chain ${String(chain.chainId)} node ${String(n.id)} references ${JSON.stringify(ref)} — every reference MUST pin an exact version (core.ai.callPrompt@1.0.0); a range or a bare typeId is not a v2.0 spelling (workflow-chain-packs.md §Exact pins)`, { reason: 'chain_reference_unpinned', chainId: String(chain.chainId ?? ''), reference: ref });
      }
    }
    // A SIBLING subChain ref is a bare `chainId` by schema (`SubChainRef.ref`
    // oneOf[0] admits no `@`), so §Exact pins binds it through the sibling it
    // names, which is pinned in this same manifest. Only the EXTERNAL object
    // form carries a version of its own, and that is where the pin is checked.
    for (const s of (Array.isArray(chain.subChains) ? (chain.subChains as Array<{ ref?: unknown }>) : [])) {
      const ref = s.ref;
      if (typeof ref === 'string') continue;
      if (ref === null || typeof ref !== 'object') throw err('pack_validation_failed', `chain ${String(chain.chainId)} has a subChain whose ref is neither a sibling chainId nor an external reference`, { reason: 'sub_chain_unresolved', chainId: String(chain.chainId ?? '') });
      const v = (ref as { version?: unknown }).version;
      if (typeof v !== 'string' || !EXACT_VERSION.test(v)) {
        throw err('pack_validation_failed', `chain ${String(chain.chainId)} composes an external chain at version ${JSON.stringify(v)} — a reference MUST pin an exact version, not a range (workflow-chain-packs.md §Exact pins)`, { reason: 'chain_reference_unpinned', chainId: String(chain.chainId ?? ''), reference: String(v ?? '') });
      }
    }
  }
}

/** §Co-registered children — the id two parents composing the same child MUST agree on. */
export function childWorkflowId(ref: string): string {
  return `chain-child-${createHash('sha256').update(ref, 'utf8').digest('hex').slice(0, 24)}`;
}

/** §Parameter substitution — at expansion time, never deferred to dispatch. */
function substitute(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
      const v = params[name];
      if (v === undefined) throw err('pack_validation_failed', `chain parameter ${name} has no value at expansion time, and a persisted definition MUST NOT carry ${whole} (workflow-chain-packs.md §Parameter substitution)`, { reason: 'chain_parameter_unbound', parameter: name });
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, params);
    return out;
  }
  return value;
}

/**
 * Expand one chain into a workflow definition, registering each sub-chain child
 * first. `seen` carries the composition path: depth and cycle are ONE guard
 * (workflow-chain-packs.md §Composition depth).
 */
export function expandChain(host: Host, manifest: Record<string, unknown>, chain: Chain, params: Record<string, unknown>, seen: readonly string[] = []): { definition: WorkflowDefinition; children: string[] } {
  const chainId = String(chain.chainId ?? '');
  const maxDepth = host.config.chainMaxDepth;
  if (seen.includes(chainId)) throw err('sub_chain_cycle', `chain ${chainId} composes itself through ${[...seen, chainId].join(' → ')}`, { chainId, path: [...seen, chainId] });
  if (seen.length >= maxDepth) throw err('sub_chain_depth_exceeded', `sub-chain nesting exceeds workflowChainPacks.subChains.maxDepth ${maxDepth}`, { maxDepth, path: [...seen, chainId] });

  const children: string[] = [];
  for (const s of (Array.isArray(chain.subChains) ? (chain.subChains as Array<{ ref?: unknown }>) : [])) {
    // Sibling (`"c.child"`) or external (`{ packName, chainId, version }`). The
    // resolved reference is what the ownership record persists, so a
    // re-instantiation or `:fork` reproduces the same child (§Co-registered).
    const o = (s.ref !== null && typeof s.ref === 'object' ? s.ref : null) as { packName?: unknown; chainId?: unknown; version?: unknown } | null;
    const childChainId = o ? String(o.chainId) : String(s.ref);
    const ref = o ? `${String(o.packName)}#${childChainId}@${String(o.version)}` : childChainId;
    const childId = childWorkflowId(ref);
    const child = (Array.isArray(manifest['chains']) ? (manifest['chains'] as Chain[]) : []).find((c) => String(c.chainId) === childChainId);
    if (child === undefined) throw err('sub_chain_unresolved', `subChain ${ref} names no chain this manifest declares${o ? ' and this host resolves no external chain registry' : ''}`, { reference: ref, chainId });
    const expanded = expandChain(host, manifest, child, params, [...seen, chainId]);
    // Identity + reference count + ownership: one registration per child id, one
    // row per (parent, child) with the RESOLVED version, so a re-instantiation
    // reproduces this child and deleting one parent does not take it away.
    host.store.upsertChainChild(childId, JSON.stringify(expanded.definition));
    host.store.recordChainOwnership(chainId, childId, ref);
    children.push(childId, ...expanded.children);
  }

  const dag = (chain.dag ?? {}) as ChainDag;
  const substituted = substitute({ nodes: dag.nodes ?? [], edges: dag.edges ?? [] }, params) as { nodes: unknown[]; edges: unknown[] };
  const definition: WorkflowDefinition = {
    id: chainId,
    version: typeof chain.version === 'string' ? chain.version : '1.0.0',
    // §Edge conditions: `condition` and `triggerRule` ride through verbatim —
    // substitution walks values, it does not reshape edges.
    nodes: substituted.nodes as WorkflowDefinition['nodes'],
    edges: substituted.edges as WorkflowDefinition['edges'],
    variables: [],
  };
  const persisted = JSON.stringify(definition);
  if (PARAM_TOKEN.test(persisted)) throw err('pack_validation_failed', `the expanded definition for ${chainId} still carries a {{params.*}} token — substitution happens at expansion, never at dispatch (workflow-chain-packs.md §Parameter substitution)`, { reason: 'chain_parameter_deferred', chainId });
  return { definition, children };
}

/** Register every chain a manifest declares; called from the pack publish path. */
export function registerChainPack(host: Host, manifest: Record<string, unknown>): { chains: string[]; children: string[] } {
  assertExactPins(manifest);
  const chains = Array.isArray(manifest['chains']) ? (manifest['chains'] as Chain[]) : [];
  const registered: string[] = [];
  const children: string[] = [];
  for (const chain of chains) {
    const params: Record<string, unknown> = {};
    const declared = (chain.parameters ?? {}) as { properties?: Record<string, { default?: unknown }> };
    for (const [k, v] of Object.entries(declared.properties ?? {})) if (v && typeof v === 'object' && 'default' in v) params[k] = (v as { default?: unknown }).default;
    const out = expandChain(host, manifest, chain, params);
    host.store.upsertChainChild(String(chain.chainId), JSON.stringify(out.definition));
    registered.push(String(chain.chainId));
    children.push(...out.children);
  }
  return { chains: registered, children };
}

/** §Co-registered children — deleting a parent decrements; the child goes when the last parent does. */
export function unregisterChainPack(host: Host, manifest: Record<string, unknown>): void {
  for (const chain of (Array.isArray(manifest['chains']) ? (manifest['chains'] as Chain[]) : [])) {
    const chainId = String(chain.chainId ?? '');
    for (const childId of host.store.chainChildrenOf(chainId)) {
      host.store.dropChainOwnership(chainId, childId);
      if (host.store.chainParentCount(childId) === 0) host.store.deleteChainChild(childId);
    }
    host.store.deleteChainChild(chainId);
  }
}
