# OpenWOP host: Python (v2)

An OpenWOP **v2** host in Python 3.11, **standard library only**: `http.server` for HTTP and SSE, `sqlite3` for storage, `hmac`/`hashlib` for resume tokens and cursors. Nothing to `pip install`.

It exists for two reasons:

1. **Cross-language portability.** Every other v2 host in this repo is TypeScript. This one shares no code with them; it is written from the v2 spec and checked against the same conformance suite, so "the same workflow behaves the same on two independent implementations" can be measured at v2. The measurement is in [`docs/portability-v2.md`](../../../docs/portability-v2.md).
2. **A template for a non-Node host.** About 2,300 lines across six modules, small enough to read in one sitting.

> **Not for production.** One process per database file, one API-key lane, no rate limiting, no webhooks (see [What is left](#what-is-left)).

| | |
|---|---|
| Protocol | v2 only: `protocolVersions: ["2.0"]`, unversioned paths, `OpenWOP-Version: 2` |
| Families advertised | `auth` (api-key lane), `eventLog`, `idempotency`, `interrupt`, `limits`, `replay`, `runList` |
| Conformance | `@openwop/openwop-conformance@2.49.14 --target-major 2`: 944 of 945 tests pass; the one failure is the effect-seam manifest, as on the SQLite host ([conformance.md](./conformance.md)) |
| Storage | one SQLite file via stdlib `sqlite3` (`:memory:` for throwaway runs) |
| Default port | `3840` (v2-reference uses `3838`, sqlite `3839`) |

## Quick start

```bash
cd examples/hosts/python
PYTHONPATH=src python3 -m openwop_host
# [openwop-host-python 2.0.0] listening on http://127.0.0.1:3840 (OpenWOP 2.0; db …/data/openwop-host-python.sqlite; 10 fixtures)
```

The v2 samples run against it unchanged:

```bash
OPENWOP_BASE_URL=http://127.0.0.1:3840 OPENWOP_API_KEY=openwop-python-dev-key \
  npm test --prefix ../../tiny-workflow     # also streaming-client, idempotent-runs, approval-workflow, branch-fork
```

| Variable | Default | Purpose |
|---|---|---|
| `OPENWOP_HOST` / `OPENWOP_PORT` | `127.0.0.1` / `3840` | Bind address |
| `OPENWOP_API_KEY` | `openwop-python-dev-key` | Bearer key for tenant `openwop-python-tenant` |
| `OPENWOP_TENANT2_API_KEY` | _(unset)_ | A second key, bound to tenant `openwop-python-tenant-b`; set it (and `OPENWOP_TEST_TENANT_B_API_KEY` for the suite) to exercise cross-tenant refusals |
| `OPENWOP_SQLITE_PATH` | `./data/openwop-host-python.sqlite` | The database file; `:memory:` keeps nothing |
| `OPENWOP_MAX_RUN_DURATION_MS` | `600000` | `limits.maxRunDurationMs`; a run's `configurable.run.runTimeoutMs` is clamped to it |
| `OPENWOP_FIXTURES_DIR` | _(unset)_ | Extra fixture directory, read before the vendored `fixtures/` (point it at an installed `@openwop/openwop-conformance/fixtures`) |
| `OPENWOP_LOG_RESUME_TOKENS` | `false` | Log each interrupt's `ow2.` resume token, the host's stand-in for out-of-band delivery |

Checks: `python3 -m unittest discover -s tests -v` (set `OPENWOP_SPEC_ARTIFACTS_DIR` to an installed `@openwop/spec-artifacts` to also check the copied error rows and event types against the corpus). Conformance: see [conformance.md](./conformance.md).

## Layout

```
src/openwop_host/
├── contract.py   # error registry rows, v2 event types, id grammars, the `~` projection, time
├── store.py      # the SQLite schema and every read/write, under one lock
├── executor.py   # the fold, the run loop (one thread per run), interrupts, ow2 tokens
├── server.py     # the front door: negotiation, identity, idempotency, discovery, routes, SSE
├── fixtures.py   # which conformance fixtures load
└── __main__.py   # env parsing, signals
fixtures/         # the nine conformance fixtures this host runs, vendored from @openwop/openwop-conformance@2.49.14
tests/test_host.py
```

## How it works

**Storage and durability.** Runs, events, interrupts, idempotency records and the two MAC keys are rows in one file, written before the response that reports them (`persistence.md` §Durable acceptance). On boot every `pending`, `running` or `cancelling` run re-enters the executor and continues from its event log; `tests/test_host.py` SIGKILLs a host mid-run and checks that the next process finishes the run with one `run.started` and one `run.completed`. There is no claim or lease, so **two processes must not share a file**; the [SQLite host](../sqlite/) shows claim-based dispatch. No durability rung is claimed (that takes RFC 0158 evidence).

**Identity.** One lane, `api-key`. Each key is bound to one tenant and resolves to one Subject with issuer `urn:openwop-host-python:api-key`. Run and interrupt ids are tenant-bound (`<tenant>/<opaque>`) and travel projected into one path segment (`tenant~2Fopaque`, `identity.md` §5). A tenant segment that is not the caller's is `403 id_tenant_mismatch`; a bare id is `400 validation_error`.

**Events.** Append-only, `sequence` from 0, assigned under the store lock. Poll (`afterSequence`, long-poll `timeout`) and SSE (`id:`/`event:`/`data:`, `Last-Event-ID` as an exclusive cursor, `streamMode` `updates`/`values`/`messages`/`debug`, `bufferMs` batching, keep-alives, close on the terminal event) read the same log. SSE uses chunked transfer encoding so the connection survives the stream.

**Executor.** The log is the only state: every step re-folds the run's events, so a restart, a resolved interrupt and a fork all continue from what is recorded. Nodes run in topological order; `core.noop`, `core.identity`, `core.delay`, `core.fail`, `core.approvalGate`, `core.clarificationGate` and `core.interrupt` are executed. `configurable.run.recursionLimit` and `runTimeoutMs` are enforced with `cap.breached`. Cancel and pause (`immediate` or `drain-current-node`) are flags on the run row that the run's thread acts on.

**Interrupts.** A gate records `interrupt.requested` and `node.suspended` and the run waits. The re-entry key K is `<run>:<node>:<visit>`, where a replay fork uses its source run, so a replay finds the source's `interrupt.resolved` and applies it without raising a new interrupt. Resolve by run (`POST /runs/{runId}/interrupts/{nodeId}`) or by token (`GET`/`POST /interrupts/{token}`, `ow2.hs256.python-1.<payload>.<mac>`); both enforce the gate's `actions` and `approversList`, and exactly one resolver wins.

**Front door.** `OpenWOP-Version` absent, `2` or `2.<n>` is served; another major is `406 protocol_version_unsupported`; a malformed value is `400`. Every response carries `OpenWOP-Version: 2.0`, every error is `{ error, message, details? }` with a code copied from `spec/v2/errors.json`, and the error constructor refuses an unregistered code. Layer-1 idempotency (`Idempotency-Key`) covers every mutating operation.

**Operations.** `GET /.well-known/openwop` (closed v2 root, `ETag`), `POST /runs`, `GET /runs`, `GET /runs/{runId}`, `…/events`, `…/events/poll`, `…/cancel`, `POST /runs:bulk-cancel`, `…:pause`, `…:resume`, `…:fork` (`replay` | `branch`), `…/effects`, the interrupt routes above, and `GET /host/effect-seams`.

## Relation to the other hosts

It follows the [SQLite host](../sqlite/)'s structure section for section (it was written from that host's behaviour and the v2 spec), minus the v1-database compatibility and the claims. It imports nothing from any TypeScript host and needs no npm package to run; the error rows and event types it copies are checked against `@openwop/spec-artifacts` in the test suite. It replaces the v1-only Python host that used to live here.

## What is left

The same list as the SQLite host: webhooks (and with them the first outbound effect seam, which the one conformance failure asks for), audit-log integrity, annotations, telemetry, edge conditions and failure routing, sub-workflows, CORS preflight, rate limiting and revocable keys.
