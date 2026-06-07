# `@openwop/openwop-host-wasm-sandbox` — RFC 0035 real-isolation reference host

A reference OpenWOP host that executes pack-loaded typeIds as **WebAssembly modules** under real isolation, implementing the [RFC 0035](https://github.com/openwop/openwop/blob/main/RFCS/0035-sandbox-execution-contract.md) sandbox execution contract. It is the **real-isolation reference** that the protocol needed: until this host, `SECURITY/invariants.yaml` carried the eight `node-pack-sandbox-*` rows at `reference-impl` tier with the rationale *"no reference host executes pack-loaded typeIds in a sandbox"* — the workflow-engine `node:vm` MVP proved the wire contract but is escapable by construction, not a production isolation boundary.

## Why WASM

A WebAssembly module has **no ambient host access** — every interaction with the outside world is an *explicit declared import*. That makes seven of the eight RFC 0035 §B invariants hold *by construction*, not by interception:

| RFC 0035 §B invariant | How WASM enforces it |
|---|---|
| `fs-gated` / `no-env` / `network-gated` / `no-process` | The module has no syscalls. An escape attempt can only be a **declared import**; the host statically inspects `WebAssembly.Module.imports()` and refuses any import it did not grant — failing closed **before instantiation** (hostile code never runs). Classified to `sandbox_escape_attempt` + the matching `escapeKind`. |
| `capability-gate-respected` | An `openwop.<name>` import whose `<name>` is not in `allowedHostCalls` → `sandbox_capability_denied` with the requested capability. |
| `memory-cap` | The host provides the module's linear memory with a fixed `maximum`; an access beyond the bound traps → `sandbox_memory_exceeded`. |
| `isolated-context` | A fresh `WebAssembly.Instance` (in a fresh worker) per invocation — no module state survives across calls. |
| `timeout` | The invocation runs on a dedicated **worker thread**; a main-thread kill-timer terminates it at the wall-clock cap → `sandbox_timeout` (a same-thread timer cannot interrupt a synchronous WASM loop). |

`node-pack-sandbox-no-eval` is JS-runtime-specific (WASM has no `eval`/`new Function`) and stays exempt per RFC 0035 — WASM graduates exactly the seven cross-runtime invariants the RFC anticipates.

## Layout

- `src/wasm-sandbox.ts` — the `invokeSandboxed(wasmBytes, config, entry?, arg?)` executor.
- `src/sandbox-worker.mjs` — the per-invocation worker that instantiates + runs one module.
- `fixtures/*.wat` + `*.wasm` — the misbehaving + well-behaved conformance fixtures (built by `scripts/build-fixtures.mjs` with `wabt`, a build-time-only dependency; both source and binary are committed).
- `test/sandbox.test.ts` — the RFC 0035 §B behavioral suite: 11 assertions against real `.wasm`, no placeholders, no mocks.

## Run

```sh
npm install
npm run build-fixtures   # regenerate fixtures/*.wasm from the WAT (optional; committed)
npm test                 # RFC 0035 §B behavioral conformance — 11/11
npm run typecheck
```

## Status

The behavioral suite passes 11/11 against real WebAssembly isolation. The graduation of the seven `node-pack-sandbox-*` invariants from `reference-impl` to `protocol` tier in `SECURITY/invariants.yaml` is the **immediate next step**, gated (per the gate in `scripts/check-security-invariants.sh`) on the backing conformance scenario landing under `conformance/src/scenarios/` — sequenced deliberately, not asserted prematurely (cf. the reverted `5864a2f` premature graduation). RFC 0035 `Active → Accepted` remains adoption-gated on a **non-steward** sandbox-executing host.
