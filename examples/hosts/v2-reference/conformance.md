# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-05, `@openwop/openwop-conformance@2.0.0-rc.59` + `@openwop/spec-artifacts@2.0.0-rc.59` (npm, corpus stamp VERIFIED), `--target-major 2 --max-workers 4`, **71** scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:31ec6a123d791e0313bbfbc0b17bc75c86e092b9`, local boot on port 3839, fresh store, one run; the bundle's `discovery.url` names that port and its `signature.keyId` the rotated key — asserted by the cut script before the artifact is kept (see the superseded measurement below for why). Route-level harness 21 / 21.
>
> **RFC 0148 §A dispositions (221 rows, 1545 assertions): executed-pass 179 · executed-fail 0 · blocked 0 · inapplicable 42 · skipped 0.** `claimedProfiles` = `openwop-discovery-core` (witnessCount 3, **certified**), `openwop-core-standard` (witnessCount **13** — rc.59 put the five run-surface witnesses on the floor: cancel, bulk-cancel, pause/resume, options limits, SSE `Last-Event-ID`, **certified**), `openwop-conformance-seams-v2` (witnessCount 4, **certified**) — the first bundle from this host that certifies every profile it claims, and the charter §F witness for suite 2.0.0.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`42545931c2d2…`**, Ed25519 under `v2-reference-2` (`keys/host.pub.pem`). `check-cut-gates.mjs --host-bundle --host-discovery --network` (spec repo at rc.58): every predicate PASS — Identity, Registers, Closure, Deprecation, Paths, Codemods, Waiver, Witness, Coexistence, Front door.
>
> **What changed since rc.57:** the host caught up with the rc.40–rc.53 prose (cancel on a terminal run → `409 run_terminal`; malformed body → `400 validation_error`; pause/resume 409 codes and the literal `drainPolicy` echo, `immediate` cutting the attempt vs `drain-current-node` letting the node finish; the v1 bare id ↔ `<tenantId>/<id>` projection; a fully-implemented pin continuing under the adapter) and the suite fixed `v2-era-2-append-vocabulary` (rc.58), which had read `events` off the response object and so could never witness the writer rule on any host.
>
> **The 42 inapplicable rows:** optional families this host does not advertise (`a2a`, `mcp`, `saml`, `scim`, packs), each recorded with its reason by `behaviorGate` / `softSkip`, plus the corpus-ledger row (`inapplicable` since rc.57).

> **SUPERSEDED measurement — 2026-09-05, `@openwop/openwop-conformance@2.0.0-rc.57` (targeted a STALE process).** The cut script started this host on port 3839 but pointed `--certify` at 3838, where a reference host from a 2026-09-04 worktree (pre-fix code, key `v2-reference-1`) was still listening; the 10 executed-fail rows below are that process's, not this build's, and the discovery the signature was checked against was the 3839 host's. Kept as the record of what was checked into the spec repo as `evidence/v2-host-bundles/openwop-host-v2-reference.json` at rc.57 before the replacement above. Original text follows: `@openwop/openwop-conformance@2.0.0-rc.57` + `@openwop/spec-artifacts@2.0.0-rc.57` (npm, corpus stamp `cc3f5bc494e6` VERIFIED), `--target-major 2 --max-workers 4`, **71** scenario files. Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:3f8bff3dd61dbe91efe27b6d968932574e737e22`, local boot on port 3839, fresh store, one run. Route-level harness 21 / 21.
>
> **RFC 0148 §A dispositions (222 rows, 1511 assertions): executed-pass 169 · executed-fail 10 · blocked 1 · inapplicable 42 · skipped 0.** `claimedProfiles` = `openwop-discovery-core` (witnessCount 3), `openwop-core-standard` (witnessCount 8), `openwop-conformance-seams-v2` (witnessCount 4) — the first NON-VACUOUS bundle this host has produced (the rc.16 bundle predates `witnessCount`, so it never anchored the v1 end-of-support clock; this one does). It certifies no profile — `executedFail > 0`, `blocked > 0`.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`5fedc4fe8ac2…`**, Ed25519 under the ROTATED key id `v2-reference-2` (`keys/host.pub.pem`; `v2-reference-1`'s public half is in git history and still verifies the rc.16 bundle). `check-cut-gates.mjs --host-bundle --host-discovery --network`: Identity, Registers, Closure, Deprecation, Paths, Codemods, Waiver, **Witness PASS**; attestation verifies under the host's published key; **Coexistence FAIL** (`0172.dual-stack-negotiation.cross-major-read`); **Front door FAIL** (`executedFail = 10`).
>
> **The 10 executed-fail rows are the corpus moving past its own reference example.** Every one is a rule the prose changed between rc.16 and rc.57 (the runs.md and errors.md retrospectives, rc.40–rc.53) that this host, written against rc.1–rc.16, never caught up with — 4 requirement rows and the 6 scenario-file rows they roll up into. Host fixes follow in a separate PR; this bundle is checked in first because it anchors the clock (runbook §5.2: `certified` does not matter for the anchor, `witnessCount ≥ 1` does).
>
> | requirement row | the rule (prose) | what this host does today |
> |---|---|---|
> | `0170.run-cancel` (rolls up `v2-run-cancel`, `v2-run-bulk-cancel`) | `runs.md` §Cancel: cancel on a terminal run MUST be `409 run_terminal`; the 200 grammar is only `{ runId, status: cancelling \| cancelled }` | answers `200` echoing `completed` |
> | `0172.dual-stack-negotiation.cross-major-read` (rolls up `v2-dual-stack-negotiation`) | `versioning.md` §5: a run minted under major 1 MUST be named by its tenant-bound projection `<tenantId>/<v1 id>` when read under major 2 | names it by the bare v1 id |
> | `0172.malformed-body-envelope` (rolls up `v2-malformed-body-envelope`) | `errors.md`: a malformed JSON body MUST be refused `400 validation_error` | `500` from the default handler |
> | `0176.pinned-run-disposition.continued` (rolls up `v2-pinned-run-disposition`, `v2-run-pause-resume`'s 409 legs share the §Cancel/§Pause vocabulary) | `persistence.md` §Runs pinned to v1: a run whose every pinned change id is still implemented MUST continue under the adapter | cancels it |
>
> **The 1 blocked row:** `v2-era-2-append-vocabulary` · the append leg — `seedEra2Log` reports success but the seeded log reads back empty (0 events); the seam's return value is not evidence, so the leg is `blocked` with that reason. Seam defect, this host's, same follow-up PR.
>
> **The 42 inapplicable rows:** 25 profile-not-advertised (`a2a`, `mcp`, `saml`, `scim`, packs — families this host does not implement, recorded by `behaviorGate`/`softSkip` with the reason), 2 `subject-link` (neither identity lane), 2 MRTR ceiling (`mcp`), 2 negotiation-authenticated (`a2a`/`mcp`), and the corpus-ledger row — `inapplicable` since rc.57, previously mis-labelled `blocked`.
>
> The sections below record the earlier measurement and are kept as history until the host-fix PR re-cuts.

> **Measurement — 2026-09-04, `@openwop/openwop-conformance@2.0.0-rc.2` + `@openwop/spec-artifacts@2.0.0-rc.2` (both packed from `openwop/openwop@75d572d9`, `origin/main`), `--target-major 2`, **52** scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:3120f306e24ef8c469238b2d3f3937477de1346b`, local boot, fresh store, one run.
>
> **52 / 52 files and 229 / 229 tests pass. RFC 0148 §A dispositions (`evidence/requirement-ledger.jsonl`, 295 rows): executed-pass 240 · executed-fail 0 · blocked 17 · inapplicable 38 · skipped 0.** Route-level harness 21 / 21. The host emits no `[schema]` warning on any route with the dev validator on.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`e7ca08db7ee15c16be847d71c2630f9a09d22cc5e77d4ac281e51d8f96db9599`**, 186 requirement rows, 1318 assertions, totals `executedPass 144 · executedFail 0 · skipped 0 · inapplicable 24 · blocked 18`, `claimedProfiles` = `openwop-discovery-core`, `openwop-core-standard`, `openwop-conformance-seams-v2`. Ed25519 under key id `v2-reference-1` (`keys/host.pub.pem`). Independently verified: schema-valid, `signatureVerified: true`, `rejections: []`. It certifies no profile — `blocked > 0`.
>
> **All three §F host cut gates PASS (`exit 0`).**

## Cut gates (`scripts/check-cut-gates.mjs --host-bundle …`, spec worktree at `56cd5d7b`)

`Identity`, `Registers`, `Closure`, `Deprecation`, `Paths`, `Codemods`, `Waiver` — PASS (corpus-side). The three host gates:

```
PASS    Witness
   ok  node scripts/check-declaration.mjs  — === check-declaration OK — 86 family rows (71 core / 13 ext / 2 deleted), 17 metadata keys, 3 profiles; every v1 root key anchored ===
   ok  …/bundle-v3.json results.requirements  — 108 v2 requirement ids each carry ≥1 ledger row
   ok  …/bundle-v3.json results.requirements[].detail  — every non-pass row states a reason

PASS    Coexistence
   ok  …/bundle-v3.json openwop.requirement.0172.dual-stack-negotiation.*  — 4 leg(s): executed-pass=4
   ok  …/bundle-v3.json openwop.requirement.0176.fork-a-v1-run.*  — 2 leg(s): executed-pass=2
   ok  …/bundle-v3.json openwop.requirement.0176.v1-signed-webhook-accepted.*  — 2 leg(s): executed-pass=2
   ok  …/bundle-v3.json openwop.requirement.0177.manifest-ceiling-refused.*  — 3 leg(s): executed-pass=3

PASS    Front door
   ok  node scripts/check-core-budget.mjs  — === check-core-budget OK — 21,070 / 25,000 words across 20 document(s) ===
   ok  …/bundle-v3.json results.totals  — executedFail=0 executedPass=144 blocked=18
   ok  INTEROP-MATRIX.md  — row for openwop-host-v2-reference
   ok  …/bundle-v3.json signature  — signed by v2-reference-1

=== 0 failed, 0 blocked → exit 0
```

**All three pass.** The INTEROP-MATRIX row landed on the spec side, closing the last Front-door check.

## The writer rule (`persistence.md` §The writer rule, Phase 4)

The era key is fixed at run creation and fixes the log's vocabulary for the run's lifetime: an append to an era-`2` run MUST use v1 vocabulary. **Measured against this host before implementing it, the rule already held — accidentally.** Every one of the 16 event types this host can append is an *identity* row in the codemap (`run.started`, `run.cancelled`, `node.*`, `interrupt.*`, `compensation.requested|started`), so the v1 and v2 spellings coincide and an era-2 append was valid v1 vocabulary by luck; the era column was never restamped either. But `appendEvent()` had **no era awareness at all** — had the host emitted any of the 36 renamed types, or a v2-only name, it would have corrupted the log exactly as the rule describes.

That is now structural rather than coincidental:

- `toStorageVocabulary(type, era)` (`src/codemap.ts`) maps a v2 name to the spelling the codemap maps *from* when the run is era `< 3`, and **refuses the append** when no v1 preimage exists — a host must not write a name its own reader would fail on.
- `appendEvent()` (`src/events.ts`) stores that spelling and never restamps the era; the document on the wire keeps its v2 name, so readers are unaffected.
- The reader's tolerant fallback is gone: `translateType()` no longer accepts a registered *v2* name found in an era-2 log. `persistence.md` §The reader rule says a type the codemap does not name on its v1 side fails the read, and tolerating it would hide precisely this defect.

Witnessed end to end by the harness (`test/routes.test.ts`): a seeded open era-2 run, cancelled through the canonical `POST /runs/{runId}/cancel`, stores `run.cancelled`, reads back as `['run.started','agent.tool-called','run.cancelled']` with sequences `[0,1,2]`, and still reports `eventLogSchemaVersion: 2`. The pure mapping is asserted over all three shapes (`agent.tool-called` → `agent.toolCalled`, identity, era-3 passthrough, and the refusal).

## What changed since the previous measurement

| | last round (rc.1 / 51 files) | now (rc.2 / 52 files) |
|---|---|---|
| scenario files | 51 | **52** (`v2-era-2-append-vocabulary`) |
| executed-pass / blocked | 238 / 16 | **240 / 17** |
| `claimedProfiles` | `[]` (resolver missed the hoisted peer) | **the three registry predicates the root satisfies** |
| Witness / Coexistence / Front door | PASS / PASS / FAIL (matrix row) | **PASS / PASS / PASS** |
| executed-fail | 0 | **0** |

## The 17 blocked rows, each with the suite's own reason

| Leg(s) | Reason |
|---|---|
| `v2-era-2-append-vocabulary` · the append leg | the scenario drives `POST /runs/{runId}:cancel`; the canonical path is `/cancel` (see Deviations 2) |
| `v2-negotiation-authenticated` ×2, `v2-negotiation-decided-emitted` ×2, `v2-minimum-version-refused` ×2, `v2-mrtr-rounds-ceiling` ×2, `v2-refresh-sla`, `v2-legacy-profiles-absent` | the host advertises neither `a2a` nor `mcp` — REST is the wire, no embedded protocol is composed |
| `v2-subject-link-record` ×2 | neither `saml` nor `scim` lane is advertised (no IdP integration) |
| `v2-error-registry` · 429 carries `Retry-After` | no 429 was observed during the run (the bucket is 1200/min) |
| `v2-peer-dependency-declared` · alias installs through the overlap | no facet-less alias row names a family this host advertises |
| `v2-lane-issuer-advertised` · windowed rules advertise a window | no advertised lane uses `exp-and-recheck` / `short-lived` / `rebind` |
| `v2-coherence-not-in-bundle` · corpus-ledger ids disjoint | server-free; the published layout ships no `evidence/corpus-ledger.json` |

## The 38 inapplicable rows

`v2-pack-isolation` (10 — no `sandbox`: the host registers and validates packs and executes none), `v2-provider-conflict` (3), `v2-chain-pin-exact` (3), `v2-form-when-reuses-edge-conditions` (2), and the file-level rows of the a2a / mcp / saml scenarios above.

## Deviations and open observations

1. **`claimedProfiles` is populated, and matches the hand derivation exactly** — `openwop-discovery-core`, `openwop-core-standard`, `openwop-conformance-seams-v2`, each `evidenceTier: self`, `witnessCount: 0`, `certified: false`. The rc.1 resolver gap is closed. None certifies: `blocked > 0`.

   `--certify` still exits 3, now for a different reason. With `openwop-core-standard` claimed, the CLI checks it against `PROFILE_FLOOR_SCENARIOS['openwop-core-standard']` (`conformance/src/lib/profiles.ts:526–536`, read at `cli.ts:626`) — a hard-coded **v1** floor of `runs-lifecycle.test.ts`, `discovery.test.ts`, `auth.test.ts`, `eventOrdering.test.ts`, `failure-path.test.ts`, `idempotency.test.ts`, `idempotency-key-determinism.test.ts`, `webhook-negative.test.ts`, every one of which `scenario-majors.json` assigns to major **1** and a `--target-major 2` run therefore never executes. The v2 registry's own `floorScenarios` for that profile is `[]` (`spec/v2/profiles.json`, "the floor is minted with the 2.0.0 scenarios (planned)"), so the check reads a v1 table for a v2 claim. It does not change the outcome — `blocked > 0` already prevents certification — but it is why the exit code is 3 rather than 0.

2. **The new `v2-era-2-append-vocabulary` scenario records `blocked` on its first leg, for a path bug in the scenario.** It drives the mutation with `POST /runs/{runId}:cancel` (`conformance/src/scenarios/v2-era-2-append-vocabulary.test.ts:68` and `:128`), but the canonical operation is `POST /runs/{runId}/cancel` — `api/v2/openapi.yaml:536` and `runs.md:23`, and every other scenario in the suite uses the slash form. A conforming host answers `404`, so the leg soft-skips with *"POST /runs/{runId}:cancel answered 404 on a seeded era-2 run — no canonical mutation drove the host's writer, so the append is unwitnessed"*. Leg 2 (the era is not promoted) executes and passes. Driving the identical flow at the canonical path — which the host's own harness now does — the leg's assertions all hold. The host was not changed to serve `:cancel`.
3. **The relaxation.** The run used `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` — the suite's webhook receiver is a loopback listener a conforming egress guard refuses. Recorded in the bundle as `host.relaxations[0]` (`webhooks.md §Egress`, `durability: session`). No other relaxation was in force. With the guard on (exercised by `npm test`) such a registration answers `400 webhook_url_rejected`.
4. **Unverified.** The CI workflow skips until the rc peers are on npm. The SSRF guard's DNS re-resolution path is exercised only against loopback. `core.httpFetch` replay suppression and the `session` lane are covered by the harness and the two effect seams, not by an independent host.

## INTEROP-MATRIX row (for the spec repo to add)

| Host | Implemented from | Suite / artifacts | Target | Advertised profiles | Discovery | pass / fail / blocked / inapplicable / skipped | Bundle | Evidence tier | Certified |
|---|---|---|---|---|---|---|---|---|---|
| `openwop-host-v2-reference@2.0.0-rc.1` (`openwop/openwop-examples`, `examples/hosts/v2-reference`, build `commit:3120f306`) | `spec/v2/core/` prose + generated v2 documents (never from a v1 host) | `@openwop/openwop-conformance@2.0.0-rc.2` / `@openwop/spec-artifacts@2.0.0-rc.2` | 2 | `openwop-discovery-core`, `openwop-core-standard`, `openwop-conformance-seams-v2` — as the bundle now emits them | `["1.11","2.0"]`, preferred `1.11`, sha256 `0a270c517995a1690900b3441d3fd0fe9f5476e07952001e9fa8a412fbf12231` | 240 / 0 / 17 / 38 / 0 (295 ledger rows) | `examples/hosts/v2-reference/bundle-v3.json`, witness `e7ca08db7ee1…`, signed `v2-reference-1` | `self` | none (`blocked > 0`) |

## Reproduce

```bash
cd examples/hosts/v2-reference
npm install --legacy-peer-deps
OPENWOP_WEBHOOK_ALLOW_PRIVATE=true OPENWOP_IMPLEMENTED_CHANGE_IDS=openwop.change.v1-interrupt-key-fold \
  OPENWOP_HOST_BUILD=commit:$(git rev-parse HEAD) npm start &
OPENWOP_TEST_IMPLEMENTED_CHANGE_ID=openwop.change.v1-interrupt-key-fold \
  npx openwop-conformance --base-url http://127.0.0.1:3838 --api-key openwop-v2-dev-key \
  --target-major 2 --max-workers 4 --certify bundle-v3.json \
  --host-build commit:$(git rev-parse HEAD) --signing-key keys/host.pem --signing-key-id v2-reference-1
npm test
```
