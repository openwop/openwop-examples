# OpenWOP host: SQLite (v2)

A single-process OpenWOP **v2** host backed by one SQLite file. Runs, events, interrupts and idempotency records are rows in that file, so a run outlives the process executing it: kill the host mid-run, start it again, and the run continues from its event log.

This README is also a **build-your-own-host walkthrough**. `src/server.ts` is one file meant to be read top to bottom; the sections below follow its `// ─── N. … ───` markers. It was a v1 host, and the last section shows what porting a v1 host to v2 took.

> **Not for production.** One API-key lane, no rate limiting, no webhooks yet (see [What is left](#what-is-left)). SQLite is single-writer: several processes may share the file (claims keep them from double-executing a run), but this is not a scaling design.

| | |
|---|---|
| Protocol | v2 only: `protocolVersions: ["2.0"]`, unversioned paths, `OpenWOP-Version: 2` |
| Families advertised | `auth` (api-key lane), `eventLog`, `idempotency`, `interrupt`, `limits`, `replay`, `runList` |
| Conformance | `@openwop/openwop-conformance@2.49.14 --target-major 2`: one known failure, the effect-seam manifest ([conformance.md](./conformance.md)) |
| Default port | `3839` (the v2 reference host uses `3838`) |

## Quick start

```bash
npm install --legacy-peer-deps   # the conformance suite (fixtures) has strict peer pins
npm start                        # http://127.0.0.1:3839
```

The v2 samples run against it unchanged:

```bash
OPENWOP_BASE_URL=http://127.0.0.1:3839 OPENWOP_API_KEY=openwop-sqlite-dev-key \
  npm test --prefix ../../tiny-workflow        # also streaming-client, idempotent-runs, approval-workflow, branch-fork
```

| Variable | Default | Purpose |
|---|---|---|
| `OPENWOP_HOST` / `OPENWOP_PORT` | `127.0.0.1` / `3839` | Bind address |
| `OPENWOP_API_KEY` | `openwop-sqlite-dev-key` | Bearer key for tenant `openwop-sqlite-tenant` |
| `OPENWOP_TENANT2_API_KEY` | _(unset)_ | A second key, bound to tenant `openwop-sqlite-tenant-b`; set it (and `OPENWOP_TEST_TENANT_B_API_KEY` for the suite) to exercise cross-tenant refusals |
| `OPENWOP_SQLITE_PATH` | `./data/openwop-host.sqlite` | The database file |
| `OPENWOP_CLAIM_TTL_MS` | `30000` | Lifetime of a run claim before another process may take the run over |
| `OPENWOP_HEARTBEAT_INTERVAL_MS` | `10000` | How often the executing process renews its claim (keep it under half the TTL) |
| `OPENWOP_MAX_RUN_DURATION_MS` | `600000` | `limits.maxRunDurationMs`; a run's `configurable.run.runTimeoutMs` is clamped to it |
| `OPENWOP_FIXTURES_DIR` | _(unset)_ | Extra fixture directory, read before the installed `@openwop/openwop-conformance/fixtures` |
| `OPENWOP_LOG_RESUME_TOKENS` | `false` | Log each interrupt's `ow2.` resume token, the host's stand-in for out-of-band delivery |

Checks: `npm run typecheck`, `npm test` (the durability test below), `npm run conformance -- --base-url http://127.0.0.1:3839 --api-key openwop-sqlite-dev-key`.

## Demonstrate durability

```bash
# Terminal 1: a short claim TTL so the takeover is quick
OPENWOP_CLAIM_TTL_MS=2000 OPENWOP_HEARTBEAT_INTERVAL_MS=500 npm start
```

```bash
# Terminal 2: start a 20-second run
H=(-H 'OpenWOP-Version: 2' -H 'Authorization: Bearer openwop-sqlite-dev-key' -H 'Content-Type: application/json')
RUN=$(curl -s "${H[@]}" -X POST http://127.0.0.1:3839/runs \
  -d '{"workflowId":"conformance-delay","inputs":{"delayMs":20000}}' | jq -r .runId)
ID=$(printf %s "$RUN" | sed 's|/|~2F|')   # a tenant-bound id travels as one path segment
# Now kill -9 the host in terminal 1, wait 2 s, and start it again.
curl -s "${H[@]}" "http://127.0.0.1:3839/runs/$ID/events/poll?timeout=30" | jq '[.events[].type]'
```

The second process logs `resumed 1 orphaned run(s)`, claims the run, and finishes it. The log has one `run.started` and one `run.completed`; the delay node shows two `node.started` events, because the first attempt was cut by the crash. `test/durability.test.ts` does exactly this with a real `SIGKILL`, and also checks that a second process does not touch a run while the first one's claim is live.

## The walkthrough

### 1. Schema

Five tables carry the v2 host: `runs`, `events` (both inherited from the v1 host and grown with `ALTER TABLE ADD COLUMN`), `interrupts_v2`, `idempotency_v2` and `host_secrets`. The era key is stamped by a trigger, not by call sites: every row inserted into `runs` gets `event_log_schema_version = 3` unless it says otherwise. The v1 host's trigger stamped `2`; replacing it is the cut. `host_secrets` holds the token and cursor MAC keys, so a resume token or a `listRuns` cursor survives a restart.

### 2. Identity

One lane, `api-key`. Each configured key is bound to one tenant and resolves to one Subject (`identity.md` §1.1), with the key realm `urn:openwop-host-sqlite:api-key` as its issuer. Run ids are tenant-bound (`<tenant>/<opaque>`) and travel projected (`tenant~2Fopaque`). A tenant segment that is not the caller's is `403 id_tenant_mismatch`; a bare id is `400 validation_error`, because this host advertises no 1.x member.

### 3. The event log

Append-only, `sequence` from 0. Every reader (poll, SSE, the snapshot, fork, the executor itself) goes through `readEvents`, the storage boundary; every writer goes through `appendEvent`. Both delegate the era rules to the reference host's `codemap.ts`: `rowToDoc` translates an era-2 row on read, and `toStorageVocabulary` picks the name an append must use for the run's era (`persistence.md` §The reader rule, §The writer rule).

### 4. Fixtures

The host runs only the conformance fixtures whose semantics it honours end to end: noop, delay, cancellable, multi-node, failure, approval, clarification, external-event and idempotent, plus an `approversList` variant of the approval gate. They are read from the installed `@openwop/openwop-conformance` package, so `fixtures[]` in discovery is exactly what can run.

### 5. Claims

A process executes a run only while it holds the run's claim: `claim_holder_id` plus `claim_expires_at`, set by one conditional `UPDATE` and renewed by a heartbeat. A claim that is not renewed lapses. On startup, and every TTL after that, the host claims every `pending`, `running` or `cancelling` run with no live claim and re-enters its loop. A cancel or a pause on a run another live process is executing is written to the run row, and that process acts on it.

### 6. Executor

The log is the executor's only state. Each step re-folds the run's events, so a restart, a resolved interrupt and a fork all continue from what is recorded. Nodes run in topological order and any node failure ends the run. `configurable.run.recursionLimit` and `runTimeoutMs` are enforced with `cap.breached`.

### 7. Interrupts

An approval, clarification or external-event gate records `interrupt.requested` (the `InterruptPayload` verbatim) and `node.suspended`, and the run waits. The re-entry key K is `<run>:<node>:<visit>`, where a replay fork uses its source run, so a replay finds the source's `interrupt.resolved` and applies it without raising a new interrupt. Approval resolves enforce the gate's `actions` and its `approversList`; a reject fails the gate with `approval_rejected`. Resume tokens are `ow2.hs256.sqlite-1.<payload>.<mac>`.

### 8. Projections

The snapshot is `run-snapshot.schema.json`, `owner` and `eventLogSchemaVersion` included. Its `ETag` is the last sequence plus the status. SSE frames carry `id:` (the sequence), `event:` and `data:` and honour `streamMode`, `Last-Event-ID` (an exclusive cursor) and `bufferMs`. The tail reads the durable log, so an event another process appends reaches the stream too.

### 9. The front door

`OpenWOP-Version` absent, `2` or `2.<n>` is served; any other major is `406 protocol_version_unsupported` with `details.protocolVersions`; a malformed value is `400`. There is no `/v1/` path space. Every response carries `OpenWOP-Version: 2.0` and every error is `{ error, message, details? }` with a code from `spec/v2/errors.json` (the reference `errors.ts` refuses to construct an unregistered one). Layer-1 idempotency covers every mutating operation.

### 10–13. Discovery, runs, interrupt surfaces, bootstrap

Discovery is the closed v2 root with an `ETag`. The run routes are `POST /runs`, `GET /runs`, `GET /runs/{runId}`, `…/events`, `…/events/poll`, `…/cancel`, `POST /runs:bulk-cancel`, `…:pause`, `…:resume`, `…:fork` and `…/effects`; the interrupt routes are `POST /runs/{runId}/interrupts/{nodeId}` and `GET`/`POST /interrupts/{token}`; `GET /host/effect-seams` is the replay manifest. Bootstrap resumes orphaned runs and starts the listener.

## What it reuses from v2-reference

The host imports the pure, contract-level modules of `../v2-reference/src/` and nothing with state:

| Module | Used for |
|---|---|
| `artifacts.ts` | Loads `@openwop/spec-artifacts` (this package's copy): the error registry, the event codemap, the v2 event-type enum |
| `errors.ts` | `HostError` / `err()`: the status comes from the registry, the body is the closed envelope |
| `ids.ts` | Id grammars, `tenantBound()`, the `~` projection, `checkTenantBound()` |
| `codemap.ts` | The era-2 reader (`rowToDoc`) and writer (`toStorageVocabulary`) rules |

The store, the claims, the executor, the routes and the discovery document are this host's own. Running the host needs only this package installed; `npm run typecheck` checks the imported modules too.

## Porting from v1

What changed, in order of how much code it took:

1. **Paths and negotiation.** `/v1/runs` became `/runs`, and every request is negotiated on `OpenWOP-Version`.
2. **Discovery.** The v1 document (`protocolVersion`, `supportedEnvelopes`, `debugBundle`, …) became the closed v2 root: metadata keys plus `{ status, since, until?, witness, …facets }` records, one per family actually served.
3. **Identity.** One hard-coded tenant and a bare `run-<uuid>` id became Subjects, tenant-bound ids and the `~` projection.
4. **Events.** The envelope gained `eventId`, `sequence` and `schemaVersion`; payloads moved to the closed v2 definitions; the poll response became `{ runId, events, lastSequence, status, isTerminal }`.
5. **Interrupts.** v1 callback tokens became `ow2.` tokens; the interrupt key K and replay short-circuiting are new.
6. **Fork.** New in this host: `replay` and `branch`, with the prefix copied through the storage boundary.

**The v1 database keeps working.** Point the v2 host at a file the v1 host wrote and it is read, not migrated. v1 runs stay era 2 with their v1 rows untouched: their logs are translated through the codemap on every read, their owner is legacy-stamped once (`issuer: urn:openwop:legacy`), and their ids are served as `openwop-sqlite-tenant/run-<uuid>`. They can be forked; the child is an era-3 run. A v1 run left waiting on an approval resumes: the first v2 resolve adopts the suspension, and the run finishes in v1 vocabulary (the writer rule). One limit: a v1 row stored no payload for some events (`run.started`, `node.completed`), so those read back with an empty payload, as with the reference reader.

Per-store disposition (`persistence.md` §Per-store disposition):

| Store | Disposition |
|---|---|
| `runs` | legacy-stamped: `tenant` and `owner_json` filled at first v2 read; NULL or 2 in `event_log_schema_version` is era 2 |
| `events` | translated: era-2 rows read through the codemap, never rewritten |
| `interrupts_v2`, `idempotency_v2`, `host_secrets` | new in v2 |
| `interrupts` (v1) | drained: a suspended v1 run is adopted into `interrupts_v2` on its first v2 resolve; v1 tokens are not accepted |
| `idempotency` (v1), `annotations`, `memory_entries`, webhook and audit tables | never-upgraded: kept, not read |

## What is left

The host serves the core floor. Still to port or build, roughly in order:

1. **Webhooks** (`webhooks.md`): registration, signed durable delivery with retries and dead letters, the egress guard. `openwop-core-standard` needs the `webhooks` family, and its fan-out is the first outbound effect seam, which the effect-seam manifest is required to list (the one conformance failure today).
2. **Audit-log integrity** (RFC 0224): the v1 host had a signed, checkpointed chain; it was removed with the v1 wire.
3. **Annotations** (`feedback`), OTel export (`telemetry`), cost metrics and model-capability checks: v1 features, removed with the v1 wire, each its own v2 family.
4. **Workflow features**: edge `triggerRule` and conditions, failure routing, approval quorum and timeouts, sub-workflows and dispatch.
5. **CORS preflight**, `minClientVersion`, rate limiting and revocable keys.
