# openwop-examples

Reference hosts and runnable examples for the [OpenWOP protocol](https://github.com/openwop/openwop).

Carved out of the `openwop/openwop` spec corpus (full history preserved) so the
protocol repo stays a lean spec + conformance contract.

## Layout

- `examples/hosts/` — reference host implementations of the OpenWOP REST + SSE surface:
  - `in-memory/` — minimal, dependency-free (Node stdlib); the default target for samples
  - `sqlite/` — durable single-file host (`better-sqlite3`)
  - `postgres/` — production-profile host (`pg`; pglite for in-process tests)
  - `wasm-sandbox/` — RFC 0035 sandboxed-execution reference
- `examples/` (top level) — runnable workflow samples (`tiny-workflow`, `approval-workflow`,
  `streaming-client`, `mcp-tool`, …). Samples are `fetch`-only and default to the in-memory host.

## Quick start

```bash
# boot the dependency-free reference host
( cd examples/hosts/in-memory && npm install && npm start )   # serves http://127.0.0.1:3737

# in another shell, run a sample against it
( cd examples/tiny-workflow && OPENWOP_BASE_URL=http://127.0.0.1:3737 npm test )
```

## Conformance

These hosts are measured against the published `@openwop/openwop-conformance` suite. The
host-conformance regression gates (SQLite soak + Postgres) live in the
[`openwop/openwop`](https://github.com/openwop/openwop) repo (co-located with the suite),
which checks this repo out to obtain the host source. `examples.yml` here builds/tests the
hosts and runs the samples, and validates that workflow-definition pack references resolve
against the live registry at [`packs.openwop.dev`](https://packs.openwop.dev).

## License

Apache-2.0 (see `LICENSE` in the spec corpus).
