# `core-packs-lockfile/` — a v2 workspace lockfile pinning four core packs

A reference [`pack-lockfile`](https://github.com/openwop/openwop/blob/main/schemas/v2/pack-lockfile.schema.json) that pins four core packs from the registry's **v2 tree** at `packs.openwop.dev`:

- `core.openwop.ai@1.4.1`
- `core.openwop.http@2.1.1`
- `core.openwop.mcp@1.1.3`
- `core.openwop.triggers@1.1.2`

Each record carries the tarball URL in the v2 tree (`resolved`), its SRI hash (`integrity`), the Ed25519 signature material (`signature`), and the pack's `peerDependencies` (v2 family keys, echoed for audit).

## Why this exists

A workspace records a lockfile alongside its workflow definitions; the resolver MUST honor the pinned versions on later installs instead of re-running range resolution. This file shows the shape against real published packs, and is useful for:

1. **Schema validity** — it validates against [`schemas/v2/pack-lockfile.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/pack-lockfile.schema.json).
2. **Reproducible installs** — an operator with the tarballs and this lockfile can install the four packs without re-resolving. The `resolved:` URLs point at `packs.openwop.dev`; substitute a local path when air-gapped (the `integrity` check still applies).
3. **Offline signature verification** — each `signature.{algorithm, publicKey, value}` carries the raw Ed25519 bytes, so a resolver verifies without re-fetching the registry's key.

## What the signature covers

v2 has one signing scheme, `ed25519-canonical-json` ([`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) §Signing): a detached 64-byte Ed25519 signature over the RFC 8785 (JCS) bytes of `pack.json` inside the tarball — **not** over the tarball bytes. `signature.value` is the version's `.sig` file base64-encoded; `signature.publicKey` is the raw 32-byte key of the signer (`keyId: openwop-team-1`, served at `/keys/openwop-team-1.pub`), base64-encoded. The tarball bytes are covered separately by `integrity`.

## Verifying

```bash
npm test            # or: node verify.mjs
```

[`verify.mjs`](./verify.mjs) downloads each pinned tarball, checks its SHA-256 against `integrity`, extracts `pack.json`, checks it is the pinned name and version and a v2 manifest (`kind` present, an `engines.openwop` ceiling that admits major 2), and verifies the signature over its JCS bytes. Real output:

```
✓ core.openwop.ai@1.4.1  kind=node engines=>=1.0.0 <3.0.0  integrity + signature verified
✓ core.openwop.http@2.1.1  kind=node engines=>=1.0.0 <3.0.0  integrity + signature verified
✓ core.openwop.mcp@1.1.3  kind=node engines=>=1.0.0 <3.0.0  integrity + signature verified
✓ core.openwop.triggers@1.1.2  kind=node engines=>=1.0.0 <3.0.0  integrity + signature verified
✓ all 4 pinned packs verified against https://packs.openwop.dev
```

A changed byte in any `signature.value` makes that row fail (`FAILED: signature`) and the script exit 1.

To re-pin to the registry's current `latest` versions:

```bash
node verify.mjs --generate && node verify.mjs
```

Both modes resolve registry paths through `/.well-known/openwop-registry.json` `endpoints.v2`; a client does not construct them ([`packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) §"The registry tree").

## What this is NOT

- **Not a resolver's output.** It pins four packs by hand, not the transitive closure of a real workspace's workflow definitions. A workspace generates its own lockfile at install.
- **Not a trust decision.** Verifying the signature proves the registry's `openwop-team-1` key signed this `pack.json`; whether to trust that key for the `core.openwop.*` namespace is the registry's `signingKeys[].permittedNamespaces`, which a resolver checks separately.

## See also

- [`schemas/v2/pack-lockfile.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/pack-lockfile.schema.json) — normative shape.
- [`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) — engine range, registry tree, signing, version manifests.
- [`openwop-registry`](https://github.com/openwop/openwop-registry) — the registry source; `registry/v2/` is the tree these URLs serve.
