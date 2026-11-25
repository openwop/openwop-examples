# `vendor.openwop.rust-hello` — reference WASM node pack

A minimal Rust → WebAssembly node pack that proves the RFC 0008 ABI v1 works end-to-end across an independent toolchain. The smallest possible pack that exercises every required ABI export (`openwop_abi_version`, `openwop_pack_name`, `openwop_node_count`, `openwop_node_id_at`, `openwop_alloc`, `openwop_free`, `openwop_node_invoke`) and at least one import (`openwop_log`).

## What it does

One node typeId: **`vendor.openwop.rust-hello.greet`**.

- **Input:** `{ "name": "<string>" }`
- **Output:** `{ "greeting": "Hello, <name>!" }`
- When `name` is omitted, defaults to `"world"`.
- Logs the greeting via `openwop_log` at level `info` (2) before returning.

## Build

Requires the Rust toolchain with the `wasm32-unknown-unknown` target:

```bash
rustup target add wasm32-unknown-unknown
cd examples/packs/rust-hello
cargo build --target wasm32-unknown-unknown --release
```

Output: `target/wasm32-unknown-unknown/release/rust_hello.wasm` (~5–10 KiB stripped).

## Load it into a host

No host in this repo loads WASM node packs from `examples/packs/` today: the v1 in-memory host that did (`hosts/in-memory/src/wasm-loader.ts`) was removed when v1 reached end of support (RFC 0234). A v2 host that runs WASM packs advertises `nodePackRuntimes.wasm` in its discovery document ([`spec/v2/core/node-pack-runtimes.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/node-pack-runtimes.md)) and lists the pack in `loadedPacks[]` once it is loaded. Exercise the node with a workflow whose first node uses the typeId `vendor.openwop.rust-hello.greet`; the conformance fixture `conformance-wasm-pack-roundtrip` does exactly that, and a successful run's `node.completed` event carries `output.greeting: "Hello, openwop!"` for `inputs.name = "openwop"`.

For sandboxed execution of WASM modules (RFC 0035), see [`hosts/wasm-sandbox/`](../../hosts/wasm-sandbox/).

## Implementation notes

### Packed-i64 return encoding

RFC 0008 §B defines `openwop_node_invoke` and friends with multi-value `(i32 i32)` returns. Stable Rust on `wasm32-unknown-unknown` does not emit native WASM multi-value by default. This pack uses the RFC-allowed packed-i64 alternative:

```
low 32 bits  = pointer
high 32 bits = length
```

The reference host loader detects packed-i64 vs multi-value at instantiation time and unpacks accordingly.

### Caller-owned allocation (RFC 0008 §E)

When this pack returns a (ptr, len), the host MUST call `openwop_free(ptr, len)` after reading. Every export here that returns a packed-i64 result has been allocated via the pack's exported `openwop_alloc`.

### Deliberately no JSON parser

The reference pack parses `inputs.name` by hand (looking for `"name":"..."`) to keep the WASM binary tiny. Production packs should use `serde_json` or similar. The binary at `-O s` opt-level with LTO + abort-on-panic strips to ~5–10 KiB; with serde it grows by ~100 KiB.

### No WASI

This pack uses no WASI imports. It declares only `openwop_log` under the `openwop` import namespace. Hosts that don't provide a WASI shim still load this pack correctly.

## Manifest and publishing

`pack.json` is a v2 manifest ([`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md)): `kind: "node"`, an `engines.openwop` ceiling that admits major 2 (`>=1.1.0 <3.0.0`), and no `signing` block. The ABI version is read from the module's `openwop_abi_version()` export and the memory cap comes from the host (`nodePackRuntimes.wasm` in discovery, [`spec/v2/core/node-pack-runtimes.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/node-pack-runtimes.md)), so the manifest carries neither.

A host that loads the pack straight from `examples/packs/` trusts the filesystem; there is no `signing` block to check.

This pack is not in the registry's v2 tree. Its v1 artifact (`registry/v1/…/vendor.openwop.rust-hello/-/1.0.0`) is yanked. The registry's `scripts/build-pack-tarball.mjs` bundles the file `runtime.entry` names (openwop-registry #78), so a WASM pack publishes once its module is built (`cargo build --target wasm32-unknown-unknown --release`). To start a new pack, use `node scripts/new-pack.mjs <name>` in [`openwop-registry`](https://github.com/openwop/openwop-registry), which scaffolds from the registry's v2 template; see the [pack author quickstart](https://github.com/openwop/openwop/blob/main/docs/PACK-AUTHOR-QUICKSTART.md).

## See also

- [`RFCS/0008-wasm-abi.md`](https://github.com/openwop/openwop/blob/main/RFCS/0008-wasm-abi.md) — the ABI spec this pack implements
- [`spec/v2/core/packs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/packs.md) — pack manifest format + distribution
- [`examples/hosts/wasm-sandbox/`](../../hosts/wasm-sandbox/) — the RFC 0035 sandboxed WASM executor
- [`conformance/fixtures/conformance-wasm-pack-roundtrip.json`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-wasm-pack-roundtrip.json) — fixture that exercises the pack end-to-end
