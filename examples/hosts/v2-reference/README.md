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
| `OPENWOP_TENANT_B_API_KEY` / `OPENWOP_TENANT_B` | _(unset)_ / `openwop-reference-tenant-b` | when set, a second `api-key` credential bound to a **second** tenant, so the cross-tenant legs (A2A `ListTasks` scoping, MCP per-caller cache scope, isolation) have a real other caller; pair it with the suite's `OPENWOP_TEST_TENANT_B_API_KEY` |
| `OPENWOP_A2A_WORKFLOW_ID` | `conformance-approval` | **RFC 0208.** The one workflow the A2A 1.0 interface routes (an A2A Message carries no skill selector, so one interface routes one skill); the Agent Card lists exactly it |
| `OPENWOP_MCP_STATE_SECRET` | random per process | **RFC 0208.** The HMAC-SHA256 key MCP `requestState` tokens are integrity-protected under |
| `OPENWOP_DB_PATH` | `data/v2-reference.sqlite` | the durable store (`:memory:` for tests) |
| `OPENWOP_PREFERRED_VERSION` | `1.11` | the header-less representation of `/.well-known/openwop` (see "Negotiation") |
| `OPENWOP_SEAMS_PROFILE` | `true` | mount `/conformance/seams/…` and advertise `conformance.seamsProfile` |
| `OPENWOP_WEBHOOK_ALLOW_PRIVATE` | `false` | **an operator relaxation** of webhooks.md §Egress (loopback/private receivers), recorded as `host.relaxations[]` when a bundle is cut under it; with the guard on, such a registration answers `400 webhook_url_rejected` |
| `OPENWOP_DURABILITY_SEAM` | _(unset)_ | **RFC 0158 §E.** Mounts `POST /host/durability/kill`, which **SIGKILLs this process**. Boot-read, default OFF, and only effective with the seams profile on. Never set it in production. Unset ⇒ 404 ⇒ the suite records `inapplicable` and this host claims no durability rung |
| `OPENWOP_SUPERVISOR_RESTART_MS` / `OPENWOP_BOOT_REENTRY_BUDGET_MS` | `1000` / `5000` | the two terms of the recovery bound this host declares (`GET /host/durability/bound`). The first is the **operator's** — `scripts/supervisor.mjs` passes its own delay in — and is declared as such |
| `OPENWOP_WEBHOOK_MAX_ATTEMPTS` / `_BACKOFF_BASE_MS` / `_RETENTION_DAYS` | `5` / `500` / `7` | the durable-delivery policy (exponential backoff, dead-letter, retention) |
| `OPENWOP_WEBHOOK_ROTATION_OVERLAP_SECONDS` | `60` | RFC 0201 §E — `webhooks.secretRotation.overlapSeconds` (clamped 60–604800); advertised only with `standard-webhooks-1` |
| `OPENWOP_IMPLEMENTED_CHANGE_IDS` | _(empty)_ | comma list of `version.pinned` change ids this build still implements (persistence.md §Runs pinned to v1); pair it with the suite's `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` to witness the continue leg |
| `OPENWOP_DEV_VALIDATE` | `warn` (`off` in production) | validate every emitted document against `schemas/v2` (`strict` throws; the harness runs strict) |
| `OPENWOP_INTERRUPT_SECRET` / `_KID` / `OPENWOP_LEGACY_INTERRUPT_SECRET` | random / `v2-reference-1` / fixed | resume-token secrets: `ow2.hs256.<kid>.…`, plus the `legacy` kid for v1 two-segment tokens |
| `OPENWOP_HOST_BUILD` | `commit:dev` | `host.build` on the effect-seam manifest (`commit:<sha>` when cutting a bundle) |
| `OPENWOP_WORKLOAD_TRUST_ROOTS` | `spiffe://example` | the `workload` lane's trust roots |
| `OPENWOP_RATELIMIT_REQS_PER_MIN` | `1200` | per-credential token bucket → `429 rate_limited` + `Retry-After` |
| `OPENWOP_FIXTURES_DIR` | _(the suite's `fixtures/`)_ | override the fixture catalog directory |
| `OPENWOP_ENVELOPE_STRICTNESS` | `warn` | `envelopeStrictness.mode` for envelope admission below a kind's floor (events.md §"The envelope-kind catalog"); `strict` refuses with `unknown_schema_version` |

## The surfaces

1. **Discovery** — one resource, `/.well-known/openwop`; the `OpenWOP-Version` header selects the representation (v1 document with `protocolVersions[]` + `preferredVersion` additive; `OpenWOP-Version: 2` → the closed v2 root of metadata keys + family records `{status, since, witness, …facets}`, `extensions.openwop-v2-reference.host`, `conformance.seamsProfile`). Standard `ETag` / `If-None-Match` → `304`. `protocolVersions: ["1.11", "2.0"]`, `minClientVersion: "1.0"`. Each record advertises the maturity `spec/v2/declaration.json` declares — 11 families are `status: experimental` with `until: "2.1"`, `limits` is `stable` (capabilities.md §8).
2. **Negotiation** — unlisted major → `406 protocol_version_unsupported` (+ `details.protocolVersions[]`); `OpenWOP-Version ≠ 1` on a `/v1/` key → `400 protocol_version_mismatch`; `OpenWOP-Client-Version` below the floor → `426 client_version_unsupported`; every response carries `OpenWOP-Version: <major>.<minor>`.
3. **Runs** — `POST /runs` (closed body; `configurable` closed/nested/versioned; `Idempotency-Key` grammar → `idempotency_key_invalid`; `OpenWOP-Dedup: enforce`), `GET /runs/{runId}` (`owner.subject`, `eventLogSchemaVersion: 3`, strong `ETag`), cancel, bulk-cancel, `:pause` / `:resume` (`drainPolicy`), `:fork` (`replay` | `branch`), ancestry, annotations (a side-store, never the log), `/v1/runs…` through the overlap.
4. **Events** — `sequence` from 0; codemap v2 names only; `GET …/events/poll` (`afterSequence`, past-end `200` + `[]`, the closed `{ runId, events, lastSequence, status, isTerminal }`); SSE with `streamMode` (`updates` default, `values`, `messages`, `debug`, combinations), `Last-Event-ID`, `bufferMs`, keep-alives, close on terminal; `/host/events` heartbeat channel.
5. **Persistence** — SQLite; the era key on every run row (`NULL` ⇒ 2), fixed at creation and never restamped, fixing the log's vocabulary for the run's lifetime, so an append to an era-2 run is stored under the codemap's v1 spelling (`persistence.md` §The writer rule); era-2 rows translated through `spec/v2/event-codemap.json` at the one storage boundary (`readEvents()` in `src/events.ts`, adapter in `src/codemap.ts`); unmapped → `500 event_type_unmapped` on every reader; legacy Subject stamped at first v2 read; pinned-run disposition at first read (`run.cancelled { reason: v1_pin_unsupported, cancelledBy: v2-cutover }`); runs left non-terminal by a crash re-enter the loop at boot.
6. **Identity** — Subject minted from the credential (`api-key` lane, issuer `urn:openwop-host-v2-reference:api-key`; `session` lane; `workload` lane through the §20 seam with the `key-bound` floor); lanes advertised with `issuers[]`, `revocation`, `minimumAssurance`; next-request revocation → `401 credential_revoked`; tokens `ow2.hs256.<kid>.<payload>.<mac>` (+ v1 two-segment under `kid: legacy`); `approval` / `clarification` / `external-event` / `custom` kinds; `approversList` enforced (`403 forbidden`); `410 interrupt_expired`; `409 interrupt_already_resolved`.
7. **Errors** — every code from `spec/v2/errors.json` at its registered status; `{ error, message, details? }`; `Retry-After` header only.
8. **Webhooks** — register/unregister; five `OpenWOP-*` headers + the `X-openwop-*` family dual-emitted; HMAC-SHA256 over `${timestamp}.${rawBody}`; durable delivery (attempts table, exponential backoff, dead-letter after `maxAttempts`, retention; `GET /webhooks/{id}/dead-letters` host extension); SSRF guard at registration and delivery (re-resolve, pin the address, no redirects); inbound verifier seam accepting a v1-signed (`X-openwop-*`-only) delivery. **RFC 0201** (only when the installed `@openwop/spec-artifacts` defines it, i.e. 2.36.0+): `standard-webhooks-1` as an opt-in companion scheme — `signatureAlgorithms` on registration, a `whsec_` secret, synchronous endpoint verification through the egress path (`400 webhook_endpoint_unverified`, nothing persisted), `webhook-id` / `webhook-timestamp` / `webhook-signature` on every opted-in delivery (the id minted once per delivery row, so retries and post-restart attempts reuse it), and `rotateWebhookSecret` (`/webhooks/{id}/rotate-secret`, `/v1/…`) with an overlap during which both secrets sign and `OpenWOP-Signature` stays on the previous one.
9. **Packs** — `PUT /conformance/seams/packs-test/{name}/-/{version}.tgz` (ustar+gzip parsed in-process); engines ceiling (no upper bound ⇒ `<2.0.0` → `pack_engine_unsupported`); peer-dependency keys checked against `declaration.json` + the alias table (`pack_peer_dependency_undefined`); the vendor hatch ignored inside `agents[]` / `prompts[]`; `GET /packs`. The host registers and validates packs; it advertises no `sandbox` and executes no third-party pack code.
10. **Replay** — `GET /host/effect-seams` (`http.fetch`, `branchReFires: false`; `webhook.fanout`, `branchReFires: true`; both `guarded: true`); a replay fork resolves `core.httpFetch` from the source run's recorded outcome keyed `(sourceRunId, nodeId, attempt)` or fails closed with `replay_source_missing`; webhook fan-out never fires for a replay fork and fires for a branch only from `fromSeq`; `GET /runs/{id}/effects` — the Layer-2 ledger, **one row per transport attempt** under one identity (`effectId` and `providerKey` assigned once per business key, the provider's idempotency key on every attempt) — and `/compensation` (reverse-completion plan + attempts).
11. **Seams** — `/conformance/seams/sample/a2ui/emit-surface` (RFC 0209: supplies one `ui.a2ui-surface` envelope to the production admission path in `src/a2ui.ts` — mounted only when the installed corpus carries the schema-version-2 branch), `/conformance/seams/sample/event-log/seed`, `…/sample/webhooks/receive`, `…/sample/effect-seams/fire` (fire one named manifest row inside a run), `…/sample/test/idempotency/effect-retry` (one effect retried at the transport layer under one identity), `…/sample/auth/credential/{mint,revoke}`, `…/sample/test/workload-identity/resolve`, `…/packs-test/…`, `…/workspace/files…` (minimal RFC 0059).
12. **Durability (RFC 0158, `durable-single-instance`)** — three things are production code and run on every boot and every effect, seam or no seam: **boot recovery** (`recoverInFlightRuns`, `src/durability.ts`) re-enters every run a previous process left non-terminal and records a run that had already started as `workflow.restored`; **the effect claim waits for a live holder** (`performHttpFetch`) instead of firing beside it; and **the executor refuses to append past a terminal event** when the same work is delivered twice. The seam (`/host/durability/kill`, `/host/durability/bound`) does only what production does not — hold dispatch, kill the process, deliver twice — and is a non-normative host extension that advertises nothing. The death is a real `SIGKILL`; `scripts/supervisor.mjs` restarts the host and **counts the deaths itself**, and `scripts/cut-bundle.sh` refuses a bundle whose kill rows passed with fewer deaths than kill rows. What this host claims and does **not**: one process, one SQLite file — `durable-single-instance` only. No peer ever resumes anything (`durable-multi-instance` is not claimed), and the supervisor delay is the operator's term, not a number this process can enforce. Three real defects surfaced building this and are fixed: recovery was **silent** (a crashed run's log was indistinguishable from an uncrashed one); a claim loser **fired anyway** while the winner was mid-request (the suite's receiver counted 2 arrivals for one effect); and a duplicate delivery appended a **second `run.completed`**. A fourth was environmental — the sandbox child could not read its own entry file under `--permission` on Node 22.13/23.6, so all nine RFC 0173 isolation rows answered `sandbox_invocation_error` on a runtime `engines` admits; it is now granted that one file explicitly.
13. **A2A + MCP servers (RFC 0208)** — the host is also an A2A 1.0 **server** (`a2a.profiles: [a2a-1.0]`, `a2a.agentCardUrl`): `GET /.well-known/agent-card.json` lists one JSONRPC interface at 1.0 and exactly one skill (`OPENWOP_A2A_WORKFLOW_ID`); `POST /a2a/jsonrpc` serves `SendMessage` (a run per task, `run.started.transport: a2a`; `taskId` resolves the open interrupt through the REST resolve path; `contextId` inferred / mismatch `-32602` with nothing changed; terminal `-32004`), `GetTask`, `ListTasks` (exactly what `listRuns` returns to the Subject; `tenant` never selects), `CancelTask` (terminal `-32002`); unreadable and unknown tasks are the same `-32001`; streaming / push / extended-card rows refuse with their own codes. And an MCP 2026-07-28 **server** (`mcp.profiles`, `features: [server-discover, mrtr, cacheable-lists]`, `serverMount`, `serverUrls`): `POST /mcp` — stateless, header/body revision agreement checked before version support (`-32020` / `-32022`), `server/discover`, `tools/list` (the fixtures, sorted, `cacheScope: private`), `tools/call` (a run, `transport: mcp`; failed/cancelled is a result with `isError: true`; a suspending tool answers `input_required` with an HMAC-bound single-use `requestState`). `src/a2a-server.ts`, `src/mcp-server.ts`.
14. **Bundle** — [`bundle-v3.json`](./bundle-v3.json), signed with `keys/host.pem` (Ed25519, key id `v2-reference-4`; public key committed at `keys/host.pub.pem`): suite 2.35.0, witness `5562d7c57609…`, 261 requirement rows, 2032 assertions, `executedFail: 0`, `blocked: 0`, **`host.relaxations`: none**, all three `claimedProfiles` certified, signature verified, zero verifier rejections. **It carries RFC 0158's rung** — `durability.rung: durable-single-instance`, re-derived by the verifier from the recovery class, bound terms and observed kill → resumption intervals recorded on three signed rows. **Cut with the egress guard CLOSED** (`PUBLIC=1`, every fixture fronted publicly — `scripts/cut-public.sh`); every bundle before 2026-09-21 was cut with the guard open and recorded no relaxation, which is why they are superseded (`conformance.md`). The default `scripts/cut-bundle.sh` run is a loopback REGRESSION LANE: it declares `webhooks.egress-guard`, so `openwop-core-standard` does not certify, and it refuses to exit 0 if it does.

## A2UI surfaces (RFC 0209)

When the installed `@openwop/spec-artifacts` carries `ui.a2ui-surface` schema version 2 (`$defs/payloadV2`, corpus 2.36.0+), the v2 root advertises `supportedEnvelopes.kinds: ["ui.a2ui-surface"]`, `schemaVersions.kinds: {"ui.a2ui-surface": 2}` and `envelopeStrictness.mode`. `src/a2ui.ts` is the one admission path: envelope shape → catalog → floor → strictness below it → the ONE branch the version selects (never the `anyOf` union) → the two §A.2 cross-field rules → the §C.9 fold guard read from the run's own log → E2 re-emission → record. A recorded surface is the host-extension event `openwop-v2-reference.a2ui-surface-recorded`, whose payload carries the envelope verbatim (v2 registers no event type for an admitted envelope); nothing re-validates it on read, so poll and `:fork` return it as recorded. An `approval` interrupt refuses to advance (`403 forbidden`, `details.reason: untrusted_content_blocks_approval`) while any surface bound to its node has an untrusted envelope anywhere in its fold. The host renders nothing, so RFC 0209's render-side rule (no render before `root`) is not claimed here. On an older corpus the kind is not advertised and the seam is not mounted.

## Artifacts and conversation turns as A2A Parts (RFC 0205)

`getArtifact` (`GET /runs/{runId}/artifacts/{artifactId}`, `src/run-artifacts.ts`) resolves an artifact from the run's own log — the `artifact.created` event that named it and the node that produced it — so a fork reads the artifact its own log announced. It answers `application/json` with this host's object, or, when `Accept` ranks `application/a2a+json` above `application/json` (a tie keeps `application/json`) and the installed `@openwop/spec-artifacts` carries `schemas/v2/artifact.schema.json` (corpus 2.36.0+), an A2A `Artifact` whose `artifactId` is the path segment, the payload as one `data` Part (`mediaType: application/json`) and `metadata.openwop.artifactTypeId`, with `Vary: Accept`. It emits no `url` Part, so there is no pre-signed URL to outlive the caller's authorization (§A.3; the suite's `artifact-url-part-scoped` leg is honestly `inapplicable` here). The artifact comes from the corpus fixture `conformance-artifact-emit` (node type `conformance.artifact.emit`).

`core.conversationGate` runs only as the conformance mock (`lifecycle: open-exchange-close`, `mockAutoResume`, fixture `conformance-conversation-lifecycle`): `conversation.opened` → one `conversation.exchanged` agent turn → `conversation.closed`. The turn carries `parts` (`[{ text }]`, with `content` the same text for readers that predate RFC 0205) only when the installed contract declares `parts` on the closed v2 turn def. `conversationPrimitive` is advertised on the v2 root only; the v1 document does not advertise it, lists no fixture that needs it, and a v1 `POST /v1/runs` naming one is refused `422 capability_required` (`details.requiredCapability: conversationPrimitive`, runs.md §Conversation).

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

`@openwop/spec-artifacts@2.1.6` and `@openwop/openwop-conformance@2.1.6` are exact-pinned dev dependencies, published on npm as `latest` (the corpus tag `v2.1.0`; the checked-in bundle below was cut on `2.0.0-rc.61` and says so). Install **both, at the same explicit version** — `npm install --legacy-peer-deps` on the suite alone does not pull the exact-pinned peer (a host measured `corpus stamp MISMATCH — missing @openwop/spec-artifacts` on 2026-09-05), and npm 10's peer resolver trips over vitest 4's optional peers, so `--legacy-peer-deps` is required either way; npm 10.9 also fails to install any 2.x rc into an empty directory (arborist `edgesOut` crash) — use a current npm (`npx -y npm@latest install …`).

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
│   ├── a2a-server.ts  RFC 0208: the Agent Card + the A2A 1.0 JSON-RPC interface
│   ├── mcp-server.ts  RFC 0208: the MCP 2026-07-28 streamable-HTTP mount
│   ├── seams.ts       /conformance/seams/…
│   ├── validate.ts    dev-mode schema validation
│   └── artifacts.ts   the spec-artifacts registries
├── test/routes.test.ts   the route-level harness
├── scripts/keygen.mjs    Ed25519 keypair for bundle v3
├── keys/                 host.pub.pem (committed), host.pem (gitignored)
├── bundle-v3.json        the signed certification bundle
└── conformance.md        the honest tally
```

## Cutting the bundle

`./scripts/cut-bundle.sh` cuts [`bundle-v3.json`](./bundle-v3.json): it starts the host and the synthetic IdP, **preflights every opt-in fixture**, then runs the suite with `--target-major 2 --require-behavior --max-workers 1 --certify`. `PREFLIGHT_ONLY=1 ./scripts/cut-bundle.sh` checks the fixtures and stops.

The preflight is the point. RFC 0168 §E.1 denies certification for ANY `blocked` row, and a dead fixture records `blocked` exactly like a broken host would — so the two are indistinguishable in the result. The script therefore drives a real SCIM provision and a real SAML assertion and asserts the `link` field is present, checking the FIELD each scenario reads rather than that a process exists. It also sets `OPENWOP_WEBHOOK_ALLOW_PRIVATE=1`, which is required and not optional: the suite's webhook receivers and the IdP are both on loopback and the egress guard refuses them without it.

## The SAML/SCIM seams need a synthetic IdP

`host-sample-test-seams.md` leaves the synthetic IdP's HTTP shape to the operator. This host's is `scripts/synthetic-idp.ts` (built on the suite's `createSyntheticSamlIdp()`): `GET {idpUrl}/metadata → { entityID, certificatePem }` and `GET {idpUrl}/assert?variant=<v>&nameId=<n> → { entityID, certificatePem, assertion }`. Run `npx tsx scripts/synthetic-idp.ts 3839` (add `--exit-with-parent` only when a harness pipes its stdin — a detached launch would otherwise exit at once), then cut with `OPENWOP_TEST_SAML_IDP_URL=http://127.0.0.1:3839 OPENWOP_TEST_SCIM_URL=urn:openwop:conformance:scim` (the SCIM URL names the connection; the host is the SCIM server).
