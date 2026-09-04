# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-03, `@openwop/openwop-conformance@2.0.0-rc.1` against `@openwop/spec-artifacts@2.0.0-rc.1`, `--target-major 2` (51 scenario files: the 50 `v2-*` scenarios + `fixtures-valid`).** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:3943f7b116c66bb223094b1d0651f60f91e4663e`, local boot (`OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`, see "Relaxations"), fresh store, one run.
>
> **RFC 0148 §A dispositions (the suite's own requirement ledger, `evidence/requirement-ledger.jsonl`, 291 rows): executed-pass 223 · executed-fail 10 · blocked 20 · inapplicable 38 · skipped 0.** vitest: 221 / 226 tests passed, 46 / 51 files green (`evidence/vitest-report.json`). Every one of the 10 `executed-fail` rows is a corpus or suite defect the host cannot satisfy (below); every `blocked` row names the seam, fixture or opt-in the suite itself says it lacks. **No `bundle-v3.json` is committed:** `openwop-conformance --certify … --bundle-version 3` refuses its own assembled bundle at 2.0.0-rc.1 (below, "The bundle").

## Witness and coexistence legs (executed-pass)

| Leg | Scenario | Result |
|---|---|---|
| dual stack | `v2-dual-stack-negotiation` | 4/4 — a run created through `/v1/runs` (no header) reads through `GET /runs/{id}` under `OpenWOP-Version: 2.0`; `9.0` → 406; `2.0` on `/v1/` → 400; every response names its contract |
| one resource | `v2-well-known-one-resource`, `v2-preferred-version-default` | header-less = the v1 rendering (`preferredVersion: 1.11` through the overlap), `OpenWOP-Version: 2.0` = the closed root; equal `protocolVersions[]`; no wrapper / mirror / `profiles[]` / `Capabilities-Etag` |
| era key | `v2-era-key` | `eventLogSchemaVersion: 3` on a new run and in discovery |
| reader rule | `v2-v1-events-translated` | poll, SSE (`streamMode=debug`) and the fork prefix read `agent.toolCalled → agent.tool-called` with sequence 0 preserved |
| unmapped refused | `v2-unmapped-type-refused` | poll and fork over a `foo.bar` row → `500 event_type_unmapped`, not retriable |
| fork a v1 run | `v2-fork-a-v1-run` | the fork's prefix is byte-equivalent to the translated parent; `run.started` carries `issuer: urn:openwop:legacy` on both |
| pinned run | `v2-pinned-run-disposition` | `run.cancelled { reason: v1_pin_unsupported, cancelledBy: v2-cutover }`, the pin row untouched (leg 2 needs `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID`, recorded `blocked`) |
| v1-signed webhook | `v2-v1-signed-webhook-accepted` | `signatureAlgorithms: ["v1"]`; an `X-openwop-*`-only delivery accepted, a tampered one refused |
| durable delivery | `v2-webhook-durable-delivery` | 500, 500, 204 → retried and delivered at least once; the exhausted delivery stops at `maxAttempts` (the sink read is a host extension, so the routing leg records `blocked` by the scenario's own design) |
| owner / identity | `v2-owner-subject-required`, `v2-id-grammar` (2/3), `v2-lane-issuer-advertised`, `v2-revocation-honored`, `v2-assurance-downgrade-audited`, `v2-interrupt-token-scheme`, `v2-approver-enforced` | subject on the owner; tenant-bound ids; three lanes; next-request revocation → `credential_revoked`; the key-bound floor → `sender_constraint_missing`; `ow2.hs256.<kid>` tokens; a non-listed approver → 403 |
| runs / events | `v2-poll-cursor-v2`, `v2-configurable-closed`, `v2-idempotency-key-grammar`, `v2-payload-registry-closed`, `v2-header-scheme`, `v2-error-registry` (2/3), `v2-enum-growth-rule`, `v2-min-client-version` | the closed poll shape; closed `configurable`; key grammar; every payload against `_typeIndex`; `OpenWOP-Version` on every response; the flat envelope at its registered status; 426 |
| replay / effects / compensation | `v2-effect-seam-manifest` (2/3), `v2-effect-identity-business-key` (1/2), `v2-compensation-read-projection` | manifest validates, every seam guarded, facet constant; the effects ledger and the compensation projection validate |
| packs | `v2-manifest-ceiling-refused`, `v2-manifest-hatch-carried`, `v2-peer-dependency-declared` (1/2) | `>=1.0.0` and `<2.0.0` → `pack_engine_unsupported`, `>=2.0.0 <3.0.0` installs; the hatch inside `agents[]` / `prompts[]` ignored; `host.nonexistent` → `pack_peer_dependency_undefined` |
| discovery shape | `v2-capability-record-shape`, `v2-profiles-derived-only`, `v2-legacy-profiles-absent`, `v2-capabilities-root-closed` (4/5) | every record `{status, since, witness}`; no root `profiles[]`; the closure legs (unknown / dotted / wrapper / `profiles[]`) hold |
| server-free | `fixtures-valid`, `v2-relaxation-recorded`, `v2-coherence-not-in-bundle` (1/2), `v2-bundle-v3-signed` (2/3) | run by the suite against its own fixtures |

## Every non-pass row, with the reason

### executed-fail (10 ledger rows = 5 `it`s + their 5 file rows)

| Requirement | Why | Whose defect |
|---|---|---|
| `openwop.requirement.0169.capabilities-root-closed.valid` (`v2-capabilities-root-closed`) | the v2 document carries `conformance.seamsProfile` — the key `lib/seams.ts` reads (RFC 0168 §C.1 reconciliation) — but `schemas/v2/capabilities.schema.json` closes `conformance` to `{ mockAgent, certificationBundleUrl }` (`data/conformance must NOT have additional properties`) | corpus: `spec/v2/declaration.json` metadata `conformance` lacks `seamsProfile` |
| `openwop.requirement.0175.no-transport-advertisement` (`v2-no-transport-advertisement`) | same document, same schema assertion inside the single `it` (the two named-key checks pass) | corpus, as above |
| `openwop.requirement.0171.event-type-closed.envelope` (`v2-event-type-closed`) | `run-event.schema.json` `properties.type` is a `oneOf` of the closed enum and the vendor pattern; every `domain.verb` protocol type matches both, so `run.started` fails "exactly one" (`data/type must match exactly one schema in oneOf`) — no host can pass this leg | corpus: `schemas/v2/run-event.schema.json` (should be `anyOf`, or the vendor branch must exclude registered names) |
| `openwop.requirement.0170.id-grammar.events` (`v2-id-grammar`) | validates each event as a `RunEventDoc` — the same `oneOf` defect | corpus, as above |
| `openwop.requirement.0168.bundle-v3-signed.independent-self-signed` (`v2-bundle-v3-signed`) | server-free: the suite's own `verifyBundleV3` certifies `openwop-core-v2` on an `independent` claim that is self-signed under the host key (`expected [ 'openwop-core-v2' ] to not include 'openwop-core-v2'`) | suite: `lib/certification-bundle-v3.ts` |

### blocked (20)

| Leg | Reason the suite records |
|---|---|
| `v2-effect-seam-manifest` · driving one seam of each kind observes no re-fire | no catalogued seam fires a manifest row inside a run (`/conformance/seams/sample/effect-seams/fire` is not in `api/seams-v2.yaml`); the host answers 404 |
| `v2-effect-identity-business-key` · the same provider key across two transport retries | no catalogued fixture-provider seam (`…/sample/test/idempotency/effect-retry`); 404 |
| `v2-error-registry` · a 429 carries `Retry-After` | no 429 was observed (the bucket is 1200/min); the scenario's own gate |
| `v2-pinned-run-disposition` · a still-implemented pin continues | opt-in `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` not supplied (the host honours `OPENWOP_IMPLEMENTED_CHANGE_IDS`) |
| `v2-peer-dependency-declared` · an alias row installs through the overlap | no facet-less alias row names a family this host advertises (`host.fs` → `fs` is not advertised) |
| `v2-capability-record-shape` · no `until` in the past | every advertised record is `stable`; nothing to check |
| `v2-lane-issuer-advertised` · windowed rules advertise a window | no advertised lane uses `exp-and-recheck` / `short-lived` / `rebind` |
| `v2-legacy-profiles-absent` · no `-legacy` id in `a2a.profiles` / `mcp.profiles` | neither facet is advertised (the root-`profiles[]` leg passes) |
| `v2-coherence-not-in-bundle` · corpus-ledger ids disjoint from scenarios | server-free; the published layout ships no `evidence/corpus-ledger.json` |
| `v2-negotiation-authenticated` ×2, `v2-negotiation-decided-emitted` ×2, `v2-minimum-version-refused` ×2, `v2-mrtr-rounds-ceiling` ×2, `v2-refresh-sla` ×1 | the host advertises neither `a2a` nor `mcp` — REST is the wire, no embedded protocol is composed |
| `v2-subject-link-record` ×2 | the host advertises neither `saml` nor `scim` (no IdP integration) |

### inapplicable (38)

`v2-pack-isolation` (10 rows, no `sandbox` family — the host registers packs and executes none), `v2-provider-conflict` (3, `connections.packsSupported` not advertised), `v2-chain-pin-exact` (3, `workflowChainPacks` not advertised), `v2-form-when-reuses-edge-conditions` (2, `forms` not advertised), and the file-level rows of the a2a/mcp/saml scenarios above.

## Relaxations

The measurement ran under `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`: the suite's webhook receiver is a loopback listener that a conforming egress guard refuses, and no public https tunnel (`OPENWOP_WEBHOOK_RECEIVER_URL`) was configured. This is an operator relaxation of `webhooks.md` §Egress (durability `session`) and was passed to `--certify` as `OPENWOP_HOST_RELAXATIONS` so the bundle would record it under `host.relaxations[]` — the run had no other relaxation. Under the guard (`npm test` exercises it) a loopback registration answers `400 validation_error { details.reason: webhook_url_rejected }`; the scenario keys its `blocked` branch on a bare `webhook_url_rejected` code that `spec/v2/errors.json` does not register, so it would record a failure instead.

## The bundle

`npx openwop-conformance --base-url … --api-key … --target-major 2 --certify bundle-v3.json --host-build commit:3943f7b1… --signing-key keys/host.pem --signing-key-id v2-reference-1` exits 2 with **"assembled v3 bundle FAILED schema validation"**: `schemas/v2/certification-bundle.schema.json` requires every `results.requirements[].id` to match `^openwop\.requirement\.`, while the emitter writes the ledger's `openwop.scenario.<file>`, `openwop.it.<file>.<title>` and `openwop.profile.<gate>` rows verbatim (210 of the 291 rows). `--bundle-version 2` fails the same way for a different reason (`suite.version` must match `^\d+\.\d+\.\d+$`; the suite is `2.0.0-rc.1`). No suite-emitted bundle exists at 2.0.0-rc.1; the inputs the bundle would carry are committed instead:

- `evidence/requirement-ledger.jsonl` — the 291 disposition rows the scenarios recorded (`OPENWOP_LEDGER_PATH`);
- `evidence/vitest-report.json` — the vitest JSON report of the same run;
- discovery capture: header-less `GET /.well-known/openwop` canonical-JSON sha256 `0e6d359cac005ebd179e175f9b21d1fdd8fb8ea82d93338fd9915125ef4f4de4`, `protocolVersions ["1.11", "2.0"]`, `preferredVersion "1.11"`;
- signing key: `keys/host.pub.pem` (Ed25519, key id `v2-reference-1`); the bundle is re-cut with the same command once the suite emits a schema-valid v3.

Under RFC 0148 §A a bundle with `blocked > 0` does not certify, and none of the three registry profiles would certify from this run: `openwop-discovery-core`'s floor scenario `capabilities-root-closed` carries the schema fail above; `openwop-core-standard` (families `interrupt`, `replay`, `webhooks`, `idempotency`, `eventLog` — all advertised) has blocked rows on its floor.

## INTEROP-MATRIX row (for the spec repo)

| Host | Suite | Target | Discovery | executed-pass / fail / blocked / inapplicable / skipped | Certified | Notes |
|---|---|---|---|---|---|---|
| `openwop-host-v2-reference@2.0.0-rc.1` (`examples/hosts/v2-reference`, build `commit:3943f7b1`) | `2.0.0-rc.1` / spec-artifacts `2.0.0-rc.1` | 2 | `["1.11", "2.0"]`, preferred `1.11` | 223 / 10 / 20 / 38 / 0 (291 rows) | none (bundle unemittable at rc.1; blocked > 0) | 10 fails = 2 corpus schema defects + 1 suite defect; relaxation `webhooks.md §Egress` (session) |

## Reproduce

```bash
cd examples/hosts/v2-reference
npm install --legacy-peer-deps            # rc.1 peers from the release tarballs until they are on npm (README)
OPENWOP_WEBHOOK_ALLOW_PRIVATE=true OPENWOP_HOST_BUILD=commit:$(git rev-parse HEAD) npm start &
npx openwop-conformance --base-url http://127.0.0.1:3838 --api-key openwop-v2-dev-key --target-major 2 --max-workers 4
npm test                                  # 18/18 route-level harness (in-memory store, strict schema validation)
```
