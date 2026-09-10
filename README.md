# openwop-examples

Reference hosts and runnable examples for the [OpenWOP protocol](https://github.com/openwop/openwop).

Carved out of the `openwop/openwop` spec corpus (full history preserved) so the
protocol repo stays a lean spec + conformance contract.

## Layout

- `examples/hosts/` — reference host implementations of the OpenWOP REST + SSE surface:
  - **`v2-reference/`** — **the v2 reference host**: implemented from `spec/v2/core/*.md` and the
    generated v2 documents, never adapted from a v1 host. Certified on the 2.x suite (see its
    `conformance.md`). Start here for a new integration — v2 is the current protocol major.
  - `in-memory/` — minimal, dependency-free (Node stdlib) **v1** host; the default target for the samples
  - `sqlite/` — durable single-file v1 host (`better-sqlite3`)
  - `postgres/` — production-profile v1 host (`pg`; pglite for in-process tests)
  - `python/` — v1 host in Python (stdlib)
  - `wasm-sandbox/` — RFC 0035 sandboxed-execution reference
- `examples/` (top level) — runnable workflow samples (`tiny-workflow`, `approval-workflow`,
  `streaming-client`, `mcp-tool`, …). Samples are `fetch`-only and default to the in-memory host.

> **v1 and v2.** v1 hosts are not retired: through the overlap a host advertises both majors and
> keeps `preferredVersion` on `1.x` by MUST (`spec/v2/core/versioning.md` §1.1), so the v1 hosts
> here remain correct reference implementations of the v1 track until v1 end-of-support. The
> `@openwop/openwop-conformance` 2.x suite measures either major (`--target-major`).

## Quick start

```bash
# boot the dependency-free reference host
( cd examples/hosts/in-memory && npm install && npm start )   # serves http://127.0.0.1:3737

# in another shell, run a sample against it
( cd examples/tiny-workflow && OPENWOP_BASE_URL=http://127.0.0.1:3737 npm test )
```

## Conformance

These hosts are measured against the published `@openwop/openwop-conformance` suite (2.x is
`latest`; it targets major 1 or 2 per host). `v2-reference/` carries its own certification
bundle and is a row in the corpus [`INTEROP-MATRIX.md`](https://github.com/openwop/openwop/blob/main/INTEROP-MATRIX.md)
v2 table. The host-conformance regression gates (SQLite soak + Postgres) live in the
[`openwop/openwop`](https://github.com/openwop/openwop) repo (co-located with the suite),
which checks this repo out to obtain the host source. `examples.yml` here builds/tests the
hosts and runs the samples, and validates that workflow-definition pack references resolve
against the live registry at [`packs.openwop.dev`](https://packs.openwop.dev).

## License

Apache-2.0 (see `LICENSE` in the spec corpus).
