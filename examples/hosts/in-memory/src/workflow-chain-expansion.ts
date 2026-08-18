/**
 * In-memory host implementation of workflow-chain pack expansion
 * (RFC 0013 Phase 3 — `workflow-chain-packs.md` §"Expansion semantics").
 *
 * Wraps the spec-authoritative `expandChain()` algorithm with the
 * host-specific I/O the spec deliberately leaves to implementers:
 *
 *   - Step 1: registry resolution (filesystem mirror, configured via
 *             OPENWOP_PACK_REGISTRY_DIR)
 *   - Step 2: signature verification (Ed25519 over canonical pack.json
 *             bytes, per `node-packs.md` §Signing — chain packs reuse
 *             the node-pack signing recipe verbatim per the
 *             workflow-chain-pack-signature-verification scenario)
 *   - Step 4: parameter validation (caller-side — the conformance
 *             scenarios pre-validate; this handler accepts pre-
 *             validated params and runs literal substitution only)
 *
 * The pure expansion logic (steps 3 + 5 + 6 + 8 of the algorithm) is
 * a verbatim copy of `conformance/src/lib/workflow-chain-expansion.ts`.
 * That conformance copy is spec-authoritative (the server-free
 * scenarios exercise it directly). This copy exists because the
 * in-memory host has a zero-runtime-deps policy and can't import
 * from the conformance package. The `workflow-chain-host-expansion`
 * conformance scenario asserts the two implementations stay in sync
 * by comparing the live-host's response against the conformance lib's
 * direct output for the same input.
 *
 * @see spec/v1/workflow-chain-packs.md §"Expansion semantics (normative)"
 * @see conformance/src/lib/workflow-chain-expansion.ts
 * @see RFCS/0013-workflow-chain-packs.md
 */

import { createVerify, createPublicKey, randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Wire types (mirror conformance/src/lib/workflow-chain-expansion.ts) ─

export interface WorkflowChain {
  chainId: string;
  version: string;
  label: string;
  description: string;
  parameters: object;
  dag: { nodes: ReadonlyArray<FragmentNode>; edges?: ReadonlyArray<FragmentEdge> };
  outputs?: Record<string, { type: string; description: string }>;
  capabilities?: ReadonlyArray<'streamable' | 'cacheable' | 'side-effectful' | 'mcp-exportable'>;
}

export interface FragmentNode {
  id: string;
  typeId: string;
  name?: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
}

/** A fan-in / error-routing rule mirrored from `WorkflowEdge.triggerRule`
 *  (workflow-definition.schema.json). RFC 0125. */
export type TriggerRule =
  | 'all_success'
  | 'any_success'
  | 'all_complete'
  | 'none_failed'
  | 'any_failed';

export interface FragmentEdge {
  from: string;
  to: string;
  condition?: string;
  /** Fan-in / error-routing rule (RFC 0125). Carried through expansion onto
   *  the resulting WorkflowEdge so the scheduler honors it. */
  triggerRule?: TriggerRule;
}

export interface ExpansionContext {
  expansionId: string;
  params: Record<string, unknown>;
  isTypeIdResolvable: (typeId: string) => boolean;
}

export interface ExpandedFragment {
  nodes: ReadonlyArray<{
    id: string;
    typeId: string;
    name?: string;
    position?: { x: number; y: number };
    config?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    capabilities?: ReadonlyArray<string>;
  }>;
  edges: ReadonlyArray<{ from: string; to: string; condition?: string; triggerRule?: TriggerRule }>;
  idMap: ReadonlyMap<string, string>;
}

// ─── Pure algorithm (verbatim from conformance/src/lib/) ───────────────

export class ChainUnresolvableTypeIdError extends Error {
  readonly code = 'chain_unresolvable_typeid';
  constructor(readonly typeId: string, readonly chainId: string) {
    super(`chain_unresolvable_typeid: '${typeId}' in chain '${chainId}'`);
    this.name = 'ChainUnresolvableTypeIdError';
  }
}

const PARAM_PATTERN = /\{\{params\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
/** A value that is EXACTLY a single `{{params.<name>}}` token (whole-value),
 *  distinct from a token embedded in a larger string. Under expansion-time
 *  substitution a whole-value token resolves to the RAW TYPED parameter value
 *  rather than a string coercion (WCP2 raw-typed rule); under deferred mode it
 *  is the only non-prompt position deferrable to a variable-sourced PortValue.
 *  An embedded non-prompt token has no runtime `{{}}` construct and MUST resolve
 *  at expansion time. */
const WHOLE_VALUE_PATTERN = /^\{\{params\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/;

/** Recursive substitution of `{{params.<name>}}` placeholders in any string
 *  field. Two cases per `workflow-chain-packs.md` §"Parameter substitution":
 *    - WHOLE-VALUE: a string that is exactly one `{{params.x}}` token resolves
 *      to the RAW typed parameter value (object / array / number / boolean
 *      survive as their JSON type instead of being stringified).
 *    - EMBEDDED: one or more tokens inside surrounding text do literal string
 *      substitution.
 *  Non-string values pass through unchanged; nested arrays/objects are walked. */
function substitute(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE_VALUE_PATTERN.exec(value);
    if (whole) {
      // Whole-value token — return the raw typed value so a param typed
      // `object` / `array` / `number` / `boolean` reaches the node config
      // intact. `undefined` (undeclared param) collapses to the empty string,
      // matching the embedded-token convention below.
      const v = params[whole[1] as string];
      return v === undefined ? '' : v;
    }
    return value.replace(PARAM_PATTERN, (_match, name: string) => {
      const v = params[name];
      // Per the spec, parameter values are validated against the chain's
      // parameters schema BEFORE expansion, so `v === undefined` here
      // means the chain author referenced an undeclared parameter — the
      // safest substitution is the empty string (matching the standard
      // {{...}} convention in n8n/Handlebars).
      return v === undefined ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, params));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, params);
    return out;
  }
  return value;
}

/** Rewrite an edge endpoint ref. `ref` is either `<nodeId>` or
 *  `<nodeId>.<portName>`. Only the nodeId portion is rewritten; the
 *  portName (if present) is preserved verbatim. Refs that don't match
 *  a fragment node id pass through unchanged (lets edges to/from
 *  parent-workflow nodes work via post-splice wiring). */
function rewriteEdgeRef(
  ref: string,
  fragmentNodeIds: ReadonlySet<string>,
  prefix: string,
): string {
  const dotIdx = ref.indexOf('.');
  const nodeId = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
  const portPart = dotIdx === -1 ? '' : ref.slice(dotIdx);
  return fragmentNodeIds.has(nodeId) ? `${prefix}${nodeId}${portPart}` : ref;
}

/** Compute the per-expansion node-id prefix from the chainId + expansionId.
 *  The chainId's dots are replaced with underscores so the resulting ids
 *  remain valid in storage backends that reserve `.` for hierarchical
 *  keys. */
function computePrefix(chainId: string, expansionId: string): string {
  return `${chainId.replace(/\./g, '_')}_${expansionId}_`;
}

/**
 * Expand a workflow-chain into a concrete fragment ready to splice into a
 * parent workflow. Implements steps 3 + 5 + 6 + 8 of the normative
 * `workflow-chain-packs.md` §"Expansion semantics" flow.
 *
 * @throws ChainUnresolvableTypeIdError when any `dag.nodes[].typeId`
 *   fails the caller's `isTypeIdResolvable` predicate.
 */
export function expandChain(chain: WorkflowChain, ctx: ExpansionContext): ExpandedFragment {
  // Step 3: validate every typeId resolves.
  for (const node of chain.dag.nodes) {
    if (!ctx.isTypeIdResolvable(node.typeId)) {
      throw new ChainUnresolvableTypeIdError(node.typeId, chain.chainId);
    }
  }

  const prefix = computePrefix(chain.chainId, ctx.expansionId);
  const fragmentNodeIds = new Set(chain.dag.nodes.map((n) => n.id));
  const idMap = new Map<string, string>();
  for (const id of fragmentNodeIds) idMap.set(id, `${prefix}${id}`);

  // Steps 5 + 6 + 8: substitute placeholders, rewrite ids, propagate capabilities.
  const expandedNodes = chain.dag.nodes.map((n) => {
    const out: ExpandedFragment['nodes'][number] = {
      id: `${prefix}${n.id}`,
      typeId: n.typeId,
    };
    if (n.name !== undefined) out.name = n.name;
    if (n.position !== undefined) out.position = n.position;
    if (n.config !== undefined) {
      out.config = substitute(n.config, ctx.params) as Record<string, unknown>;
    }
    if (n.inputs !== undefined) {
      out.inputs = substitute(n.inputs, ctx.params) as Record<string, unknown>;
    }
    if (chain.capabilities && chain.capabilities.length > 0) {
      out.capabilities = [...chain.capabilities];
    }
    return out;
  });

  const expandedEdges = (chain.dag.edges ?? []).map((e) => {
    const out: ExpandedFragment['edges'][number] = {
      from: rewriteEdgeRef(e.from, fragmentNodeIds, prefix),
      to: rewriteEdgeRef(e.to, fragmentNodeIds, prefix),
    };
    if (e.condition !== undefined) out.condition = e.condition;
    // RFC 0125: carry the fan-in/error-routing rule onto the expanded
    // WorkflowEdge so the scheduler honors it (mirrors the `condition`
    // pass-through; without this the field is silently dropped at expansion).
    if (e.triggerRule !== undefined) out.triggerRule = e.triggerRule;
    return out;
  });

  return { nodes: expandedNodes, edges: expandedEdges, idMap };
}

// ─── End of the MIRRORED CORE ───────────────────────────────────────────────
//
// Everything above mirrors `conformance/src/lib/workflow-chain-expansion.ts`
// byte-for-byte (whitespace-tolerant) and is compared by
// `scripts/check-workflow-chain-expansion-sync.mjs` in the openwop/openwop repo.
// The sentinel is explicit here (it used to be implied by the I/O wrapper banner
// below) because a SECOND mirrored region now follows, and without this marker
// the core comparison would swallow it.

// ─── Begin the MIRRORED COMPENSATION pass ───────────────────────────────────
//
// SP-01 (2026-08-18): this pass is a SECOND byte-mirrored region, gated by
// `scripts/check-workflow-chain-expansion-sync.mjs` alongside the core above.
//
// It sits below "End of the MIRRORED CORE" because it composes on the core's
// OUTPUT rather than editing it — but unlike the capability-gated surfaces that
// follow (RFC 0124 deferred parameters, RFC 0133 sub-chains, which a host that
// does not advertise them MUST REFUSE rather than implement), carrying a
// chain's compensation declaration is UNCONDITIONAL: `compensation.md`
// §"Workflow policy" makes the declaration descriptive, so a host that does not
// advertise `capabilities.compensation` still MUST carry it verbatim and refuse
// only a chain-level POLICY (`capability_required`). Unconditional ⇒ genuinely
// mirrorable ⇒ gated. RFC 0157's own commit claimed this pass was already
// "CI-gated against the reference host"; it was not — the gate stopped at the
// core sentinel — so the mirror never received it. Anything added between the
// two sentinels below MUST be mirrored in the reference host — that is the
// whole RFC 0157 unit: the types, the two error classes, the helpers, and
// `carryCompensation` / `expandChainWithCompensation`.

// ---------------------------------------------------------------------------
// RFC 0157 (RFC 0013 revision × RFC 0151 §B) — chain fragments carry
// compensation.
//
// A workflow that is "a chain or a stack" could not own an inverse action:
// `FragmentNode` had no `compensation` and the chain had no policy, so RFC 0151
// §B was reachable only through a hand-authored `POST /v1/workflows`. This pass
// carries the node-level `compensation` declaration and the chain-level policy
// through expansion into the registered `WorkflowDefinition`.
//
// It sits BELOW the mirrored core deliberately: the core is byte-mirrored by
// the in-memory reference host and gated in CI, and this pass composes on the
// core's output rather than editing it — a host runs `expandChain` then
// `carryCompensation` (or `expandChainWithCompensation`). It is NOT capability
// gated on the host's `compensation` advert: a host that does not advertise
// `capabilities.compensation` still MUST carry the declaration verbatim (it is
// descriptive) and MUST refuse a chain-level POLICY with `capability_required`
// per `compensation.md` §"Workflow policy" — the same rule as for a hand-authored
// `settings.compensation`.
//
// Normative reference: `spec/v1/workflow-chain-packs.md` §"Compensation
// (RFC 0157)"; error code `chain_compensation_policy_conflict`.
// ---------------------------------------------------------------------------

/** Mirror of `WorkflowNode.compensation` (workflow-definition.schema.json). */
export interface FragmentNodeCompensation {
  nodeTypeId: string;
  inputMapping?: Record<string, unknown>;
  retry?: { maxAttempts?: number; backoffMs?: number };
  requiresApproval?: boolean;
}

/** Mirror of `compensation-policy.schema.json` (RFC 0151 §B). */
export interface ChainCompensationPolicy {
  profileVersion?: string;
  orderingModel?: 'reverse-completion' | 'dependency-graph';
  triggers: ReadonlyArray<'node-failure' | 'run-cancel' | 'cap-breach' | 'operator-request'>;
  retry?: { maxAttempts?: number; backoffMs?: number };
  timeoutMs?: number;
  exhaustedDisposition?: 'record-outcome' | 'manual-intervention';
  approvalScope?: 'declared' | 'all';
  onParentCancel?: 'continue' | 'pause' | 'manual';
}

/** A chain as RFC 0157 sees it: the RFC 0013 shape plus the two optional
 *  compensation surfaces. */
export type WorkflowChainWithCompensation = Omit<WorkflowChain, 'dag'> & {
  dag: {
    nodes: ReadonlyArray<FragmentNode & { compensation?: FragmentNodeCompensation; irreversibleEffect?: boolean }>;
    edges?: ReadonlyArray<FragmentEdge>;
  };
  compensation?: ChainCompensationPolicy;
};

/** Thrown when a fragment node declares BOTH `irreversibleEffect: true` and a
 *  `compensation` (RFC 0151 UQ4 / `compensation.md` §B): a contradiction the
 *  schema also rejects; expansion refuses it fail-closed rather than pick one.
 *  Wire code `chain_irreversible_with_compensation`. */
export class ChainIrreversibleWithCompensationError extends Error {
  readonly code = 'chain_irreversible_with_compensation' as const;
  constructor(
    public readonly nodeId: string,
    public readonly chainId: string,
  ) {
    super(
      `chain_irreversible_with_compensation: fragment node "${nodeId}" in chain "${chainId}" declares both ` +
        'irreversibleEffect: true and a compensation — an effect cannot both have and lack an inverse',
    );
    this.name = 'ChainIrreversibleWithCompensationError';
  }
}

/** Thrown when the parent already carries a `settings.compensation` policy that
 *  is not deep-equal to the chain's. Wire code
 *  `chain_compensation_policy_conflict` (`workflow-chain-packs.md` §"Error
 *  codes"). Fail closed: a merged policy nobody wrote is exactly the
 *  guess-at-a-contract failure the policy exists to prevent. */
export class ChainCompensationPolicyConflictError extends Error {
  readonly code = 'chain_compensation_policy_conflict' as const;
  constructor(
    public readonly chainId: string,
  ) {
    super(
      `chain_compensation_policy_conflict: chain "${chainId}" declares a compensation policy that differs ` +
        'from the parent workflow\'s settings.compensation; expansion MUST NOT merge policies',
    );
    this.name = 'ChainCompensationPolicyConflictError';
  }
}

/** Rewrite fragment node-id references inside an `inputMapping` value the same
 *  way edge refs are rewritten: any string of the form
 *  `${nodes.<fragmentNodeId>.<path>}` (or bare `nodes.<id>.<path>` / `<id>.<port>`)
 *  gets its node-id segment prefixed. Everything else passes through. Recurses
 *  through objects/arrays. Deliberately conservative: only ids that ARE
 *  fragment node ids are rewritten, so a reference to a parent-workflow node
 *  survives verbatim (same rule as `rewriteEdgeRef`). */
function rewriteInputMappingRefs(value: unknown, fragmentNodeIds: ReadonlySet<string>, prefix: string): unknown {
  if (typeof value === 'string') {
    // `${nodes.<id>.…}` template form (RFC 0151 §B example) and `nodes.<id>.…`
    return value.replace(/(\$\{\s*nodes\.|\bnodes\.)([A-Za-z0-9_.-]+?)(\.)/g, (m, lead: string, id: string, dot: string) =>
      fragmentNodeIds.has(id) ? `${lead}${prefix}${id}${dot}` : m,
    );
  }
  if (Array.isArray(value)) return value.map((v) => rewriteInputMappingRefs(v, fragmentNodeIds, prefix));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteInputMappingRefs(v, fragmentNodeIds, prefix);
    }
    return out;
  }
  return value;
}

/** Stable deep equality for policy comparison (key order insensitive). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export interface CarriedCompensation {
  /** The expanded fragment with `compensation` carried onto each node that
   *  declared one (typeIds validated, params substituted, id refs rewritten)
   *  and `irreversibleEffect` copied verbatim where declared. */
  nodes: ReadonlyArray<ExpandedFragment['nodes'][number] & { compensation?: FragmentNodeCompensation; irreversibleEffect?: boolean }>;
  /** The `settings.compensation` the registered definition MUST carry after
   *  this expansion: the parent's when the chain declares none; the chain's
   *  when the parent had none; the (equal) shared policy when both agree.
   *  `undefined` when neither side declares one. */
  settingsCompensation: ChainCompensationPolicy | undefined;
}

/**
 * RFC 0157 — carry the chain's compensation surfaces through expansion.
 *
 * Steps (numbered to slot into `workflow-chain-packs.md` §"Expansion
 * semantics"):
 *   3b. every `compensation.nodeTypeId` MUST resolve exactly as `typeId` does
 *       (`chain_unresolvable_typeid`) — an unwind must not fail on a typo first
 *       discovered during a failure;
 *   5b. `{{params.*}}` inside `inputMapping` are substituted (author-time
 *       literals; the recorded-facts rule is unaffected);
 *   6b. fragment node-id references inside `inputMapping` are rewritten with
 *       the expansion prefix, exactly as edge refs are;
 *   6c. `irreversibleEffect: true` (RFC 0151 UQ4) is copied onto the expanded
 *       node unchanged; a fragment node declaring both it and a `compensation`
 *       is refused (`chain_irreversible_with_compensation`) — the schema rejects
 *       the shape too, and expansion does not pick a side;
 *   9b. the chain-level policy becomes the definition's `settings.compensation`
 *       — copied when the parent has none, accepted when equal, otherwise
 *       `chain_compensation_policy_conflict`.
 *
 * @throws ChainUnresolvableTypeIdError, ChainCompensationPolicyConflictError, ChainIrreversibleWithCompensationError
 */
export function carryCompensation(
  chain: WorkflowChainWithCompensation,
  expanded: ExpandedFragment,
  ctx: ExpansionContext,
  parentSettingsCompensation?: ChainCompensationPolicy,
): CarriedCompensation {
  const prefix = computePrefix(chain.chainId, ctx.expansionId);
  const srcNodes = chain.dag.nodes;
  const fragmentNodeIds = new Set(srcNodes.map((n) => n.id));
  const byOriginalId = new Map(srcNodes.map((n) => [n.id, n] as const));

  // 3b (+ 6c's contradiction check, before any node is emitted)
  for (const n of srcNodes) {
    if (n.irreversibleEffect === true && n.compensation !== undefined) {
      throw new ChainIrreversibleWithCompensationError(n.id, chain.chainId);
    }
    if (n.compensation !== undefined && !ctx.isTypeIdResolvable(n.compensation.nodeTypeId)) {
      throw new ChainUnresolvableTypeIdError(n.compensation.nodeTypeId, chain.chainId);
    }
  }

  // 5b + 6b + 6c
  const nodes = expanded.nodes.map((en) => {
    const originalId = en.id.startsWith(prefix) ? en.id.slice(prefix.length) : en.id;
    const src = byOriginalId.get(originalId);
    if (src?.irreversibleEffect === true) return { ...en, irreversibleEffect: true };
    if (src?.compensation === undefined) return en;
    const c: FragmentNodeCompensation = { nodeTypeId: src.compensation.nodeTypeId };
    if (src.compensation.inputMapping !== undefined) {
      const substituted = substitute(src.compensation.inputMapping, ctx.params) as Record<string, unknown>;
      c.inputMapping = rewriteInputMappingRefs(substituted, fragmentNodeIds, prefix) as Record<string, unknown>;
    }
    if (src.compensation.retry !== undefined) c.retry = { ...src.compensation.retry };
    if (src.compensation.requiresApproval !== undefined) c.requiresApproval = src.compensation.requiresApproval;
    return { ...en, compensation: c };
  });

  // 9b
  let settingsCompensation: ChainCompensationPolicy | undefined = parentSettingsCompensation;
  if (chain.compensation !== undefined) {
    if (parentSettingsCompensation === undefined) {
      settingsCompensation = { ...chain.compensation, triggers: [...chain.compensation.triggers] };
    } else if (canonicalJson(parentSettingsCompensation) !== canonicalJson(chain.compensation)) {
      throw new ChainCompensationPolicyConflictError(chain.chainId);
    }
  }
  return { nodes, settingsCompensation };
}

/** Convenience: `expandChain` followed by `carryCompensation`. */
export function expandChainWithCompensation(
  chain: WorkflowChainWithCompensation,
  ctx: ExpansionContext,
  parentSettingsCompensation?: ChainCompensationPolicy,
): ExpandedFragment & CarriedCompensation {
  const expanded = expandChain(chain, ctx);
  const carried = carryCompensation(chain, expanded, ctx, parentSettingsCompensation);
  return { ...expanded, nodes: carried.nodes, settingsCompensation: carried.settingsCompensation };
}
// ─── End of the MIRRORED COMPENSATION pass ──────────────────────────────────

// ─── Host-side I/O wrapper ──────────────────────────────────────────────

/**
 * Errors the host-side wrapper raises. Each carries a wire-level
 * `code` matching `workflow-chain-packs.md` §"Error codes" + node-packs
 * §"Registry HTTP API" so the JSON response body is self-explanatory.
 */
export class WorkflowChainExpansionError extends Error {
  constructor(
    public readonly code:
      | 'pack_not_found'
      | 'pack_manifest_invalid'
      | 'pack_kind_invalid'
      | 'pack_signature_invalid'
      | 'pack_signature_unverifiable'
      | 'chain_not_found'
      | 'chain_unresolvable_typeid'
      | 'invalid_request',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WorkflowChainExpansionError';
  }
}

interface PackManifest {
  name: string;
  version: string;
  kind?: 'node' | 'workflow-chain';
  chains?: WorkflowChain[];
  nodes?: unknown[];
}

interface PackSources {
  manifestBytes: Buffer;
  manifest: PackManifest;
  signatureBytes: Buffer | null;
  publicKeyPem: string | null;
}

/**
 * Locate a pack within the registry mirror by `manifest.name`. The
 * mirror's directory naming is free-form (e.g., the in-tree
 * `examples/packs/` uses short dirnames like `workflow-chain-sample`
 * while production registries publish under fully-qualified
 * `<scope>.<name>/` directories) — so this scan reads each top-level
 * `pack.json` to find one whose `name` field matches.
 */
async function findPackDir(registryDir: string, packName: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(registryDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(registryDir, entry);
    let isDir = false;
    try { isDir = (await stat(candidate)).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    let manifestText: string;
    try {
      manifestText = (await readFile(join(candidate, 'pack.json'))).toString('utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(manifestText) as { name?: string };
      if (parsed.name === packName) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Load a pack manifest from the registry mirror. The pack's directory
 * is located by matching `manifest.name` (not directory name) — see
 * `findPackDir`. Optional sibling `pack.json.sig` + `pack.json.sig.pub`
 * carry the Ed25519 signature + public key for verification.
 *
 * The in-memory host treats packs without a `pack.json.sig` as
 * "local-trust" (a sample-host concession — production deployers MUST
 * require signatures per `node-packs.md §"Verification flow"`). The
 * conformance scenarios exercise both paths.
 */
async function loadPackSources(registryDir: string, packName: string): Promise<PackSources> {
  const packDir = await findPackDir(registryDir, packName);
  if (packDir === null) {
    throw new WorkflowChainExpansionError(
      'pack_not_found',
      `Pack '${packName}' not found under registry dir.`,
      { registryDir, packName },
    );
  }
  const manifestBytes = await readFile(join(packDir, 'pack.json'));
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as PackManifest;
  } catch (err) {
    throw new WorkflowChainExpansionError(
      'pack_manifest_invalid',
      `pack.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { packName },
    );
  }

  // Optional signature side-files.
  let signatureBytes: Buffer | null = null;
  let publicKeyPem: string | null = null;
  try {
    signatureBytes = await readFile(join(packDir, 'pack.json.sig'));
    publicKeyPem = (await readFile(join(packDir, 'pack.json.sig.pub'))).toString('utf8');
  } catch {
    // No signature side-files — sample-host trust. Production hosts
    // would refuse here per node-packs.md §"Verification flow".
  }

  return { manifestBytes, manifest, signatureBytes, publicKeyPem };
}

/**
 * Verify an Ed25519 signature over the canonical pack.json bytes per
 * `node-packs.md §Signing`. Workflow-chain packs reuse this recipe
 * verbatim (per `workflow-chain-packs.md §"Expansion semantics"
 * step 2`). Throws `pack_signature_invalid` on mismatch.
 */
function verifyPackSignature(sources: PackSources): void {
  if (sources.signatureBytes === null || sources.publicKeyPem === null) return;
  try {
    const verify = createVerify('SHA512');
    verify.update(sources.manifestBytes);
    verify.end();
    const publicKey = createPublicKey(sources.publicKeyPem);
    const ok = verify.verify(publicKey, sources.signatureBytes);
    if (!ok) {
      throw new WorkflowChainExpansionError(
        'pack_signature_invalid',
        `Ed25519 signature verification failed for pack '${sources.manifest.name}'`,
      );
    }
  } catch (err) {
    if (err instanceof WorkflowChainExpansionError) throw err;
    throw new WorkflowChainExpansionError(
      'pack_signature_unverifiable',
      `Failed to verify signature: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface ExpandFromRegistryInput {
  registryDir: string;
  packName: string;
  version?: string;
  chainId: string;
  parameters: Record<string, unknown>;
  /** Predicate the caller controls. Defaults to allowing every typeId
   *  (the in-memory host's runtime is fixture-only, so cross-host typeId
   *  reachability is a separate concern). Production hosts SHOULD pass
   *  a predicate backed by their actual node registry. */
  isTypeIdResolvable?: (typeId: string) => boolean;
  /** Override the per-expansion id suffix (used by tests for stability;
   *  defaults to 4 random hex chars per the spec's "expansionId" note). */
  expansionId?: string;
}

export interface ExpandFromRegistryOutput {
  expansionId: string;
  chainId: string;
  packName: string;
  packVersion: string;
  nodes: ExpandedFragment['nodes'];
  edges: ExpandedFragment['edges'];
}

/**
 * The full host-side expansion flow: load, verify, locate, expand.
 *
 * Throws `WorkflowChainExpansionError` with a typed `code` for every
 * failure mode the spec enumerates. Callers (HTTP handlers, test
 * scaffolds) map the code to HTTP status (404 for *_not_found, 422
 * for *_invalid / unresolvable, 500 for unverifiable).
 */
export async function expandChainFromRegistry(
  input: ExpandFromRegistryInput,
): Promise<ExpandFromRegistryOutput> {
  const sources = await loadPackSources(input.registryDir, input.packName);

  if (sources.manifest.kind !== 'workflow-chain') {
    throw new WorkflowChainExpansionError(
      'pack_kind_invalid',
      `Pack '${input.packName}' has kind '${sources.manifest.kind ?? 'node'}', not 'workflow-chain'.`,
      { packName: input.packName, kind: sources.manifest.kind ?? 'node' },
    );
  }
  if (!Array.isArray(sources.manifest.chains) || sources.manifest.chains.length === 0) {
    throw new WorkflowChainExpansionError(
      'pack_manifest_invalid',
      `Pack '${input.packName}' has no chains[].`,
    );
  }
  if (input.version !== undefined && sources.manifest.version !== input.version) {
    throw new WorkflowChainExpansionError(
      'pack_manifest_invalid',
      `Pack version mismatch: requested '${input.version}', got '${sources.manifest.version}'.`,
      { requested: input.version, actual: sources.manifest.version },
    );
  }

  verifyPackSignature(sources);

  const chain = sources.manifest.chains.find((c) => c.chainId === input.chainId);
  if (!chain) {
    throw new WorkflowChainExpansionError(
      'chain_not_found',
      `Chain '${input.chainId}' not found in pack '${input.packName}@${sources.manifest.version}'.`,
      { availableChainIds: sources.manifest.chains.map((c) => c.chainId) },
    );
  }

  const expansionId = input.expansionId ?? randomBytes(2).toString('hex');
  const isTypeIdResolvable = input.isTypeIdResolvable ?? (() => true);
  const fragment = expandChain(chain, {
    expansionId,
    params: input.parameters,
    isTypeIdResolvable,
  });

  return {
    expansionId,
    chainId: input.chainId,
    packName: sources.manifest.name,
    packVersion: sources.manifest.version,
    nodes: fragment.nodes,
    edges: fragment.edges,
  };
}
