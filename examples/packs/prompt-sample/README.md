# `vendor.openwop.prompt-sample`

> Reference prompt pack proving [RFC 0028](https://github.com/openwop/openwop/blob/main/RFCS/0028-prompt-library-endpoints.md) §B end-to-end. In-tree only — NOT published to `packs.openwop.dev`. Status: example.

This pack is the canonical proof that the prompt-pack contract ([`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) §"The manifest schema family", [`schemas/v2/prompt-pack-manifest.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/prompt-pack-manifest.schema.json)) is implementable with real-world-shaped content. It exists to:

1. Exercise the new [`schemas/prompt-pack-manifest.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/prompt-pack-manifest.schema.json) against a non-trivial manifest.
2. Demonstrate the `kind: "prompt"` discriminator that distinguishes prompt packs from node packs (RFC 0003) and workflow-chain packs (RFC 0013) at the registry layer.
3. Surface real PromptTemplate shapes the reference [`promptStore.installPackTemplates()`](../../../apps/workflow-engine/backend/typescript/src/host/promptStore.ts) seam can be exercised against once the RFC 0028 §B install flow (signature + SRI + dependency resolution) lands.

## What's in the pack

Two templates — the minimal pair that lets a multi-agent workflow author point a `writer` + `critic` node pair at vendor-published prompts:

| `templateId` | `kind` | Purpose |
|---|---|---|
| `writer-system` | `system` | House-style writer system prompt. Pair with a `user`-kind template (host or workflow-supplied) carrying the topic + tone variables. `modelHints.temperature: 0.7` for editorial creativity. |
| `critic-system` | `system` | Adversarial editor system prompt. Surfaces the three weakest claims for revision without rewriting the draft. `modelHints.temperature: 0.2` for deterministic critique. |

Each template carries the full RFC 0027 §A wire shape — `templateId` + SemVer `version` + `kind` + `text` + optional `name` / `description` / `tags` / `modelHints`. The `meta.source` field is intentionally omitted; install-time validation per RFC 0028 §B populates it as `pack` with `packName: "vendor.openwop.prompt-sample"` + `packVersion: "1.0.0"`.

## Validating

The pack manifest validates against the canonical schema:

```bash
cd conformance
npx vitest run src/scenarios/spec-corpus-validity.test.ts
```

The two templates also validate individually against [`prompt-template.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/prompt-template.schema.json) — same validator the `prompt-template-shape.test.ts` server-free scenario uses.

## How a workflow author references this pack's templates

Once a host advertising `capabilities.prompts.packsSupported: true` installs this pack, workflow nodes reference the templates via the canonical stringy `PromptRef` form:

```jsonc
// WorkflowNode.config — writer node
{
  "systemPromptRef": "prompt:writer-system@1.0.0",
  "userPromptRef": "prompt:vendor.acme.writer-task@2.0.0"
}

// WorkflowNode.config — critic node
{
  "systemPromptRef": "prompt:critic-system@1.0.0"
}
```

When two installed packs ship the same `templateId`, the stringy form is rejected with `prompt_ref_ambiguous` and consumers MUST use the structured `PromptRef` object form with `libraryId` set to this pack's `name` (`vendor.openwop.prompt-sample`) per RFC 0028 §B "Conflict resolution".

## What this pack does NOT demonstrate

- **Pack signing.** The manifest carries no `signing` block, which a bare authoring-time `pack.json` MAY omit. A signed v2 pack carries the one closed block every kind shares ([`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) §Signing); the v1 `publicKeyRef` / `signatureRef` / `method` block fails validation:

  ```jsonc
  {
    "name": "vendor.acme.editorial-prompts",
    "version": "1.0.0",
    "kind": "prompt",
    // ... engines, prompts, ...
    "signing": { "keyId": "acme-1", "scheme": "ed25519-canonical-json" }
  }
  ```

  The signature is a detached Ed25519 signature over the RFC 8785 (JCS) bytes of `pack.json`, served next to the version in the registry's v2 tree (`<version>.sig`); a verifier checks it against the registry's key for `keyId` and that key's `permittedNamespaces`.
- **`dependencies` block.** Cross-pack composition is left to a follow-up RFC; this pack stands alone.
- **Install path.** The host's `installPackTemplates()` seam in [`promptStore.ts`](../../../apps/workflow-engine/backend/typescript/src/host/promptStore.ts) accepts pack-shaped templates but the full install flow (download tarball + verify signature + extract + register) is part of the deferred RFC 0028 §B install slice.

## See also

- [`RFCS/0028-prompt-library-endpoints.md`](https://github.com/openwop/openwop/blob/main/RFCS/0028-prompt-library-endpoints.md) — the RFC this pack closes the acceptance gate for.
- [`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) — the v2 pack contract: `kind`, the `engines.openwop` range (this manifest's `>=1.1.0 <3.0.0` admits majors 1 and 2), signing.
- [`schemas/v2/prompt-pack-manifest.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/prompt-pack-manifest.schema.json) — the manifest schema `pack.json` validates against.
- [`examples/packs/workflow-chain-sample/`](../workflow-chain-sample/) — the parallel RFC 0013 example pack (workflow-chain kind).
