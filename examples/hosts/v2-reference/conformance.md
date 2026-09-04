# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-03, `@openwop/openwop-conformance@2.0.0-rc.1` + `@openwop/spec-artifacts@2.0.0-rc.1` (both packed from `openwop/openwop@0db7e26d`, `origin/main`), `--target-major 2`, 51 scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:50814360c24f7b246fcc8b08f8f44d88af23a462`, local boot, fresh store, one run.
>
> **51 / 51 files and 227 / 227 tests pass. RFC 0148 §A dispositions (`evidence/requirement-ledger.jsonl`, 292 rows): executed-pass 238 · executed-fail 0 · blocked 16 · inapplicable 38 · skipped 0.** Route-level harness 20 / 20. The host emits no `[schema]` warning on any route with the dev validator on.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`5482704eae3eaa3fa13a98b60eaf9c4f7bc649b9cafba1992f587415b6ed328b`**, 183 requirement rows (86 explicit `openwop.requirement.*`, 45 `it`, 51 `scenario`, 1 `floor`), 1316 assertions, totals `executedPass 142 · executedFail 0 · skipped 0 · inapplicable 24 · blocked 17`. Ed25519 under key id `v2-reference-1` (`keys/host.pub.pem`). Independently verified: schema-valid, `signatureVerified: true`, `rejections: []`. It certifies no profile — `blocked > 0`.

## Cut gates (`scripts/check-cut-gates.mjs --host-bundle …`)

`Identity`, `Registers`, `Closure`, `Deprecation`, `Paths`, `Codemods`, `Waiver` — PASS (corpus-side). The three host gates:

```
FAIL    Witness
   ok  node scripts/check-declaration.mjs  — === check-declaration OK — 86 family rows (71 core / 13 ext / 2 deleted), 17 metadata keys, 3 profiles; every v1 root key anchored ===
   XX  …/bundle-v3.json results.requirements  — 35/121 v2 requirement ids have no ledger row: openwop.requirement.0168.bundle-v3-signed.fixture-a, openwop.requirement.0168.bundle-v3-signed.fixture-b, openwop.requirement.0177.chain-pin-exact.range-refused, openwop.requirement.0177.chain-pin-exact.exact-accepted, openwop.requirement.0168.coherence-not-in-bundle.disjoint-by-construction, …
   ok  …/bundle-v3.json results.requirements[].detail  — every non-pass row states a reason

PASS    Coexistence
   ok  …/bundle-v3.json openwop.requirement.0172.dual-stack-negotiation.*  — 4 leg(s): executed-pass=4
   ok  …/bundle-v3.json openwop.requirement.0176.fork-a-v1-run.*  — 2 leg(s): executed-pass=2
   ok  …/bundle-v3.json openwop.requirement.0176.v1-signed-webhook-accepted.*  — 2 leg(s): executed-pass=2
   ok  …/bundle-v3.json openwop.requirement.0177.manifest-ceiling-refused.*  — 3 leg(s): executed-pass=3

FAIL    Front door
   ok  node scripts/check-core-budget.mjs  — === check-core-budget OK — 20,899 / 25,000 words across 20 document(s) ===
   ok  …/bundle-v3.json results.totals  — executedFail=0 executedPass=142 blocked=17
   XX  INTEROP-MATRIX.md  — no row names host openwop-host-v2-reference
   ok  …/bundle-v3.json signature  — signed by v2-reference-1
```

**Coexistence passes outright.** Front door fails on one row only — the INTEROP-MATRIX entry, which lives in the spec repo and is not this repo's to add; `executedFail=0` and the signature both hold.

### Witness: what the 35 missing ids are

The gate requires a ledger row for every `openwop.requirement.*` id appearing in a major-2 scenario file. Two populations cannot supply one, neither of them a host gap:

- **4 ids are fixture data, not citations.** `check-cut-gates.mjs` harvests quoted ids with a regex over the file, so it collects ids that server-free scenarios *construct inside a bundle they validate*: `openwop.requirement.0168.bundle-v3-signed.fixture-a` and `.fixture-b` (`v2-bundle-v3-signed.test.ts:42–43`), `openwop.requirement.0168.coherence-not-in-bundle.fixture` (`v2-coherence-not-in-bundle.test.ts:92`) and `openwop.requirement.0169.capabilities-root-closed` (`v2-relaxation-recorded.test.ts:37`). No host bundle can ever carry them — they are rows in a synthetic fixture. Harvesting `req()` call sites rather than string literals removes all four.
- **31 ids belong to legs this host never reaches, because it honestly omits the family.** `capabilities.md` §2 says "a host that does not support a family MUST omit it", so a host that omits any optional family cannot have a row for its requirement ids: `v2-pack-isolation` (10 — no `sandbox`), the a2a/mcp scenarios (`minimum-version-refused`, `mrtr-rounds-ceiling`, `negotiation-authenticated`, `negotiation-decided-emitted`, `refresh-sla`, `legacy-profiles-absent` — 9), `v2-subject-link-record` (2 — no `saml`/`scim`), `v2-provider-conflict` (2), `v2-chain-pin-exact` (2), `v2-form-when-reuses-edge-conditions` (1), plus four environment-gated legs (`error-registry.retry-after` — no 429 was provoked; `lane-issuer-advertised.window` — no windowed lane; `peer-dependency-declared.alias-overlap` — no alias row names an advertised family; `coherence-not-in-bundle.disjoint-by-construction` — `evidence/corpus-ledger.json` is not in the published layout).

  The bundle already records each of those scenarios as `inapplicable` **with a reason**, and the gate's own second check ("every non-pass row states a reason") passes. Gating the required id set on the scenarios that were not `inapplicable` — or deriving it from the host's advertised families — makes Witness satisfiable by an honest host without weakening it.

## What changed since the previous measurement

| | before | now |
|---|---|---|
| explicit `openwop.requirement.*` rows in the bundle | 0 of 84 | **86** (the ledger records the file that wrote each entry) |
| `suite.targetMajor` | `1` on a major-2 run | **`2`** |
| `claimedProfiles` | the v1 set (discovery was read header-less) | `[]` — see below |
| `v2-coherence-not-in-bundle`, `v2-relaxation-recorded` | executed-fail | **executed-pass** (id pattern excludes coherence stems; rejections scope to the profile they name) |
| executed-fail | 4 | **0** |
| blocked | 18 | **16** |

Host-side changes in this round: every family record now advertises the maturity `spec/v2/declaration.json` declares — 11 of the 12 are `technical: experimental`, so they carry `status: "experimental"` with `until: "2.1"` and only `limits` stays `stable` (capabilities.md §8; previously all 12 over-claimed `stable`). The run also supplies the operator opt-in `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` / `OPENWOP_IMPLEMENTED_CHANGE_IDS` (`openwop.change.v1-interrupt-key-fold`), so `pinned-run-disposition`'s continue leg is witnessed rather than skipped.

## The 16 blocked rows, each with the suite's own reason

| Leg(s) | Reason |
|---|---|
| `v2-negotiation-authenticated` ×2, `v2-negotiation-decided-emitted` ×2, `v2-minimum-version-refused` ×2, `v2-mrtr-rounds-ceiling` ×2, `v2-refresh-sla`, `v2-legacy-profiles-absent` | the host advertises neither `a2a` nor `mcp` — REST is the wire, no embedded protocol is composed |
| `v2-subject-link-record` ×2 | neither `saml` nor `scim` lane is advertised (no IdP integration) |
| `v2-error-registry` · 429 carries `Retry-After` | no 429 was observed during the run (the bucket is 1200/min) |
| `v2-peer-dependency-declared` · alias installs through the overlap | no facet-less alias row names a family this host advertises |
| `v2-lane-issuer-advertised` · windowed rules advertise a window | no advertised lane uses `exp-and-recheck` / `short-lived` / `rebind` |
| `v2-coherence-not-in-bundle` · corpus-ledger ids disjoint | server-free; the published layout ships no `evidence/corpus-ledger.json` |

## The 38 inapplicable rows

`v2-pack-isolation` (10 — no `sandbox`: the host registers and validates packs and executes none), `v2-provider-conflict` (3), `v2-chain-pin-exact` (3), `v2-form-when-reuses-edge-conditions` (2), and the file-level rows of the a2a / mcp / saml scenarios above.

## Deviations and open observations

1. **`claimedProfiles` is empty.** `--certify` now reads discovery under the target major's header (correct), but `claimedProfilesFor` derives only the **v1** profile predicates (`isCore` wants a root `protocolVersion` string plus `supportedEnvelopes` / `schemaVersions` / `limits`), which a closed v2 root does not satisfy. The v2 registry predicates in `spec/v2/profiles.json` are never evaluated. Evaluated by hand against this host's v2 document, all three hold: `openwop-discovery-core` (metadata `protocolVersions`, `preferredVersion`), `openwop-core-standard` (families `interrupt`, `replay`, `webhooks`, `idempotency`, `eventLog` — all present as records) and `openwop-conformance-seams-v2` (advertised as `conformance.seamsProfile`). None would certify from this run in any case: `blocked > 0`.
2. **The relaxation.** The run used `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` — the suite's webhook receiver is a loopback listener a conforming egress guard refuses. Recorded in the bundle as `host.relaxations[0]` (`webhooks.md §Egress`, `durability: session`). No other relaxation was in force. With the guard on (exercised by `npm test`) such a registration answers `400 webhook_url_rejected`.
3. **Unverified.** The CI workflow skips until the rc peers are on npm. The SSRF guard's DNS re-resolution path is exercised only against loopback. `core.httpFetch` replay suppression and the `session` lane are covered by the harness and the two effect seams, not by an independent host.

## INTEROP-MATRIX row (for the spec repo to add)

| Host | Implemented from | Suite / artifacts | Target | Advertised profiles | Discovery | pass / fail / blocked / inapplicable / skipped | Bundle | Evidence tier | Certified |
|---|---|---|---|---|---|---|---|---|---|
| `openwop-host-v2-reference@2.0.0-rc.1` (`openwop/openwop-examples`, `examples/hosts/v2-reference`, build `commit:50814360`) | `spec/v2/core/` prose + generated v2 documents (never from a v1 host) | `@openwop/openwop-conformance@2.0.0-rc.1` / `@openwop/spec-artifacts@2.0.0-rc.1` | 2 | `openwop-discovery-core`, `openwop-core-standard`, `openwop-conformance-seams-v2` (derived from `spec/v2/profiles.json`; the bundle's `claimedProfiles` is empty — see Deviations 1) | `["1.11","2.0"]`, preferred `1.11`, sha256 `7780f4d1fe717d229941d1b33fba5a1ad0db6cd2b4a722b5cf31103e2eb154ae` | 238 / 0 / 16 / 38 / 0 (292 ledger rows) | `examples/hosts/v2-reference/bundle-v3.json`, witness `5482704eae3e…`, signed `v2-reference-1` | `self` | none (`blocked > 0`) |

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
