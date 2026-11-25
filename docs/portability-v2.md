# Cross-language portability at protocol v2

**Run date:** 2026-11-25. **Design:** `openwop-paper/evidence/portability/experiment-design.md` (Cell A, the cross-language cell), re-run at v2. The v1 result it replaces is `openwop-paper/evidence/portability/results.md` (TypeScript `in-memory` against the v1 Python host, 2026-06-06); both v1 hosts have since been removed. **Raw captures:** [`portability-v2/captures.json`](./portability-v2/captures.json), [`portability-v2/comparison.json`](./portability-v2/comparison.json). **Harness:** [`scripts/portability-v2.mjs`](../scripts/portability-v2.mjs).

## Setup

| | Host A | Host B |
|---|---|---|
| Implementation | `examples/hosts/v2-reference` 2.0.0-rc.1 (TypeScript, Node 22.13.1, `tsx`) | `examples/hosts/python` 2.0.0 (CPython 3.11.4, stdlib only) |
| Storage | SQLite `:memory:` (`better-sqlite3`) | SQLite file (stdlib `sqlite3`) |
| Contract | `@openwop/spec-artifacts@2.49.6` | rows copied from the corpus, checked against `@openwop/spec-artifacts@2.49.14` |
| Discovery | `protocolVersions: ["1.11", "2.0"]`, 27 families, 35 fixtures | `protocolVersions: ["2.0"]`, 7 families, 10 fixtures |
| Shared code | none | none |

Both hosts load the same conformance fixture definitions (from `@openwop/openwop-conformance`; the Python host vendors nine of them from 2.49.14, byte-identical to the 2.49.6 copies the TypeScript host reads). For each workflow the harness sends `POST /runs { workflowId }` with `OpenWOP-Version: 2` and an `Idempotency-Key`, polls `GET /runs/{runId}` to a terminal or waiting state, resolves an approval through `POST /runs/{runId}/interrupts/{nodeId}` where there is one, reads the log through `GET /runs/{runId}/events/poll`, and validates every event against `schemas/v2/run-event.schema.json` (Ajv 2020, the spec-artifacts 2.49.6 copy). The two hosts run the same case concurrently.

```bash
node scripts/portability-v2.mjs \
  --host ts=http://127.0.0.1:3838=openwop-v2-dev-key \
  --host py=http://127.0.0.1:3840=openwop-python-dev-key \
  --schemas examples/hosts/v2-reference/node_modules/@openwop/spec-artifacts/schemas/v2 \
  --ajv-from examples/hosts/v2-reference --out docs/portability-v2
```

It exits 0 only when every compared class matches.

## Result

The three core workflows of the v1 experiment, then three that the v2 floor adds:

| Workflow | Terminal (TS / PY) | Event-type sequence | Events (TS / PY) | `run.completed` outputs | Schema-invalid events (TS / PY) | Portable |
|---|---|---|---|---|---|---|
| `conformance-noop` | completed / completed | identical | 4 / 4 | equal | 0 / 0 | yes |
| `conformance-delay` (`delayMs: 200`) | completed / completed | identical | 4 / 4 | equal | 0 / 0 | yes |
| `conformance-multi-node` | completed / completed | identical | 8 / 8 | equal | 0 / 0 | yes |
| `conformance-failure` | failed / failed | identical | 4 / 4 | n/a | 0 / 0 | yes |
| `conformance-approval`, resolved `accept` | completed / completed | identical | 8 / 8 | equal | 0 / 0 | yes |
| … its `mode: "replay"` fork from 0 | completed / completed | identical | 6 / 6 | equal; replayed `resumeValue` equals the recorded one | 0 / 0 | yes |
| `conformance-identity` | refused `404 not_found` / refused `404 not_found` | n/a | — | — | — | yes (same refusal) |

The sequences:

```
noop, delay   run.started → node.started → node.completed → run.completed
multi-node    run.started → (node.started → node.completed) ×3 → run.completed
failure       run.started → node.started → node.failed → run.failed
approval      run.started → node.started → interrupt.requested → node.suspended
              → interrupt.resolved → node.resumed → node.completed → run.completed
replay fork   run.started → node.started → interrupt.resolved → node.resumed → node.completed → run.completed
```

**3 / 3 core workflows are portable at v2**, as they were at v1: identical terminal state and identical ordered `RunEvent` type sequence across a TypeScript and a Python implementation, with every event valid against the v2 schema. The v2 floor also carries an interrupt round trip and a replay fork across the language boundary: the replayed run takes the recorded resolution on both hosts (no new `interrupt.requested`, the same `resumeValue`), which is the design's Cell B replay-fidelity class measured here across languages rather than across two durable TypeScript hosts.

## What changed since v1

| v1 finding | At v2 |
|---|---|
| Host-local representation differed: `sequence` absent on Python, `null` vs `{}` empty payloads | Gone. v2 makes `sequence` (from 0), `eventId`, `schemaVersion` and a payload object mandatory, and every event on both hosts validates against `run-event.schema.json`, so the comparison no longer needs a normalization table for these fields. `eventId`, `runId` and `timestamp` still differ and are not compared. |
| `conformance-identity` diverged: Python refused at creation (`422 capability_required`), TypeScript accepted and failed the node | Converged, but by scoping rather than by a spec rule. Neither v2 host lists `conformance-identity` in `fixtures[]`, and both answer `POST /runs` for an unregistered workflow with `404 not_found`. The v1 question (must a host reject a workflow naming an unadvertised node type at creation or at execution?) is still not settled by the spec; it is just not reached by this pair. |

## Threats and caveats

1. **Not independence.** Both hosts were written by the protocol steward, and the Python host was written with the SQLite host's behaviour in view (its README says so). This shows the v2 spec can be implemented consistently in two languages by its author; a non-steward host remains the decisive experiment.
2. **Coverage.** Six small fixtures. Event payloads are compared only for `run.completed` outputs and the replayed `resumeValue`; other payload fields (error codes, timings) are not diffed. Concurrent events do not arise in these workflows, so no partial-order comparison was needed.
3. **Floor, not full surface.** The Python host serves the core floor only (7 families). Anything outside it (webhooks, agents, MCP, A2A, artifacts) is not measured.
4. **Artifacts.** The design's artifact-equivalence class is not exercised: none of these fixtures emits an `Artifact`, and the Python host does not run `conformance-artifact-emit`.
