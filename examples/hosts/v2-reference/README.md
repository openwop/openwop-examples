# OpenWOP Reference Host: v2 (`v2-reference`)

The charter §F "front door" witness: an example host implemented **from `spec/v2/core/*.md` and the generated v2 documents** (`api/v2/openapi.yaml`, `api/v2/asyncapi.yaml`, `api/seams-v2.yaml`, `schemas/v2/*`, `spec/v2/errors.json`, `spec/v2/event-codemap.json`, `spec/v2/declaration.json`) — never from the v1 hosts — that serves both majors through the overlap and passes the `@openwop/openwop-conformance` 2.0.0 floor at `--target-major 2`. It is also the test of whether the prose is implementable; what it found is under "Known corpus defects".

> **Reference host.** Single process, `node:http`, one SQLite file, one API key per tenant. No production hardening beyond what the spec makes an obligation of the surfaces it advertises (egress guard, durable delivery, approver enforcement, replay suppression, next-request revocation).

## Quick start

```bash
npm install --legacy-peer-deps     # see "Installing the 2.0.0-rc peers" below
npm start                          # http://127.0.0.1:3838
```

| Variable | Default | Purpose |
|---|---|---|
| `OPENWOP_HOST` / `OPENWOP_PORT` | `127.0.0.1` / `3838` | bind address |
| `OPENWOP_API_KEY` | `openwop-v2-dev-key` | the default `api-key`-lane credential (`Authorization: Bearer …`) |
| `OPENWOP_TENANT` | `openwop-reference-tenant` | the tenant the default key binds to (every tenant-bound id is `<tenant>/<opaque>`) |
| `OPENWOP_DB_PATH` | `data/v2-reference.sqlite` | the durable store (`:memory:` for tests) |
| `OPENWOP_PREFERRED_VERSION` | `1.11` | the header-less representation of `/.well-known/openwop` (see "Negotiation") |
| `OPENWOP_SEAMS_PROFILE` | `true` | mount `/conformance/seams/…` and advertise `conformance.seamsProfile` |
| `OPENWOP_WEBHOOK_ALLOW_PRIVATE` | `false` | **an operator relaxation** of webhooks.md §Egress (loopback/private receivers), recorded as `host.relaxations[]` when a bundle is cut under it; with the guard on, such a registration answers `400 webhook_url_rejected` |
| `OPENWOP_WEBHOOK_MAX_ATTEMPTS` / `_BACKOFF_BASE_MS` / `_RETENTION_DAYS` | `5` / `500` / `7` | the durable-delivery policy (exponential backoff, dead-letter, retention) |
| `OPENWOP_IMPLEMENTED_CHANGE_IDS` | _(empty)_ | comma list of `version.pinned` change ids this build still implements (persistence.md §Runs pinned to v1); pair it with the suite's `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` to witness the continue leg |
| `OPENWOP_DEV_VALIDATE` | `warn` (`off` in production) | validate every emitted document against `schemas/v2` (`strict` throws; the harness runs strict) |
| `OPENWOP_INTERRUPT_SECRET` / `_KID` / `OPENWOP_LEGACY_INTERRUPT_SECRET` | random / `v2-reference-1` / fixed | resume-token secrets: `ow2.hs256.<kid>.…`, plus the `legacy` kid for v1 two-segment tokens |
| `OPENWOP_HOST_BUILD` | `commit:dev` | `host.build` on the effect-seam manifest (`commit:<sha>` when cutting a bundle) |
| `OPENWOP_WORKLOAD_TRUST_ROOTS` | `spiffe://example` | the `workload` lane's trust roots |
| `OPENWOP_RATELIMIT_REQS_PER_MIN` | `1200` | per-credential token bucket → `429 rate_limited` + `Retry-After` |
| `OPENWOP_FIXTURES_DIR` | _(the suite's `fixtures/`)_ | override the fixture catalog directory |

## The twelve surfaces

1. **Discovery** — one resource, `/.well-known/openwop`; the `OpenWOP-Version` header selects the representation (v1 document with `protocolVersions[]` + `preferredVersion` additive; `OpenWOP-Version: 2` → the closed v2 root of metadata keys + family records `{status, since, witness, …facets}`, `extensions.openwop-v2-reference.host`, `conformance.seamsProfile`). Standard `ETag` / `If-None-Match` → `304`. `protocolVersions: ["1.11", "2.0"]`, `minClientVersion: "1.0"`. Each record advertises the maturity `spec/v2/declaration.json` declares — 11 families are `status: experimental` with `until: "2.1"`, `limits` is `stable` (capabilities.md §8).
2. **Negotiation** — unlisted major → `406 protocol_version_unsupported` (+ `details.protocolVersions[]`); `OpenWOP-Version ≠ 1` on a `/v1/` key → `400 protocol_version_mismatch`; `OpenWOP-Client-Version` below the floor → `426 client_version_unsupported`; every response carries `OpenWOP-Version: <major>.<minor>`.
3. **Runs** — `POST /runs` (closed body; `configurable` closed/nested/versioned; `Idempotency-Key` grammar → `idempotency_key_invalid`; `OpenWOP-Dedup: enforce`), `GET /runs/{runId}` (`owner.subject`, `eventLogSchemaVersion: 3`, strong `ETag`), cancel, bulk-cancel, `:pause` / `:resume` (`drainPolicy`), `:fork` (`replay` | `branch`), ancestry, annotations (a side-store, never the log), `/v1/runs…` through the overlap.
4. **Events** — `sequence` from 0; codemap v2 names only; `GET …/events/poll` (`afterSequence`, past-end `200` + `[]`, the closed `{ runId, events, lastSequence, status, isTerminal }`); SSE with `streamMode` (`updates` default, `values`, `messages`, `debug`, combinations), `Last-Event-ID`, `bufferMs`, keep-alives, close on terminal; `/host/events` heartbeat channel.
5. **Persistence** — SQLite; the era key on every run row (`NULL` ⇒ 2), fixed at creation and never restamped, fixing the log's vocabulary for the run's lifetime, so an append to an era-2 run is stored under the codemap's v1 spelling (`persistence.md` §The writer rule); era-2 rows translated through `spec/v2/event-codemap.json` at the one storage boundary (`readEvents()` in `src/events.ts`, adapter in `src/codemap.ts`); unmapped → `500 event_type_unmapped` on every reader; legacy Subject stamped at first v2 read; pinned-run disposition at first read (`run.cancelled { reason: v1_pin_unsupported, cancelledBy: v2-cutover }`); runs left non-terminal by a crash re-enter the loop at boot.
6. **Identity** — Subject minted from the credential (`api-key` lane, issuer `urn:openwop-host-v2-reference:api-key`; `session` lane; `workload` lane through the §20 seam with the `key-bound` floor); lanes advertised with `issuers[]`, `revocation`, `minimumAssurance`; next-request revocation → `401 credential_revoked`; tokens `ow2.hs256.<kid>.<payload>.<mac>` (+ v1 two-segment under `kid: legacy`); `approval` / `clarification` / `external-event` / `custom` kinds; `approversList` enforced (`403 forbidden`); `410 interrupt_expired`; `409 interrupt_already_resolved`.
7. **Errors** — every code from `spec/v2/errors.json` at its registered status; `{ error, message, details? }`; `Retry-After` header only.
8. **Webhooks** — register/unregister; five `OpenWOP-*` headers + the `X-openwop-*` family dual-emitted; HMAC-SHA256 over `${timestamp}.${rawBody}`; durable delivery (attempts table, exponential backoff, dead-letter after `maxAttempts`, retention; `GET /webhooks/{id}/dead-letters` host extension); SSRF guard at registration and delivery (re-resolve, pin the address, no redirects); inbound verifier seam accepting a v1-signed (`X-openwop-*`-only) delivery.
9. **Packs** — `PUT /conformance/seams/packs-test/{name}/-/{version}.tgz` (ustar+gzip parsed in-process); engines ceiling (no upper bound ⇒ `<2.0.0` → `pack_engine_unsupported`); peer-dependency keys checked against `declaration.json` + the alias table (`pack_peer_dependency_undefined`); the vendor hatch ignored inside `agents[]` / `prompts[]`; `GET /packs`. The host registers and validates packs; it advertises no `sandbox` and executes no third-party pack code.
10. **Replay** — `GET /host/effect-seams` (`http.fetch`, `branchReFires: false`; `webhook.fanout`, `branchReFires: true`; both `guarded: true`); a replay fork resolves `core.httpFetch` from the source run's recorded outcome keyed `(sourceRunId, nodeId, attempt)` or fails closed with `replay_source_missing`; webhook fan-out never fires for a replay fork and fires for a branch only from `fromSeq`; `GET /runs/{id}/effects` — the Layer-2 ledger, **one row per transport attempt** under one identity (`effectId` and `providerKey` assigned once per business key, the provider's idempotency key on every attempt) — and `/compensation` (reverse-completion plan + attempts).
11. **Seams** — `/conformance/seams/sample/event-log/seed`, `…/sample/webhooks/receive`, `…/sample/effect-seams/fire` (fire one named manifest row inside a run), `…/sample/test/idempotency/effect-retry` (one effect retried at the transport layer under one identity), `…/sample/auth/credential/{mint,revoke}`, `…/sample/test/workload-identity/resolve`, `…/packs-test/…`, `…/workspace/files…` (minimal RFC 0059).
12. **Bundle** — [`bundle-v3.json`](./bundle-v3.json), signed with `keys/host.pem` (Ed25519, key id `v2-reference-1`; public key committed at `keys/host.pub.pem`): witness `e7ca08db7ee1…`, 186 requirement rows, 1318 assertions, `executedFail: 0`, `claimedProfiles` the three registry predicates the root satisfies, schema-valid, signature verified, zero verifier rejections, certifying nothing because `blocked > 0`. **All three §F host cut gates pass (`exit 0`).** See `conformance.md`.

## Negotiation through the overlap

`versioning.md` §1.1 is explicit: **while `protocolVersions[]` carries any 1.x member, `preferredVersion` MUST be that 1.x.** A header-less request is a v1 client's request, so the header-less representation of `/.well-known/openwop` is the v1 document (`capabilities.md` §1, RFC 0176 §C.1) and the header-less default is `preferredVersion`'s major (§1.3) — the two agree only under that rule. This host advertises `preferredVersion: 1.11` until v1 end-of-support, when `protocolVersions[]` drops the 1.x member and the preferred version becomes a 2.x (the header-less representation then becomes the closed v2 root). A v2 client is unaffected: it selects the highest listed major it implements (§1.5) and names it with `OpenWOP-Version: 2`. Every other unversioned key is the v2 surface (§1.2) and is served as 2.0 whether or not the header is present.

## Run conformance against this host

```bash
npm start &                                                     # or OPENWOP_WEBHOOK_ALLOW_PRIVATE=true npm start & (loopback receiver)
npx openwop-conformance --base-url http://127.0.0.1:3838 --api-key openwop-v2-dev-key --target-major 2
npm test                                                         # the route-level harness (in-memory store, strict schema validation)
```

The suite's webhook scenarios boot a loopback receiver; a conforming egress guard refuses it, so the measurement in `conformance.md` was taken under the recorded relaxation `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (or front the receiver with `OPENWOP_WEBHOOK_RECEIVER_URL`, a public https tunnel, and run the guard on).

## Installing the 2.0.0-rc peers

`@openwop/spec-artifacts@2.0.0-rc.1` and `@openwop/openwop-conformance@2.0.0-rc.1` are exact-pinned dev dependencies. Until both are on npm, install them from the release tarballs: `npm install --no-save --legacy-peer-deps ./openwop-spec-artifacts-2.0.0-rc.1.tgz ./openwop-openwop-conformance-2.0.0-rc.1.tgz` (npm 10's peer resolver trips over vitest 4's optional peers; `--legacy-peer-deps` is required either way).

## Corpus defects this host found — all fixed

Implementing the prose surfaced six defects plus a contradiction; all seven are fixed in the corpus at `v2-phase3-e4` and this host is measured against the fix (`conformance.md` §"What changed"):

1. `conformance.seamsProfile` was schema-illegal — now a key of the closed discovery root, so the seams profile is advertisable.
2. No registered event validated against `run-event.schema.json` (`type.oneOf` matched both branches) — the vendor branch now excludes every registered first segment, so a registered type matches exactly one and `run.startd` is refused.
3. `runs.md` §Fork required a `422` no code registered — `fork_point_invalid` (422) is registered and this host answers it.
4. `webhooks.md` advertised a `retryPolicy` the `webhooks` facet could not carry — it is a facet of the family now, and this host advertises it there.
5. The loopback refusal had no registered code — `webhook_url_rejected` (400) is registered and this host answers it.
6. The v3 bundle schema rejected the emitter's own requirement ids — the id pattern now admits the six areas the suite mints.
7. The header-less discovery contract was ambiguous — `versioning.md` §1.1 now states the 1.x rule this host was already following (see "Negotiation").

Two contradictions **introduced by fixes 3 and 6** remain open and are the only failing rows in the current measurement; both are server-free (the driver never contacts the host). They are stated with file and line in `conformance.md` §"The 4 executed-fail rows".

## File layout

```
v2-reference/
├── src/
│   ├── server.ts      boot, discovery/openapi/host-events/webhook routes, fixture catalog
│   ├── router.ts      negotiation, auth, rate limit, error envelope, Layer-1 idempotency
│   ├── discovery.ts   the v1 document and the closed v2 root
│   ├── store.ts       better-sqlite3 tables (one per persisted store)
│   ├── codemap.ts     the era-2 storage-boundary adapter
│   ├── events.ts      append, readEvents (the seat), poll, SSE
│   ├── executor.ts    the run loop, node types, cancel/pause/resume, interrupt resume, pin disposition
│   ├── runs.ts        the run surface handlers (+ /v1/ keys)
│   ├── interrupts.ts  tokens, mint, the resolve contract, approver enforcement
│   ├── identity.ts    Subject, credentials, workload identity
│   ├── effects.ts     effect ledger, http.fetch seam, compensation, effect-seam manifest
│   ├── replay.ts      :fork
│   ├── webhooks.ts    register, fan-out, durable delivery, inbound verifier
│   ├── egress.ts      the SSRF guard (registration + delivery)
│   ├── packs.ts       tar reader, manifest checks, the test catalog
│   ├── seams.ts       /conformance/seams/…
│   ├── validate.ts    dev-mode schema validation
│   └── artifacts.ts   the spec-artifacts registries
├── test/routes.test.ts   the route-level harness
├── scripts/keygen.mjs    Ed25519 keypair for bundle v3
├── keys/                 host.pub.pem (committed), host.pem (gitignored)
├── bundle-v3.json        the signed certification bundle
└── conformance.md        the honest tally
```
