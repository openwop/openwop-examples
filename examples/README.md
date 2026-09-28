# openwop Examples

Runnable example projects that demonstrate the openwop wire contract. Each example is self-contained — drop into the directory, `npm install`, `npm start`.

## Quick reference

Every runnable sample speaks v2: `OpenWOP-Version: 2` on every request, unversioned paths (`/runs`, `/runs/{runId}/events`, …), tenant-bound ids projected into one path segment (`tenant~2Fopaque`, `spec/v2/core/identity.md` §5), and an `Idempotency-Key` on every create. Each one checks discovery for the family it needs and exits 0 with a "not advertised by this host" message when the host does not serve it.

| Example | v2 family it needs | CI runs against | On the v2 reference host |
|---|---|---|---|
| [`tiny-workflow/`](./tiny-workflow/) | core runs | v2 reference host | runs end to end |
| [`streaming-client/`](./streaming-client/) | core runs + SSE | v2 reference host | runs end to end |
| [`idempotent-runs/`](./idempotent-runs/) | `idempotency` | v2 reference host | runs end to end |
| [`approval-workflow/`](./approval-workflow/) | `interrupt` | v2 reference host | runs end to end |
| [`branch-fork/`](./branch-fork/) | `replay` (`branch` in `modes`) | v2 reference host | runs end to end |
| [`mcp-tool/`](./mcp-tool/) | `mcp` (a server mount in `serverUrls`) | v2 reference host | runs end to end |
| [`multi-agent-cross-host/`](./multi-agent-cross-host/) | `a2a` (profile `a2a-1.0`, `agentCardUrl`) | v2 reference host | runs end to end (the host is the A2A peer) |
| [`branching-workflow/`](./branching-workflow/) | an installed `branching-demo` workflow + a concurrent DAG executor | v2 reference host | exits 0: the workflow is not installed there |
| [`node-pack-publishing/`](./node-pack-publishing/) | none — builds and signs a v2 manifest locally | dry-run | n/a |
| [`core-packs-lockfile/`](./core-packs-lockfile/) | none — verifies a v2 lockfile against `packs.openwop.dev` | dry-run (network) | n/a |
| [`mcp-stdio-bridge/`](./mcp-stdio-bridge/) | none — an HTTP-to-stdio MCP shim | not in CI | n/a |

## Env-var taxonomy

Defaults target the v2 reference host, so every sample "just works" with `npm start` once that host is up.

| Variable | Default | Used by |
|---|---|---|
| `OPENWOP_BASE_URL` | `http://127.0.0.1:3838` | every host-targeting sample |
| `OPENWOP_API_KEY` | `openwop-v2-dev-key` | same |
| `OPENWOP_WORKFLOW_ID` | (per-example default) | `approval-workflow`, `branch-fork`: override the workflow |
| `OPENWOP_WORKFLOW` | `conformance-noop` | `streaming-client` |
| `OPENWOP_MCP_TOOL` | `conformance-noop` | `mcp-tool`: the tool (workflowId) to call |
| `OPENWOP_PACK_REGISTRY_URL` | `https://packs.openwop.dev` | `node-pack-publishing --print-publish-cmd` |

## Running locally

```bash
# Terminal 1 — start the v2 reference host
cd examples/hosts/v2-reference && npm install --legacy-peer-deps && npm start

# Terminal 2 — run a sample
cd examples/approval-workflow && npm start

# Any other v2 host:
OPENWOP_BASE_URL=https://your-host.example \
OPENWOP_API_KEY=$YOUR_KEY \
  npm start --prefix examples/approval-workflow
```

The v1 hosts (`hosts/in-memory`, `hosts/sqlite`, `hosts/postgres`, `hosts/python`) stay v1 through the overlap; the samples no longer target them.

## CI behavior

`.github/workflows/examples.yml` runs every sample end-to-end. Each declares its `host:` target in the matrix:

- `host: v2-reference` — CI starts the v2 reference host on port 3838, then runs the sample.
- `host: in-memory` — CI starts the in-memory v1 host (no sample uses it today).
- `host: external` — runs only when the external-host secrets are set (no sample uses it today).
- `host: dry-run` — the sample needs no host.

## Adding an example

1. Drop a new dir under `examples/<name>/` with `package.json` + `README.md` + the example source.
2. README header MUST include the standard table:

   ```markdown
   | v2 family required | <family key(s) in the v2 discovery root> |
   | Host target        | <v2-reference / external / dry-run> |
   | Run modes          | <default / --flag / etc> |
   ```

3. Add a row to the matrix in `.github/workflows/examples.yml`.
4. The example MUST `process.exit(1)` on any unexpected status code or shape mismatch — silent success is forbidden. When the host does not advertise the family it needs, it exits 0 and says so; it never fakes the run.
5. Send `OpenWOP-Version: 2` on every request, use unversioned paths, project tenant-bound ids into path segments, and put an `Idempotency-Key` on creates.

## Workflow-definition examples (declarative JSON, no runner)

Separate from the runnable samples above, these directories hold declarative workflow definitions composing the [vendor.myndhyve.* pack catalog](https://packs.openwop.dev) end to end. They run on a host that has those packs (and, for most, an AI provider); the v2 reference host has neither. v2 defines no workflow-registration operation, so a host installs them through its own tooling, then `POST /runs` starts one.

| Directory | Pipeline | Packs composed (v2 tree) | v2 families the host needs |
|---|---|---|---|
| [`market-intel-pipeline/`](./market-intel-pipeline/) | VoC research → ad-angle generation (2 variants: full + AI-first) | 9 `vendor.myndhyve.market-intel-*` + `ads.copy.generate` | `aiProviders` + (production) `webResearch` |
| [`ads-publish-pipeline/`](./ads-publish-pipeline/) | Creative generation → publish to Meta / Google / TikTok (3 sibling variants) | 8 `vendor.myndhyve.ads-*` per variant | `aiProviders` (facet `imageGeneration`) + `secrets` (facet `resolveInPack`) |
| [`rag-grounded-chat/`](./rag-grounded-chat/) | Knowledge-base retrieval → AI chat with inline `[#N]` citations | `vendor.myndhyve.knowledge-tools` + `core.openwop.ai` | `knowledge` + `aiProviders` |

Pipelines compose downstream of each other:
- `market-intel-pipeline/market-intel-research.json`'s `audience-targeting.outputs.targetingPacks.meta` maps directly into `ads-publish-pipeline/ads-creative-publish-meta.json`'s `targeting` variable.
- `rag-grounded-chat/` is the smallest reference for the `knowledge` family — its 2-node shape is the building block for any RAG-augmented workflow.

**Not yet v2-shaped.** The definition bodies predate `schemas/v2/workflow-definition.schema.json`: dotted `id`s, bare `$.…` strings as node `inputs` instead of `PortValue` objects, and `metadata.packs` / `metadata.hostCapabilities`, which `WorkflowMetadata` does not admit. Their pack references are pinned to the v2 tree.

See [`docs/PACK-CATALOG.md`](https://github.com/openwop/openwop/blob/main/docs/PACK-CATALOG.md) for the full pack inventory grouped by domain.

**Drift gate** (`.github/workflows/examples.yml` → `validate-workflow-defs`): [`scripts/check-example-pack-refs.mjs`](../scripts/check-example-pack-refs.mjs) resolves every path through the registry's `/.well-known/openwop-registry.json` `endpoints.v2` and checks that every `metadata.packs[]` entry is a published, non-yanked version in the v2 tree, that every node typeId is shipped by a declared pack, and that every `node.config` key is declared in the pack's configSchema (read from the version's tarball). Run locally: `node scripts/check-example-pack-refs.mjs`, or against an [`openwop-registry`](https://github.com/openwop/openwop-registry) checkout: `node scripts/check-example-pack-refs.mjs --offline ../openwop-registry/registry/v2/index.json`.

## See also

- [`hosts/v2-reference/`](./hosts/v2-reference/) — the v2 reference host every sample defaults to.
- [`hosts/in-memory/`](./hosts/in-memory/), [`hosts/sqlite/`](./hosts/sqlite/) — v1 reference hosts ("build your own host" walkthrough), v1 through the overlap.
- [`spec/v2/core/`](https://github.com/openwop/openwop/tree/main/spec/v2/core) — the v2 prose the samples are written against.
- [`docs/PACK-CATALOG.md`](https://github.com/openwop/openwop/blob/main/docs/PACK-CATALOG.md) — the published packs grouped by domain.
