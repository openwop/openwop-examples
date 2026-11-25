# OpenWOP host: Postgres (v2)

An OpenWOP **v2** host backed by Postgres, shaped for production: any number of host processes serve one database, a run is executed by whichever process holds its advisory lock, and a process that dies hands its runs to the others without a lease to wait out. Every successful write is also an entry in a hash-chained, append-only audit log anchored by Ed25519-signed checkpoints.

It runs against a real Postgres (`OPENWOP_PG_DSN`) or, with no server at all, against [PGlite](https://pglite.dev) (Postgres compiled to WASM) in the host's own process. The tests and the conformance suite run on PGlite.

`src/server.ts` is one file meant to be read top to bottom, like the [SQLite host](../sqlite/)'s; the sections below follow its `// ─── N. … ───` markers. It was a v1 host, and [Porting from v1](#porting-from-v1) shows what that took.

> **A reference example.** One API-key lane, no rate limiting, no webhooks yet (see [What is left](#what-is-left)). The multi-process design is real; the rest is the core floor.

| | |
|---|---|
| Protocol | v2 only: `protocolVersions: ["2.0"]`, unversioned paths, `OpenWOP-Version: 2` |
| Families advertised | `auth` (api-key lane), `auditLogIntegrity`, `eventLog`, `idempotency`, `interrupt`, `limits`, `replay`, `runList` |
| Conformance | `@openwop/openwop-conformance@2.49.15 --target-major 2`: one known failure, the effect-seam manifest ([conformance.md](./conformance.md)) |
| Default port | `3841` (v2 reference `3838`, SQLite `3839`, Python `3840`) |

## Quick start

```bash
npm install --legacy-peer-deps   # the conformance suite (fixtures) has strict peer pins
npm run start:pglite             # PGlite in memory, http://127.0.0.1:3841
# or, against a real Postgres:
OPENWOP_PG_DSN=postgres://user:pass@localhost:5432/openwop npm start
```

The v2 samples run against it unchanged:

```bash
OPENWOP_BASE_URL=http://127.0.0.1:3841 OPENWOP_API_KEY=openwop-postgres-dev-key \
  npm test --prefix ../../tiny-workflow        # also streaming-client, idempotent-runs, approval-workflow, branch-fork
```

| Variable | Default | Purpose |
|---|---|---|
| `OPENWOP_HOST` / `OPENWOP_PORT` | `127.0.0.1` / `3841` | Bind address |
| `OPENWOP_PG_DSN` | _(unset)_ | A real Postgres. Unset (or empty, as `start:pglite` sets it) runs on PGlite |
| `OPENWOP_PGLITE_DIR` | _(unset)_ | PGlite's data directory; unset is in memory. One process at a time |
| `OPENWOP_PG_POOL_SIZE` | `10` | `pg.Pool` size; the lock session is one more connection, outside the pool |
| `OPENWOP_API_KEY` | `openwop-postgres-dev-key` | Bearer key for tenant `openwop-postgres-tenant` |
| `OPENWOP_TENANT2_API_KEY` | _(unset)_ | A second key, bound to tenant `openwop-postgres-tenant-b`; set it (and `OPENWOP_TEST_TENANT_B_API_KEY` for the suite) to exercise cross-tenant refusals |
| `OPENWOP_CLAIM_SWEEP_MS` | `2000` | How often each process offers itself the unfinished runs no process holds |
| `OPENWOP_MAX_RUN_DURATION_MS` | `600000` | `limits.maxRunDurationMs`; a run's `configurable.run.runTimeoutMs` is clamped to it |
| `OPENWOP_AUDIT_KEY_DIR` | `./data` (PGlite in memory: a fresh temp dir) | Where the audit checkpoint signing key lives. **Every process on one database must use the same key files** |
| `OPENWOP_AUDIT_CHECKPOINT_ENTRIES` / `_SECONDS` | `1000` / `300` | Checkpoint cadence, advertised as facets |
| `OPENWOP_FIXTURES_DIR` | _(unset)_ | Extra fixture directory, read before the installed `@openwop/openwop-conformance/fixtures` |
| `OPENWOP_LOG_RESUME_TOKENS` | `false` | Log each interrupt's `ow2.` resume token, the host's stand-in for out-of-band delivery |

Checks: `npm run typecheck`, `npm test` (the durability and audit-tamper tests below), `npm run test:siblings` (audit export and pack consumer; they read the spec and registry repos, via `OPENWOP_SPEC_REPO` / `OPENWOP_REGISTRY_REPO` or sibling checkouts), `npm run conformance -- --base-url http://127.0.0.1:3841 --api-key openwop-postgres-dev-key`.

## Demonstrate the takeover

Two processes on one Postgres. Start a Postgres any way you like, for example `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16-alpine`.

```bash
export OPENWOP_PG_DSN=postgres://postgres:pw@127.0.0.1:5432/postgres OPENWOP_CLAIM_SWEEP_MS=500
OPENWOP_PORT=3841 npm start     # terminal 1: process A
OPENWOP_PORT=3842 npm start     # terminal 2: process B
```

```bash
# terminal 3: start a 20-second run on A
H=(-H 'OpenWOP-Version: 2' -H 'Authorization: Bearer openwop-postgres-dev-key' -H 'Content-Type: application/json')
RUN=$(curl -s "${H[@]}" -X POST http://127.0.0.1:3841/runs \
  -d '{"workflowId":"conformance-delay","inputs":{"delayMs":20000}}' | jq -r .runId)
ID=$(printf %s "$RUN" | sed 's|/|~2F|')   # a tenant-bound id travels as one path segment
psql "$OPENWOP_PG_DSN" -c "SELECT pid, objid FROM pg_locks WHERE locktype = 'advisory' AND classid = 28535"   # A's lock
# kill -9 process A, then ask B:
curl -s "${H[@]}" "http://127.0.0.1:3842/runs/$ID/events/poll?timeout=30" | jq '[.events[].type]'
```

A's connection drops with it, Postgres releases A's lock, and B's next sweep (within 500 ms) takes the run and finishes it. The log has one `run.started` and one `run.completed`; the delay node shows two `node.started` events, because the first attempt was cut by the crash. `test/durability.test.ts` does exactly this with real `SIGKILL`s when `OPENWOP_PG_DSN` is set, and also checks that B leaves alone a run A is executing, and that a cancel sent to B is carried out by A.

## The walkthrough

### 1. Schema

The v1 host's `runs` and `events` tables are kept and grown with `ADD COLUMN IF NOT EXISTS`; `interrupts_v2`, `idempotency_v2` and `host_secrets` are new. The DDL runs in one transaction under `pg_advisory_xact_lock`, so several processes booting at once do not race it. The era key is stamped by the column default, not by call sites, and the order of two statements is the whole cut: `event_log_schema_version` is added **without** a default, so every row the v1 host wrote reads NULL (era 2), and only then is the default set to 3 for every row inserted afterwards. `ADD COLUMN … DEFAULT 3` in one step would have backfilled the v1 rows as era 3. `host_secrets` holds the token and cursor MAC keys, shared by every process, so a resume token or a `listRuns` cursor minted by one process verifies on another.

### 2. Identity

One lane, `api-key`. Each configured key is bound to one tenant and resolves to one Subject (`identity.md` §1.1), with the key realm `urn:openwop-host-postgres:api-key` as its issuer. Run ids are tenant-bound (`<tenant>/<opaque>`) and travel projected (`tenant~2Fopaque`). A tenant segment that is not the caller's is `403 id_tenant_mismatch`; a bare id is `400 validation_error`.

### 3. The event log

Append-only, `sequence` from 0, read through `readEvents` and written through `appendEvent`, which delegate the era rules to the reference host's `codemap.ts`. Several processes append to one run (the executor in one, a pause or a resolve in another), so the sequence is allocated by the row lock that `UPDATE runs SET next_event_seq = … RETURNING` takes, in the same statement as the `INSERT`. Two appends to one run serialize on that row; appends to different runs do not contend.

### 4. Fixtures

The conformance fixtures whose semantics the host honours end to end (noop, delay, cancellable, multi-node, failure, approval, clarification, external-event, idempotent, and an `approversList` variant of the approval gate), read from the installed `@openwop/openwop-conformance` package.

### 5. Claims

A process executes a run only while it holds `pg_try_advisory_lock(0x6f77, hashtext(run_id))` on its **lock session**: one connection per process, outside the pool, open for the life of the process. A session-level advisory lock lasts until it is released or its session ends, so the claim's liveness is the connection's. There is no `claim_expires_at` to renew and no heartbeat to miss; a crashed process's locks are gone as soon as Postgres notices the connection drop.

- **The sweep.** Every `OPENWOP_CLAIM_SWEEP_MS`, each process tries to claim every `pending`, `running` or `cancelling` run it is not executing. A run another live process holds stays locked and is skipped; an orphan is claimed and its loop picks up after the last recorded event.
- **Cancel and pause.** Whether a run is executing anywhere is answered by taking its lock: if this process gets it, nothing is executing, and the cancel (or immediate pause) is recorded under the lock. If not, the run is flagged (`cancel_requested`, `pause_requested`) and the executing process acts on it at its next check.
- **A lost lock session.** If the lock connection drops while the process lives, every lock it held is gone. The process bumps an epoch that stops all its loops at their next check, reconnects with backoff, and lets the sweep re-claim.
- **`claim_holder_id`** is stamped while a process executes a run, for operators. The lock is the truth.
- **A `hashtext` collision** makes two runs share one lock. One waits for the other; neither is executed twice.

On PGlite there is one connection and one process, so the in-process claim map is the whole guard.

### 6. Executor

The log is the executor's only state. Each step re-folds the run's events, so a takeover, a resolved interrupt and a fork all continue from what is recorded. Nodes run in topological order; any node failure ends the run. `configurable.run.recursionLimit` and `runTimeoutMs` are enforced with `cap.breached`; a fork's run clock starts at the fork, not at the copied `run.started`.

### 7. Interrupts

An approval, clarification or external-event gate records `interrupt.requested` and `node.suspended`, and the run waits. The re-entry key K is `<run>:<node>:<visit>`, where a replay fork uses its source run, so a replay finds the source's `interrupt.resolved` and applies it. Resolution is claimed with one conditional `UPDATE`, so two processes resolving the same interrupt cannot both succeed. Resume tokens are `ow2.hs256.postgres-1.<payload>.<mac>`.

### 8. Projections

The snapshot is `run-snapshot.schema.json`. SSE frames carry `id:` (the sequence), `event:` and `data:` and honour `streamMode`, `Last-Event-ID` and `bufferMs`. The tail reads the durable log, so an event another process appends reaches the stream too.

### 9. The front door

`OpenWOP-Version` absent, `2` or `2.<n>` is served; any other major is `406 protocol_version_unsupported`; a malformed value is `400`. There is no `/v1/` path space. Every error is `{ error, message, details? }` with a code from `spec/v2/errors.json`. Layer-1 idempotency covers every mutating operation, and its claim is one `INSERT … ON CONFLICT DO NOTHING`, so a duplicate sent to another process is `409 idempotency_in_flight`.

### 10. Audit log

The `auditLogIntegrity` family (RFC 0224, `security-defaults.md` §Audit-log integrity), built in [`src/audit.ts`](./src/audit.ts): an append-only `audit_log` (plpgsql triggers refuse `UPDATE` and `DELETE`), each entry chained to the prior one by its JCS SHA-256, and Merkle checkpoints over the entries signed with Ed25519. Every successful authenticated write is an entry, recorded before the reply, plus `host.started` at boot. `GET /audit/verify?fromSeq=&toSeq=` re-walks the chain and every checkpoint in range. Across processes, the sequence is allocated under the `audit_seq` row lock and a checkpoint takes the same lock, so the chain is one chain however many processes write it. [`src/audit-export.ts`](./src/audit-export.ts) exports the checkpoints for the spec repo's out-of-band verifier (`scripts/verify-audit-checkpoints.mjs`).

[`test/audit-tamper.test.ts`](./test/audit-tamper.test.ts) plays the privileged attacker the black-box suite cannot: it edits an entry, forges a checkpoint signature and deletes an entry, and checks each is reported with the anomaly shape RFC 0218 §C fixes; then it checks the triggers refuse `UPDATE` and `DELETE`.

### 11–14. Discovery, runs, interrupt surfaces, bootstrap

Discovery is the closed v2 root with an `ETag`. The run routes are `POST /runs`, `GET /runs`, `GET /runs/{runId}`, `…/events`, `…/events/poll`, `…/cancel`, `POST /runs:bulk-cancel`, `…:pause`, `…:resume`, `…:fork` (the child and its copied prefix land in one transaction) and `…/effects`; the interrupt routes are `POST /runs/{runId}/interrupts/{nodeId}` and `GET`/`POST /interrupts/{token}`; `GET /host/effect-seams` is the replay manifest. Bootstrap runs the schema, starts the sweep and writes the first audit checkpoint.

## What it reuses from v2-reference

The same pure, contract-level modules as the SQLite host, and nothing with state:

| Module | Used for |
|---|---|
| `artifacts.ts` | Loads `@openwop/spec-artifacts` (this package's copy): the error registry, the event codemap, the v2 event-type enum, whether the `auditLogIntegrity` family exists |
| `errors.ts` | `HostError` / `err()`: the status comes from the registry, the body is the closed envelope |
| `ids.ts` | Id grammars, `tenantBound()`, the `~` projection, `checkTenantBound()` |
| `codemap.ts` | The era-2 reader (`rowToDoc`) and writer (`toStorageVocabulary`) rules |

## Porting from v1

The v1 host was ~10,800 lines over 21 source files: the v1 wire plus BYOK and AI policy, MCP and HTTP nodes, a memory adapter, webhooks, OTel, multi-region and mTLS/OIDC experiments. The v2 host is 3,070 lines over 5 (`server.ts` 1,780). What carried over: the `Querier` seam (now with real pooled transactions), the audit-log integrity material, the PGlite test option and the idea of advisory-lock claims. What changed:

1. **Paths, negotiation, discovery, identity, events, interrupts, fork**: as in the [SQLite port](../sqlite/README.md#porting-from-v1).
2. **The store went properly async and multi-connection.** The v1 host shared one `pg.Client` behind an in-process transaction lock. Now queries go through a `pg.Pool`, a transaction checks out one client, and the advisory locks live on their own connection.
3. **Claims became advisory locks only.** The v1 host took the lock on its shared connection and also kept TTL columns; on a pool, a session lock taken on a random pooled client is held by nobody in particular. The lock session fixes that, and the TTL went away.

**A v1 database is read forward.** Point the v2 host at a database the v1 host wrote and it is read, not migrated. v1 runs stay era 2 with their rows untouched: logs are translated through the codemap on read, the owner is legacy-stamped once (`issuer: urn:openwop:legacy`), ids are served as `openwop-postgres-tenant/run-<uuid>`. They can be forked; the child is era 3. A v1 run waiting on a gate resumes: the first v2 resolve adopts the suspension (the v1 host nested it in `node.suspended` as `{ nodeId, data: { kind, config } }`) and the run finishes in v1 vocabulary. The v1 audit chain continues: the tables are the same, and v2 appends to them. `test/durability.test.ts` seeds a database with the v1 host's DDL and rows and checks all of this.

| Store | Disposition |
|---|---|
| `runs` | legacy-stamped: `tenant` at boot, `owner_json` at first v2 read; NULL `event_log_schema_version` is era 2 |
| `events` | translated: era-2 rows read through the codemap, never rewritten |
| `audit_log`, `audit_checkpoints`, `audit_seq` | kept: the chain continues |
| `interrupts_v2`, `idempotency_v2`, `host_secrets` | new in v2 |
| `interrupts` (v1) | drained: a suspended v1 run is adopted on its first v2 resolve; v1 tokens are not accepted |
| `idempotency` (v1), `annotations`, `webhook_subscriptions`, `memory_entries`, `__schema_version` | never-upgraded: kept, not read |

Removed with the v1 wire, with their tests: `agent-events`, `ai-proxy`, `cost`, `cross-engine-append`, `http-client`, `interrupts`, `jwt-validator`, `mcp-client`, `memory-adapter`, `modelCapability`, `multi-region`, `observability`, `schema`, `secrets`, `signing-keys`, `webhooks`; the v1 certification bundle, `conformance-full.md` and the bundle-signing scripts and key (v1 evidence substantiates nothing at major 2). [`src/pack-consumer.ts`](./src/pack-consumer.ts), install-time pack verification, is kept as a standalone module with its test: it does not depend on the wire, and the spec repo and the site cite it.

## What is left

1. **Webhooks**: registration, signed durable delivery, the egress guard. Its fan-out is the first outbound effect seam, which the effect-seam manifest must list (the one conformance failure today).
2. **Production-profile extras** the v1 host had: backpressure (`503` + `Retry-After`) and event retention.
3. **Workflow features**: edge conditions, failure routing, approval quorum and timeouts, sub-workflows.
4. **Operations**: a real migrator in place of boot-time DDL, shared audit key distribution, rate limiting and revocable keys.
