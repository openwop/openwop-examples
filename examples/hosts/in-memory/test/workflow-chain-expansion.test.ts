/**
 * In-memory host workflow-chain expansion — RFC 0013 Phase 3.
 *
 * Pure-function test (no HTTP server boots). The host's expansion
 * wrapper is a single async function the HTTP handler calls; surfacing
 * the algorithm independently of the server makes mechanical proof
 * straightforward — the HTTP layer is just JSON parsing + status
 * mapping.
 *
 * Cases:
 *   1. Positive — load the in-tree sample pack, expand the 1-node
 *      chain, assert substituted+rewritten output.
 *   2. Positive — same pack, the 2-node chain with edges, assert
 *      edge rewriting + capability propagation.
 *   3. Negative — unknown pack → `pack_not_found`.
 *   4. Negative — pack exists but chain id doesn't → `chain_not_found`.
 *   5. Negative — pack found but `kind !== 'workflow-chain'` →
 *      `pack_kind_invalid`.
 *
 * Signature verification + tampered-manifest paths are already covered
 * by the server-free conformance scenario
 * `workflow-chain-pack-signature-verification.test.ts`; the sample
 * pack is unsigned (sample-host concession documented inline in the
 * host module) so this test exercises the unsigned-trust path.
 *
 * @see examples/hosts/in-memory/src/workflow-chain-expansion.ts
 * @see spec/v1/workflow-chain-packs.md §"Expansion semantics (normative)"
 * @see RFCS/0013-workflow-chain-packs.md
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  expandChain,
  expandChainFromRegistry,
  WorkflowChainExpansionError,
} from '../src/workflow-chain-expansion.js';
import type { WorkflowChain } from '../src/workflow-chain-expansion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SAMPLE_REGISTRY = join(REPO_ROOT, 'examples', 'packs');
const SAMPLE_PACK_NAME = 'vendor.openwop.workflow-chain-sample';
// `examples/packs/` uses the short dirname (`workflow-chain-sample`), not the
// fully-qualified pack name — same convention `findPackDir` tolerates.
const SAMPLE_PACK_VERSION = (
  JSON.parse(readFileSync(join(SAMPLE_REGISTRY, 'workflow-chain-sample', 'pack.json'), 'utf8')) as {
    version: string;
  }
).version;

async function expectThrow(
  fn: () => Promise<unknown>,
  code: string,
  hint: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof WorkflowChainExpansionError,
      `${hint}: expected WorkflowChainExpansionError, got ${err instanceof Error ? err.constructor.name : typeof err}`,
    );
    assert.equal(err.code, code, `${hint}: expected code='${code}', got '${err.code}'`);
    return;
  }
  assert.fail(`${hint}: expected throw with code='${code}', got no error`);
}

// ─── Case 1: positive, 1-node chain ────────────────────────────────────

{
  const result = await expandChainFromRegistry({
    registryDir: SAMPLE_REGISTRY,
    packName: SAMPLE_PACK_NAME,
    chainId: 'vendor.openwop.workflow-chain-sample.summarize-text',
    parameters: {
      sourceText: 'The quick brown fox jumps over the lazy dog.',
      targetLength: 'one-sentence',
      tone: 'casual',
    },
    expansionId: 'abcd',
  });

  assert.equal(result.packName, SAMPLE_PACK_NAME);
  // The sample chain pack's version moves (1.0.0 → 1.1.0 in #16, the RFC 0157
  // compensating chains); pin the assertion to the registry's own manifest so
  // this test measures expansion, not the pack's release cadence.
  assert.equal(result.packVersion, SAMPLE_PACK_VERSION);
  assert.equal(result.chainId, 'vendor.openwop.workflow-chain-sample.summarize-text');
  assert.equal(result.expansionId, 'abcd');
  assert.equal(result.nodes.length, 1);
  assert.equal(result.edges.length, 0);

  const node = result.nodes[0]!;
  // Step 6: id rewriting — chainId's dots replaced with underscores +
  // expansion suffix.
  assert.equal(
    node.id,
    'vendor_openwop_workflow-chain-sample_summarize-text_abcd_summarize-call',
  );
  assert.equal(node.typeId, 'core.ai.callPrompt');
  // Step 5: literal substitution of {{params.<name>}}.
  const sysPrompt = (node.config as { systemPrompt: string }).systemPrompt;
  assert.ok(
    sysPrompt.includes('a one-sentence summary'),
    `targetLength substitution: ${sysPrompt}`,
  );
  assert.ok(
    sysPrompt.includes('a casual tone'),
    `tone substitution: ${sysPrompt}`,
  );
  assert.ok(
    sysPrompt.includes('The quick brown fox jumps over the lazy dog.'),
    `sourceText substitution: ${sysPrompt}`,
  );
  // Step 8: capability propagation.
  assert.deepEqual(node.capabilities, ['cacheable']);
  console.log('✓ case 1 — 1-node chain expansion');
}

// ─── Case 2: positive, 2-node chain with edges ─────────────────────────

{
  const result = await expandChainFromRegistry({
    registryDir: SAMPLE_REGISTRY,
    packName: SAMPLE_PACK_NAME,
    chainId: 'vendor.openwop.workflow-chain-sample.fetch-and-summarize',
    parameters: {
      url: 'https://example.com/article',
      targetLength: 'executive-summary',
    },
    expansionId: 'ef01',
  });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 1);

  // Both nodes get the prefix.
  const fetchNode = result.nodes.find((n) => n.id.endsWith('_fetch'))!;
  const summarizeNode = result.nodes.find((n) => n.id.endsWith('_summarize'))!;
  assert.ok(fetchNode, 'fetch node present');
  assert.ok(summarizeNode, 'summarize node present');

  // Param substitution in the fetch node.
  assert.equal((fetchNode.config as { url: string }).url, 'https://example.com/article');

  // Edge rewriting — both endpoints reference fragment-internal nodes
  // so both get the prefix; port suffixes preserved.
  const edge = result.edges[0]!;
  const prefix = 'vendor_openwop_workflow-chain-sample_fetch-and-summarize_ef01_';
  assert.equal(edge.from, `${prefix}fetch.body`);
  assert.equal(edge.to, `${prefix}summarize.sourceText`);

  // Capability propagation: both nodes inherit `side-effectful`.
  assert.deepEqual(fetchNode.capabilities, ['side-effectful']);
  assert.deepEqual(summarizeNode.capabilities, ['side-effectful']);
  console.log('✓ case 2 — 2-node chain with edge rewriting + capability propagation');
}

// ─── Case 3: pack not found ────────────────────────────────────────────

await expectThrow(
  () =>
    expandChainFromRegistry({
      registryDir: SAMPLE_REGISTRY,
      packName: 'vendor.acme.does-not-exist',
      chainId: 'whatever',
      parameters: {},
    }),
  'pack_not_found',
  'case 3 — unknown pack',
);
console.log('✓ case 3 — pack not found');

// ─── Case 4: chain id not in pack ──────────────────────────────────────

await expectThrow(
  () =>
    expandChainFromRegistry({
      registryDir: SAMPLE_REGISTRY,
      packName: SAMPLE_PACK_NAME,
      chainId: 'vendor.openwop.workflow-chain-sample.does-not-exist',
      parameters: {},
    }),
  'chain_not_found',
  'case 4 — unknown chainId',
);
console.log('✓ case 4 — chain not found');

// ─── Case 5: pack found but kind != "workflow-chain" ───────────────────

{
  const tmpDir = mkdtempSync(join(tmpdir(), 'openwop-chain-test-'));
  const fakePackName = 'vendor.test.fake-node-pack';
  const fakePackDir = join(tmpDir, fakePackName);
  mkdirSync(fakePackDir, { recursive: true });
  writeFileSync(
    join(fakePackDir, 'pack.json'),
    JSON.stringify({
      name: fakePackName,
      version: '1.0.0',
      kind: 'node',
      engines: { openwop: '>=1.0.0' },
      nodes: [{ typeId: 'vendor.test.fake.node', main: 'index.mjs' }],
    }),
  );
  await expectThrow(
    () =>
      expandChainFromRegistry({
        registryDir: tmpDir,
        packName: fakePackName,
        chainId: 'whatever',
        parameters: {},
      }),
    'pack_kind_invalid',
    'case 5 — node pack rejected on the chain-expansion path',
  );
  console.log('✓ case 5 — pack_kind_invalid for kind=node');
}

// ─── Case 6: RFC 0125 `triggerRule` survives expansion ─────────────────
//
// The fan-in / error-routing rule rides on the fragment edge and MUST be
// carried onto the expanded WorkflowEdge, exactly as `condition` is. Before
// this case existed the host dropped it SILENTLY: expansion succeeded, the
// edge looked correct, and the scheduler simply never saw the rule — so a
// chain authored with `any_failed` error-routing degraded to default fan-in
// with no error anywhere. Caught by the cross-repo drift gate
// (`scripts/check-workflow-chain-expansion-sync.mjs` in `openwop/openwop`),
// which compares this file's algorithm against the spec-authoritative copy.

{
  const chain: WorkflowChain = {
    chainId: 'vendor.test.chain.trigger-rule',
    version: '1.0.0',
    label: 'trigger-rule probe',
    description: 'two nodes, one edge carrying an RFC 0125 triggerRule',
    parameters: {},
    dag: {
      nodes: [
        { id: 'a', typeId: 'core.openwop.noop' },
        { id: 'b', typeId: 'core.openwop.noop' },
        { id: 'c', typeId: 'core.openwop.noop' },
      ],
      edges: [
        { from: 'a', to: 'b', triggerRule: 'any_failed' },
        { from: 'b', to: 'c' },
      ],
    },
  };

  const out = expandChain(chain, {
    expansionId: 'trig',
    params: {},
    isTypeIdResolvable: () => true,
  });

  assert.equal(
    out.edges[0]?.triggerRule,
    'any_failed',
    'case 6 — triggerRule MUST be carried onto the expanded edge (RFC 0125)',
  );
  // Anti-over-fire: an edge that declares no rule must not acquire one.
  assert.ok(
    !('triggerRule' in (out.edges[1] as object)),
    'case 6 — an edge without triggerRule must not gain the key',
  );
  // The rule must not disturb endpoint rewriting.
  assert.equal(out.edges[0]?.from, out.nodes[0]?.id, 'case 6 — `from` still rewritten');
  assert.equal(out.edges[0]?.to, out.nodes[1]?.id, 'case 6 — `to` still rewritten');

  console.log('✓ case 6 — RFC 0125 triggerRule survives expansion');
}

// ─── Case 7: whole-value `{{params.x}}` resolves RAW-TYPED (RFC 0013 WCP2) ──
//
// `workflow-chain-packs.md` §"Parameter substitution": a config string that
// is EXACTLY one `{{params.<name>}}` token resolves to the raw typed parameter
// value (object / array / number / boolean survive as their JSON type); a token
// EMBEDDED in surrounding text does literal string substitution. The spec-
// authoritative conformance copy gained this in openwop/openwop#819
// (2026-07-05); this mirror did not, and every typed chain parameter reached
// the node config stringified (`"42"`, `"[object Object]"`-class coercions)
// until the cross-repo drift gate was re-read. This case pins the rule here.

{
  const chain: WorkflowChain = {
    chainId: 'vendor.test.chain.whole-value',
    version: '1.0.0',
    label: 'whole-value probe',
    description: 'one node whose config mixes whole-value and embedded tokens',
    parameters: {
      count: { type: 'number' },
      flags: { type: 'object' },
      tags: { type: 'array' },
      on: { type: 'boolean' },
      name: { type: 'string' },
    },
    dag: {
      nodes: [
        {
          id: 'a',
          typeId: 'core.openwop.noop',
          config: {
            count: '{{params.count}}',
            flags: '{{params.flags}}',
            tags: '{{params.tags}}',
            on: '{{params.on}}',
            greeting: 'hello {{params.name}} x{{params.count}}',
            missing: '{{params.undeclared}}',
          },
        },
      ],
      edges: [],
    },
  } as unknown as WorkflowChain;

  const out = expandChain(chain, {
    expansionId: 'whole',
    params: { count: 42, flags: { a: 1 }, tags: ['x', 'y'], on: false, name: 'ada' },
    isTypeIdResolvable: () => true,
  });
  const cfg = (out.nodes[0] as { config: Record<string, unknown> }).config;
  assert.strictEqual(cfg.count, 42, 'case 7 — whole-value number stays a number');
  assert.deepStrictEqual(cfg.flags, { a: 1 }, 'case 7 — whole-value object stays an object');
  assert.deepStrictEqual(cfg.tags, ['x', 'y'], 'case 7 — whole-value array stays an array');
  assert.strictEqual(cfg.on, false, 'case 7 — whole-value boolean stays a boolean');
  assert.strictEqual(cfg.greeting, 'hello ada x42', 'case 7 — embedded tokens substitute as strings');
  assert.strictEqual(cfg.missing, '', 'case 7 — undeclared whole-value token collapses to the empty string');
  console.log('✓ case 7 — whole-value {{params.x}} resolves raw-typed; embedded tokens stringify');
}

console.log('\nworkflow-chain-expansion: 7/7 cases passed');
