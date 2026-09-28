# Node-Pack Publishing

Builds a v2 node-pack manifest, signs it the one way v2 signs a pack, verifies the signature, and (optionally) shows where a registry's v2 tree would serve it. **Defaults to `--dry-run`** — no network calls, no auth, safe to run anywhere.

| v2 family required | none (runs locally); `--print-publish-cmd` reads a registry's `/.well-known/openwop-registry.json` |
| Host target        | dry-run |
| Run modes          | default (dry-run) / `--print-publish-cmd` |

## What it does

1. Generates an ephemeral Ed25519 keypair.
2. Builds a v2 `pack.json` ([`schemas/v2/node-pack-manifest.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/node-pack-manifest.schema.json)): `kind: "node"`, an `engines.openwop` range with an explicit major ceiling (`>=2.0.0 <3.0.0`), a `runtime`, one node, and the closed signing block `{ keyId, scheme: "ed25519-canonical-json" }`. The name is under `private.local-example.*`, which MUST NOT appear in a public registry — safe by default.
3. Signs the RFC 8785 (JCS) bytes of `pack.json` — a detached 64-byte Ed25519 signature ([`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) §Signing). A signature over tarball bytes is not a v2 signature.
4. Verifies it with the public key, and checks that a manifest with a changed version does not verify.

## Run

```bash
npm start                              # dry-run
npm start -- --print-publish-cmd       # also read the registry's v2 endpoints (--live is a deprecated alias)
OPENWOP_PACK_REGISTRY_URL=https://your-registry.example npm start -- --print-publish-cmd
```

## Output (dry-run, a real run)

```
=== OpenWOP v2 node-pack publishing example ===
Mode: dry-run (default)

→ Generating Ed25519 keypair...
  ✓ keypair generated
→ Built pack.json:
  kind:     node
  name:     private.local-example.echo-tool
  version:  1.0.0
  engines:  openwop >=2.0.0 <3.0.0
  scope:    private.local-example (MUST NOT appear in a public registry)
  signing:  ed25519-canonical-json / keyId local-example-1

→ JCS bytes (520):
  {"description":"Reference example pack — one pure echo node, demonstration only.","engines":{"openwop":">=2.0.0 <3.0.0"}...

→ Ed25519 signature (64 bytes, base64): nDzdqb1ucqtbZpjwf1dWIsGAPrqtWCziqYFm/Fs0...
→ Public key (raw 32 bytes, base64):    QipUXkY2qWBUdDl1R0dUhS1dPRVbeQqXGx7wbl0mbug=

→ Verifying the signature against the public key...
  ✓ verifies; a manifest with a changed version does not

Re-run with --print-publish-cmd to see where this version would live in a
registry's v2 tree and how that registry accepts submissions.

✓ Dry-run complete (no network calls made).
```

`--print-publish-cmd` appends (a real run against `packs.openwop.dev`):

```
→ Registry: https://packs.openwop.dev/.well-known/openwop-registry.json
  name: openwop reference registry
  signing schemes: [ed25519-canonical-json]
  This version would live in the v2 tree at:
    versionManifest  https://packs.openwop.dev/v2/packs/private.local-example.echo-tool/-/1.0.0.json
    versionTarball   https://packs.openwop.dev/v2/packs/private.local-example.echo-tool/-/1.0.0.tgz
    versionSignature https://packs.openwop.dev/v2/packs/private.local-example.echo-tool/-/1.0.0.sig
    versionSbom      https://packs.openwop.dev/v2/packs/private.local-example.echo-tool/-/1.0.0.sbom.json

  Submissions: no write API; publish by github-pull-request at https://github.com/openwop/openwop-registry/pulls.
  Before submitting: register your keyId with the registry operator (its
  signingKeys[] entry names the namespaces the key may sign), use a public
  scope (vendor.<org>.* / community.<author>.*), and build a deterministic
  tarball containing pack.json and the runtime entry. The registry refuses a
  republished version, a bad signature, or an engine range without a ceiling.

✓ Publish plan printed (no submission made).
```

Registry paths come from the registry document's `endpoints.v2`; a client resolves them there rather than constructing them (`packs.md` §"The registry tree").

## What this teaches

- **The engine range.** `engines.openwop` is a `>=` lower bound plus an explicit `<` major ceiling. A v2 host treats a range with no upper bound as `<2.0.0` and refuses a range that does not admit its major with `pack_engine_unsupported`.
- **`kind` is required** on every bare and version manifest.
- **One signing scheme.** `signing` is `{ keyId, scheme }` and nothing else; the v1 `publicKeyRef` / `signatureRef` / `method` block fails validation. A verifier checks the signature against the issuing registry's key for `keyId` and that key's `permittedNamespaces`.
- **Canonical JSON.** Signing is over JCS bytes (sorted keys, no whitespace), so any verifier reproduces the exact input.

## What this does NOT do

- **Build a tarball.** A real publication packs `pack.json` and the runtime entry into a deterministic tarball; the example has no `dist/`.
- **Register the key.** A registry accepts only signatures from a `signingKeys[]` entry whose `status` is `active` and whose `permittedNamespaces` cover the pack name; the ephemeral key here is in no registry.
- **Submit anything.** `packs.openwop.dev` has no write API; it publishes through pull requests to [`openwop-registry`](https://github.com/openwop/openwop-registry) (`writeApi.publishMethod: github-pull-request`). To start a real pack, run `node scripts/new-pack.mjs <name>` there, which scaffolds from the registry's v2 template.

## See also

- [`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) — engine range, registry tree, signing, version manifests
- [`docs/PACK-AUTHOR-QUICKSTART.md`](https://github.com/openwop/openwop/blob/main/docs/PACK-AUTHOR-QUICKSTART.md) — the pack author path end to end
- [`SECURITY/threat-model-node-packs.md`](https://github.com/openwop/openwop/blob/main/SECURITY/threat-model-node-packs.md) — supply-chain threat model
