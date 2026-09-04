# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-03, `@openwop/openwop-conformance@2.0.0-rc.1` + `@openwop/spec-artifacts@2.0.0-rc.1` (both packed from `openwop/openwop@56cd5d7b`, `origin/main`), `--target-major 2`, 51 scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:8201d952e27b03b589cd7f6f8c367d165e14e258`, local boot, fresh store, one run.
>
> **51 / 51 files and 227 / 227 tests pass. RFC 0148 §A dispositions (`evidence/requirement-ledger.jsonl`, 292 rows): executed-pass 238 · executed-fail 0 · blocked 16 · inapplicable 38 · skipped 0.** Route-level harness 20 / 20. The host emits no `[schema]` warning on any route with the dev validator on.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`ae2590a769c0eb2f954f9a9b060209ac6e21ed869dd2de45221097a5610445eb`**, 183 requirement rows (**107 explicit `openwop.requirement.*`**, 24 `it`, 51 `scenario`, 1 `floor`), 1316 assertions, totals `executedPass 142 · executedFail 0 · skipped 0 · inapplicable 24 · blocked 17`. Ed25519 under key id `v2-reference-1` (`keys/host.pub.pem`). Independently verified: schema-valid, `signatureVerified: true`, `rejections: []`. It certifies no profile — `blocked > 0`.

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

FAIL    Front door
   ok  node scripts/check-core-budget.mjs  — === check-core-budget OK — 20,899 / 25,000 words across 20 document(s) ===
   ok  …/bundle-v3.json results.totals  — executedFail=0 executedPass=142 blocked=17
   XX  INTEROP-MATRIX.md  — no row names host openwop-host-v2-reference
   ok  …/bundle-v3.json signature  — signed by v2-reference-1
```

**Witness and Coexistence pass outright.** Front door is short exactly one row — the INTEROP-MATRIX entry, which lives in the spec repo and is not this repo's to add. `executedFail = 0` and the signature both hold.

## What changed since the previous measurement

| | two rounds ago | last round | now |
|---|---|---|---|
| explicit `openwop.requirement.*` rows | 0 of 84 | 86 | **107** (a leg that soft-skips before its first assertion now records under its own id) |
| `it` rows standing in for unnamed legs | — | 45 | **24** |
| Witness gate | FAIL (35 ids) | FAIL (35 ids) | **PASS (108 ids each carry a row)** |
| Coexistence gate | PASS | PASS | **PASS** |
| executed-fail | 4 | 0 | **0** |
| blocked | 18 | 16 | **16** |

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

1. **`claimedProfiles` is still emitted as `[]` — a suite path-resolution gap, not a host one.** `claimedProfilesForV2` (`conformance/src/cli.ts:322–331`) now evaluates the v2 registry, but probes three paths relative to `conformanceRoot` (`cli.ts:443`, the installed package directory), and **none exists in a published flat install**: `<conf>/spec/v2/profiles.json` (the suite tarball ships no `spec/`), `<conf>/../spec/v2/profiles.json` (that resolves to the `node_modules/@openwop/` scope directory, not a package), and `<conf>/node_modules/@openwop/spec-artifacts/…` (only when npm *nests* the peer; a hoisted install puts it one level up). The run says so on stderr — `spec/v2/profiles.json not found in this layout; claimedProfiles is empty (RFC 0169 §C.1)`. The path that exists here is `<conf>/../spec-artifacts/spec/v2/profiles.json`; the robust fix is the resolver `src/lib/paths.ts` already uses — `createRequire(join(PKG_ROOT, 'package.json')).resolve('@openwop/spec-artifacts/package.json')`. A repo checkout satisfies candidate #2, which is presumably where it was exercised.

   Running the CLI's own predicate against the registry at its real path, this host's v2 root satisfies all three profiles: **`openwop-discovery-core`** (metadata `protocolVersions`, `preferredVersion`), **`openwop-core-standard`** (families `interrupt`, `replay`, `webhooks`, `idempotency`, `eventLog`, each a record) and **`openwop-conformance-seams-v2`**. None would certify from this run in any case: `blocked > 0`.
2. **The relaxation.** The run used `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` — the suite's webhook receiver is a loopback listener a conforming egress guard refuses. Recorded in the bundle as `host.relaxations[0]` (`webhooks.md §Egress`, `durability: session`). No other relaxation was in force. With the guard on (exercised by `npm test`) such a registration answers `400 webhook_url_rejected`.
3. **Unverified.** The CI workflow skips until the rc peers are on npm. The SSRF guard's DNS re-resolution path is exercised only against loopback. `core.httpFetch` replay suppression and the `session` lane are covered by the harness and the two effect seams, not by an independent host.

## INTEROP-MATRIX row (for the spec repo to add)

| Host | Implemented from | Suite / artifacts | Target | Advertised profiles | Discovery | pass / fail / blocked / inapplicable / skipped | Bundle | Evidence tier | Certified |
|---|---|---|---|---|---|---|---|---|---|
| `openwop-host-v2-reference@2.0.0-rc.1` (`openwop/openwop-examples`, `examples/hosts/v2-reference`, build `commit:8201d952`) | `spec/v2/core/` prose + generated v2 documents (never from a v1 host) | `@openwop/openwop-conformance@2.0.0-rc.1` / `@openwop/spec-artifacts@2.0.0-rc.1` | 2 | `openwop-discovery-core`, `openwop-core-standard`, `openwop-conformance-seams-v2` (the registry predicates the root satisfies; the bundle emits `[]` — see Deviations 1) | `["1.11","2.0"]`, preferred `1.11`, sha256 `f02c05f1080679623a08aa73cdcbe6c1f18fdec6ea085b3652dc742f979bafb7` | 238 / 0 / 16 / 38 / 0 (292 ledger rows) | `examples/hosts/v2-reference/bundle-v3.json`, witness `ae2590a769c0…`, signed `v2-reference-1` | `self` | none (`blocked > 0`) |

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
