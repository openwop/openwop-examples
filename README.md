# openwop-examples

Reference hosts and runnable examples for the [OpenWOP protocol](https://github.com/openwop/openwop).

Carved out of the `openwop/openwop` spec corpus (full history preserved) so the
protocol repo stays a lean spec + conformance contract.

## Layout

- `examples/hosts/` — reference host implementations of the OpenWOP REST + SSE surface:
  - **`v2-reference/`** — **the v2 reference host**: implemented from `spec/v2/core/*.md` and the
    generated v2 documents, never adapted from a v1 host. Certified on the 2.x suite (see its
    `conformance.md`). Start here for a new integration — v2 is the current protocol major.
  - `sqlite/` — durable single-file **v2** host (`better-sqlite3`): claim-based dispatch, crash
    resume, and a walkthrough of porting a v1 host; serves the core run floor
  - `python/` — **v2** host in Python 3.11, **stdlib only** (`http.server`, `sqlite3`): the same core
    floor, sharing no code with the TypeScript hosts, so cross-language portability can be measured
    at v2 ([`docs/portability-v2.md`](docs/portability-v2.md))
  - `postgres/` — production-shaped **v2** host (`pg`, or PGlite in process): several host processes
    share one Postgres, claims are session-level advisory locks, and every write lands in a
    hash-chained, Ed25519-checkpointed audit log (`GET /audit/verify`)
  - `wasm-sandbox/` — RFC 0035 sandboxed-execution reference
- `examples/` (top level) — runnable workflow samples (`tiny-workflow`, `approval-workflow`,
  `streaming-client`, `mcp-tool`, `branch-fork`, …). Samples are `fetch`-only, speak v2, and default
  to the v2 reference host; see [`examples/README.md`](examples/README.md) for what each one needs.

> **v2 only.** v1 reached end of support on 2026-10-04 (RFC 0234), and no v1 host remains under
> `hosts/`: `sqlite` and `postgres` have been ported to v2, `python` rewritten for it, and the v1-only
> `in-memory` host removed. Build new hosts against `hosts/v2-reference/` and measure them with `@openwop/openwop-conformance` at
> `--target-major 2`.

## Quick start

```bash
# boot the v2 reference host
( cd examples/hosts/v2-reference && npm install --legacy-peer-deps && npm start )   # serves http://127.0.0.1:3838

# in another shell, run v2 samples against it
( cd examples/tiny-workflow && npm test )        # discovery → POST /runs → poll to completed
( cd examples/approval-workflow && npm test )    # suspend at an approval gate, resolve it, complete
( cd examples/streaming-client && npm test )     # the run's event stream over SSE
```

Every sample sends `OpenWOP-Version: 2`, uses the unversioned v2 paths (`/runs`, `/runs/{runId}/events`),
and projects tenant-bound run ids into one path segment (`tenant~2Fopaque`).

## Conformance

These hosts are measured against the published `@openwop/openwop-conformance` suite (2.x is
`latest`; it targets major 1 or 2 per host). `v2-reference/` carries its own certification
bundle and is a row in the corpus [`INTEROP-MATRIX.md`](https://github.com/openwop/openwop/blob/main/INTEROP-MATRIX.md)
v2 table. The host-conformance regression gates (SQLite soak + Postgres) live in the
[`openwop/openwop`](https://github.com/openwop/openwop) repo (co-located with the suite),
which checks this repo out to obtain the host source. `examples.yml` here runs the samples
against the v2 reference host, typechecks and tests the SQLite and Postgres hosts (the Postgres job
against a real Postgres service, two host processes on one database), tests the Python host, and validates that workflow-definition pack references resolve
against the live registry at [`packs.openwop.dev`](https://packs.openwop.dev).

## Portability

[`docs/portability-v2.md`](docs/portability-v2.md) runs the same workflows against the TypeScript v2
reference host and the Python host and compares terminal state and the `RunEvent` type sequence
(`scripts/portability-v2.mjs` re-runs it).

## License

Apache-2.0 (see [`LICENSE`](./LICENSE)).
