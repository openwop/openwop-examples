# rag-grounded-chat

> 2-node reference workflow exercising the [`knowledge`](https://github.com/openwop/openwop/blob/main/spec/v2/core/capabilities.md#-knowledge) capability family. Composes the [`vendor.myndhyve.knowledge-tools`](https://packs.openwop.dev/v2/packs/vendor.myndhyve.knowledge-tools/index.json) pack (RAG retrieval + prompt augmentation) with the spec-canonical [`core.openwop.ai`](https://packs.openwop.dev/v2/packs/core.openwop.ai/index.json) pack (free-form LLM chat). Demonstrates how to produce a cited answer from a knowledge base with zero ad-hoc RAG plumbing.

## The workflow

| Workflow | Use case | Nodes |
|---|---|---|
| [`rag-grounded-chat.json`](./rag-grounded-chat.json) | End-user asks a natural-language question; you want the model to answer using ONLY content from your knowledge base, with inline `[#N]` citations the UI can render as footnotes. | 2 |

## Pipeline

```
┌─────────────────────────────────────┐
│ knowledge.augment-prompt            │  Retrieves chunks via ctx.knowledge.retrieve,
│ → augmentedUserMessage + citations[]│  then builds an AI-ready user prompt:
│                                     │    - grounding header
│                                     │    - === Sources === block with [#N] markers
│                                     │    - the user's original question
└────────────────┬────────────────────┘
                 │
┌────────────────▼────────────────────┐
│ core.ai.chatCompletion              │  System prompt instructs the model to
│ → text answer                       │  cite [#N] markers; user message is the
│                                     │  augmented prompt from upstream.
└─────────────────────────────────────┘
```

## Required host capabilities

| Capability | Used by |
|---|---|
| `knowledge` | `augment-question` (calls `ctx.knowledge.retrieve`) |
| `aiProviders` | `answer-with-sources` (routes via `ctx.callAI`) |

## Output shape

The terminal `answer-with-sources` node returns the model's text. The upstream `augment-question` node's outputs are also persisted on the run:

| Field | Source node | Use |
|---|---|---|
| `augment-question.outputs.citations` | `knowledge.augment-prompt` | Render footnotes in the UI. Each `{ marker, sourceId, documentTitle, headingPath, pageNumber, relevanceScore }` matches the `[#N]` markers the model is instructed to cite. |
| `augment-question.outputs.sources` | `knowledge.augment-prompt` | De-duplicated source list (one entry per document/asset, not per chunk). |
| `augment-question.outputs.hasResults` | `knowledge.augment-prompt` | `false` when retrieval returned 0 chunks — UI can short-circuit before showing a no-source answer. |
| `answer-with-sources.outputs.content` | `core.ai.chatCompletion` | The AI's text with inline `[#N]` citations matching the citations array. |
| `answer-with-sources.outputs.usage` | `core.ai.chatCompletion` | Token usage for cost attribution. |

## Activation

This definition runs on a host that has the packs and a knowledge backend; the v2 reference host (`examples/hosts/v2-reference`) has neither, so it is not runnable there.

1. The host advertises the `knowledge` and `aiProviders` families in its v2 discovery document (`GET /.well-known/openwop` with `OpenWOP-Version: 2`), with at least one provider matching `aiProvider`. (`metadata.hostCapabilities` names them by v2 family key; `host.knowledge` is the v1 alias, `spec/v2/peer-dependency-aliases.json`.)
2. The host's knowledge adapter is wired to a real RAG backend (vector store + BM25 + optional rerank).
3. The host resolves `vendor.myndhyve.knowledge-tools@1.0.1` and `core.openwop.ai@1.4.1` from the registry's [v2 tree](https://packs.openwop.dev/.well-known/openwop-registry.json) (`endpoints.v2`).
4. Install the workflow through the host's own tooling. v2 defines no workflow-registration operation; `GET /workflows/{workflowId}` reads an installed one.
5. Start a run: `POST /runs` with `OpenWOP-Version: 2`, an `Idempotency-Key`, and `{ "workflowId": "<the installed id>", "inputs": { "userQuestion": "…", "aiProvider": "…", "aiModel": "…" } }`. Follow it with `GET /runs/{runId}/events` (SSE) or `GET /runs/{runId}/events/poll`, the run id projected as one path segment (`tenant~2Fopaque`).

See [`spec/v2/core/runs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/runs.md) and [`spec/v2/core/events.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/events.md) for the run lifecycle.

**Not yet v2-shaped.** The definition body predates `schemas/v2/workflow-definition.schema.json` and does not validate against it: the `id` carries dots (v2: `^[a-z][a-z0-9_-]*$`), node `inputs` are bare `$.…` strings and literals rather than `PortValue` objects (`{ "type": "expression", "expression": "…" }` / `{ "type": "static", "value": … }`), and `metadata.packs` / `metadata.hostCapabilities` are not `WorkflowMetadata` members. The pack references are checked against the v2 tree in CI (`scripts/check-example-pack-refs.mjs`).

## When to override `retrievalQuery`

`knowledge.augment-prompt` defaults `retrievalQuery` to `userMessage`. Override when the user's natural-language phrasing would retrieve poorly:

| `userQuestion` | Better `retrievalQuery` |
|---|---|
| "How does it work?" | "product onboarding flow" |
| "Can I cancel anytime?" | "subscription cancellation policy" |
| "Why is this slow?" | "performance troubleshooting database queries" |

The user-facing prompt still shows the original question; only retrieval is influenced.

## When the knowledge base has no answer

If `knowledge.augment-prompt` returns `hasResults: false`, the augmented user message uses a "no source material" header. The `core.ai.chatCompletion` system prompt in this workflow instructs the model to say so honestly rather than inventing facts. Two patterns for handling this:

1. **Soft path** (this workflow): trust the model's "I don't know" answer; the UI shows it as-is.
2. **Hard gate**: insert a `core.openwop.data.branch` node after `augment-question` that short-circuits to a canned "no information available" response when `hasResults === false`, skipping the AI call entirely. Saves tokens for low-coverage queries.

## What's NOT in this JSON

- **Multi-turn conversation history** — single-turn Q&A. To support follow-up questions, accumulate previous turns in a run variable + extend `answer-with-sources.inputs.messages[]` to include them before the new user message. Note that retrieval still uses the latest question only unless you build a query-rewriter upstream.
- **Reranking** — handled host-side inside `ctx.knowledge.retrieve` if the host's adapter is wired to a reranker (Vertex AI rerank, Cohere rerank, etc.). The pack is reranker-agnostic.
- **Citation enforcement** — the system prompt asks the model to cite; this workflow does not post-validate that the response actually contains `[#N]` markers. To enforce, replace `core.ai.chatCompletion` with `core.ai.structuredOutput` + a JSON schema requiring `citationMarkers[]` to be non-empty.

## See also

- [`docs/PACK-CATALOG.md`](https://github.com/openwop/openwop/blob/main/docs/PACK-CATALOG.md) — categorized inventory of all 62 published packs
- [`spec/v2/core/capabilities.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/capabilities.md#-knowledge) — the `knowledge` capability family
- [`packs/vendor.myndhyve.knowledge-tools/README.md`](https://github.com/openwop/openwop-registry/blob/main/packs/vendor.myndhyve.knowledge-tools/README.md) — node-level details + score-filtering knobs
- [`examples/market-intel-pipeline/`](../market-intel-pipeline/) — multi-pack composition reference
- [`examples/ads-publish-pipeline/`](../ads-publish-pipeline/) — end-to-end creative + publish pipeline

## License

Apache-2.0.
