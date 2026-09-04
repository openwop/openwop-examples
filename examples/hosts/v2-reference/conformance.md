# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-03, `@openwop/openwop-conformance@2.0.0-rc.1` against `@openwop/spec-artifacts@2.0.0-rc.1` (both packed from the corpus at `v2-phase3-e4` / `da500baf`), `--target-major 2`, 51 scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:996abcae9f8d7fe7349965b983cf45fb037f0053`, local boot, fresh store, one run.
>
> **RFC 0148 §A dispositions (the suite's requirement ledger, `evidence/requirement-ledger.jsonl`, 292 rows): executed-pass 232 · executed-fail 4 · blocked 18 · inapplicable 38 · skipped 0.** vitest: 225 / 227 tests, 49 / 51 files green (`evidence/vitest-report.json`). Route-level harness: 20 / 20.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` `d809ccc3764c6a25ffcde62460786a917556f34d2780802b56f43e2bff0df6e2`, 99 requirement rows, 878 assertions, Ed25519 signature under key id `v2-reference-1` (public key `keys/host.pub.pem`). It validates against `schemas/v2/certification-bundle.schema.json` and `verifyBundleV3` returns **zero rejections** with a verified signature. It **certifies no profile**: `totals.blocked` is 19, and a bundle with `blocked > 0` does not certify (conformance.md §Bundle v3).

## What changed since the 2026-09-03 rc.1 measurement

The corpus fixed the six defects this host found plus the header-less contradiction (`v2-phase3-e4`). Every leg that was failing or blocked *because of* them now passes:

| Leg | Before | Now |
|---|---|---|
| `v2-capabilities-root-closed` (document validates) | executed-fail — `conformance.seamsProfile` was schema-illegal | **executed-pass** |
| `v2-no-transport-advertisement` | executed-fail — same closed-root assertion | **executed-pass** |
| `v2-event-type-closed` (envelope) | executed-fail — `type.oneOf` matched every registered type twice | **executed-pass** |
| `v2-id-grammar` (events) | executed-fail — same `oneOf` defect | **executed-pass** |
| `v2-bundle-v3-signed` (independent self-signed) | executed-fail — verifier certified a self-signed claim | **executed-pass** |
| `v2-effect-seam-manifest` (no re-fire on replay) | blocked — no seam fired a manifest row | **executed-pass** — `fireEffectSeam` implemented |
| `v2-effect-identity-business-key` (key across retries) | blocked — no fixture-provider seam | **executed-pass** — `forceEffectTransportRetry` implemented |
| `v2-preferred-version-default` (overlap rule) | n/a | **executed-pass** — the host's `preferredVersion: 1.11` is now the normative rule |
| bundle v3 emission | refused by its own schema | **emitted, signed, schema-valid** |

Host changes this required: `webhooks.retryPolicy` moved from a vendor extension to the family facet; `fork_point_invalid` (422) and `webhook_url_rejected` (400) replace the improvised codes; the effect ledger records **one row per transport attempt** under one identity (`effectId` + `providerKey` assigned once per business key); the `http.fetch` manifest row now states `branchReFires: false` (the Layer-2 key carries no `runId`, so a branch resolves to the recorded outcome); the dev-mode validator's defect whitelist is empty and the host emits no `[schema]` warning on any route.

## The 4 executed-fail rows (2 `it`s + their 2 file rows) — both server-free, both new

Neither reaches the host (`[unknown@unknown]` in both messages: the driver never issues a request). Both are contradictions introduced by the fixes themselves:

1. **`v2-coherence-not-in-bundle.test.ts:90`** — `conformance.md` §"Two products, two ledgers" (line 40) says "the bundle schema forbids their ids", and the scenario asserts a v3 bundle carrying `openwop.it.spec-corpus-validity.every-fixture-validates` is *rejected*. Fix #2 widened `certification-bundle.schema.json` to `^openwop\.(requirement|it|scenario|floor|profile|family)\.[a-z0-9]`, which now *admits* that id. The emitter needs `openwop.it.*` (47 of my 99 bundle rows are `it` rows); the coherence rule needs `openwop.it.spec-corpus-validity.*` refused. A negative lookahead on the corpus-coherence file stems satisfies both.
2. **`v2-relaxation-recorded.test.ts:97`** — the scenario requires a relaxation to be *scoped*: the relaxed profile must not certify while an unrelated profile (`openwop-discovery-core`) still does. Fix #3 (`certification-bundle-v3.ts:164`) returns `certifiedProfiles: rejections.length > 0 ? [] : certifiedProfiles`, emptying **every** profile as soon as any rejection exists. Excluding only the profiles the rejections name — keeping the bundle-wide emptying for `blocked-certified` and the `independent-*` kinds — satisfies both this leg and the `v2-bundle-v3-signed` leg that fix #3 was made for (that one passes either way, because its rejection names the profile it refuses).

## The 18 blocked rows, each with the suite's own reason

| Leg(s) | Reason |
|---|---|
| `v2-negotiation-authenticated` ×2, `v2-negotiation-decided-emitted` ×2, `v2-minimum-version-refused` ×2, `v2-mrtr-rounds-ceiling` ×2, `v2-refresh-sla` ×1, `v2-legacy-profiles-absent` ×1 | the host advertises neither `a2a` nor `mcp` — REST is the wire and no embedded protocol is composed |
| `v2-subject-link-record` ×2 | neither `saml` nor `scim` lane is advertised (no IdP integration) |
| `v2-error-registry` · 429 carries `Retry-After` | no 429 was observed during the run (the bucket is 1200/min); the scenario's own gate |
| `v2-pinned-run-disposition` · a still-implemented pin continues | opt-in `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` not supplied (the host reads `OPENWOP_IMPLEMENTED_CHANGE_IDS`) |
| `v2-peer-dependency-declared` · an alias row installs through the overlap | no facet-less alias row names a family this host advertises (`host.fs` → `fs` is not advertised) |
| `v2-capability-record-shape` · no `until` in the past | every advertised record is `stable` — nothing to check |
| `v2-lane-issuer-advertised` · windowed rules advertise a window | no advertised lane uses `exp-and-recheck` / `short-lived` / `rebind` |
| `v2-coherence-not-in-bundle` · corpus-ledger ids disjoint from scenarios | server-free; the published layout ships no `evidence/corpus-ledger.json` |

## The 38 inapplicable rows

`v2-pack-isolation` (10 — no `sandbox` family: the host registers and validates packs and executes none), `v2-provider-conflict` (3 — no `connections.packsSupported`), `v2-chain-pin-exact` (3 — no `workflowChainPacks`), `v2-form-when-reuses-edge-conditions` (2 — no `forms`), and the file-level rows of the a2a / mcp / saml scenarios above.

## The bundle, and what it says

```bash
npx openwop-conformance --base-url http://127.0.0.1:3838 --api-key openwop-v2-dev-key \
  --target-major 2 --certify bundle-v3.json \
  --host-build commit:$(git rev-parse HEAD) --signing-key keys/host.pem --signing-key-id v2-reference-1
# → wrote bundle v3 → bundle-v3.json (99 requirement rows, 878 assertions, witness d809ccc3764c,
#   signed by v2-reference-1; certified: none)   [exit 3]
```

`bundle-v3.json` totals: `executedPass 54 · executedFail 2 · skipped 0 · inapplicable 24 · blocked 19` over the suite's own per-file / per-`it` derivation (99 rows), which is a coarser projection of the 292-row ledger. Independently verified here: schema-valid, `signatureVerified: true` under `keys/host.pub.pem`, `rejections: []`, `certifiedProfiles: []`.

Three observations about the emitted bundle, none of them host-side:

- **`suite.targetMajor` records `1` for a `--target-major 2` run** (`cli.ts:574` reads `process.env['OPENWOP_TARGET_MAJOR']`, but line 428 sets that variable on the *child* vitest env, never on the CLI's own). The bundle therefore misreports which contract it measured.
- **`claimedProfiles` are the v1 profile set** (`openwop-discovery-core`, `openwop-stream-sse`, `openwop-stream-poll`, `openwop-node-packs`, `openwop-replay-fork`, `openwop-fixtures`), all `certified: false`. `runCertify` fetches `/.well-known/openwop` **header-less**, which under the new normative rule is the v1 representation through the overlap, so `claimedProfilesFor` derives v1 profiles. An overlap host cannot present its v2 root to this code path.
- **Exit 3** follows from that: the v1-derived profiles carry v1 floor scenarios (`openwop.floor.stream-modes`, `…replay-fork`, …) that a `--target-major 2` run never executes, so they are unclassified and certification is refused. The bundle is still written, which is the documented behaviour.

## Relaxations

The run used `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` — the suite's webhook receiver is a loopback listener a conforming egress guard refuses, and no `OPENWOP_WEBHOOK_RECEIVER_URL` tunnel was configured. It is recorded in the bundle as `host.relaxations[0]` (`obligation: webhooks.md §Egress …`, `durability: session`). No other relaxation was in force. Under the guard (exercised by `npm test`) a loopback, private, link-local, metadata or non-https registration answers `400 webhook_url_rejected` — the code the corpus now registers.

## INTEROP-MATRIX row (for the spec repo)

| Host | Suite / artifacts | Target | Discovery | pass / fail / blocked / inapplicable / skipped | Bundle | Certified |
|---|---|---|---|---|---|---|
| `openwop-host-v2-reference@2.0.0-rc.1` (`examples/hosts/v2-reference`, `commit:996abcae`) | `2.0.0-rc.1` / `2.0.0-rc.1` | 2 | `["1.11","2.0"]`, preferred `1.11`, sha256 `b1ef2c3a…` | 232 / 4 / 18 / 38 / 0 (292 ledger rows) | `bundle-v3.json`, witness `d809ccc3…`, signed `v2-reference-1` | none (`blocked > 0`) |

## Reproduce

```bash
cd examples/hosts/v2-reference
npm install --legacy-peer-deps                     # rc.1 peers; see README
OPENWOP_WEBHOOK_ALLOW_PRIVATE=true OPENWOP_HOST_BUILD=commit:$(git rev-parse HEAD) npm start &
npx openwop-conformance --base-url http://127.0.0.1:3838 --api-key openwop-v2-dev-key --target-major 2 --max-workers 4
npm test                                           # 20/20 route-level harness
```
