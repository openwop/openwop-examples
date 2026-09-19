# Conformance Result: openwop v2 reference host

> **Measurement — 2026-09-19, `@openwop/openwop-conformance@2.25.0` + `@openwop/spec-artifacts@2.25.0` (npm, corpus stamp VERIFIED — 277 vendored files), `--target-major 2 --require-behavior --max-workers 1`, build `commit:796b076`.**
>
> **RFC 0148 §A dispositions (246 rows, 1996 assertions): executed-pass 233 · executed-fail 0 · blocked 0 · inapplicable 6 · skipped 7.** All three claimed profiles certified. `witnessSha256` **`c27516af1841…`**, Ed25519 under key id `v2-reference-3`.
>
> **This host now advertises `webhooks.deadLetter` and serves the canonical RFC 0188 read.** It had served `GET /webhooks/{webhookId}/dead-letters` for some time — as a **vendor extension**, under `extensions.<org>.host.deadLetterRead`, returning a vendor-shaped body. Advertising the facet without fixing the shape would have published exactly the vacuous claim RFC 0193 exists to stop, so the projection was rewritten to §A:
>
> - The page is closed over `{deliveries, nextCursor}`. The old root carried `webhookId` and `retentionDays`, which `additionalProperties: false` forbids, and named the array `deadLetters`.
> - The record carries the nine required fields. It previously omitted `webhookId`, `eventId`, `expiresAt` and `reason`, and carried `sequence` and **`lastError`** — the subscriber's response text. §B.1 makes the record content-free *by construction*, and that field was the reason why: a dead-letter queue is precisely the traffic the subscriber never received.
> - §A.2's tenant check now runs **before** the lookup, so a foreign-tenant id that does not exist answers `403 id_tenant_mismatch` rather than `404`. It had been checked after, which made the refusal depend on existence.
> - §A.3 pagination: `limit` clamped to the advertised `maxPageSize`, an HMAC-signed keyset cursor **bound to the subscription**, so one minted elsewhere is refused `400 validation_error` rather than interpreted.
> - `expiresAt` is derived from the same config the retention purge uses, so `expiresAt − deadLetteredAt` checks the mechanism rather than restating a number.
>
> **The first cut after advertising the facet was NOT CERTIFIED, and the suite was right to refuse it.** 232 passed, 0 failed, and `0188.dead-letter-content-free` recorded `blocked`: that leg read a **fresh** subscription's sink, looped over zero rows and asserted nothing, which RFC 0148 §A resolves to `blocked`. It could never have passed on any host — it went unnoticed only because every host until now recorded `inapplicable` for want of the facet. Fixed in suite **2.25.0** (openwop/openwop#1432); this cut is against that suite.
>
> **`0173.webhook-durable-delivery.dead-letter` is now a clean `executed-pass`.** It had carried a partial-witness note on every bundle ever cut — first "the corpus serves no dead-letter read surface", then "the host does not advertise the facet". The sink half of `webhooks.md` §Durability is witnessed here for the first time by any bundle.

---

> **SUPERSEDED measurement — 2026-09-19, `@openwop/openwop-conformance@2.24.0` + `@openwop/spec-artifacts@2.24.0` (npm, corpus stamp VERIFIED — 277 vendored `api/` + `schemas/` files match their SHA-256 digests), `--target-major 2 --require-behavior --max-workers 1`, build `commit:b3c06d179f49`.**
>
> **RFC 0148 §A dispositions (246 rows, 1977 assertions): executed-pass 231 · executed-fail 0 · blocked 0 · inapplicable 8 · skipped 7.** All three claimed profiles certified. `witnessSha256` **`277906937a14…`**, Ed25519 under key id `v2-reference-3`.
>
> **The previous cut's note — "the corpus serves no dead-letter read surface at all" — stopped being true at suite 2.7.0 and this cut is the proof.** RFC 0188 landed `GET /webhooks/{webhookId}/dead-letters` in `api/v2/openapi.yaml`, and the bundle changes in exactly the three ways that implies:
>
> - `openwop.requirement.0173.webhook-durable-delivery.dead-letter` moves from `partial-witness: blocked: no normative dead-letter read surface…` to `partial-witness: inapplicable: host does not advertise the webhooks.deadLetter facet`. The reason is now an honest host choice instead of a missing contract.
> - Two rows **appear** — `openwop.requirement.0188.dead-letter-read` and `.dead-letter-content-free` — both `inapplicable` for the same honest reason (RFC 0188 §A.5 makes the read a `404` for a host that does not advertise the facet, not an obligation).
> - One row **disappears**: `openwop.it.v2-bound-id-kinds.deliveryid-the-kind-has-no-wire-surface-to-be-bound-on-a-corpus-gap-recorded`. That gap is closed — `deliveryId` now has a wire surface to be bound on.
>
> **A stale bundle misreports the corpus, not just the host.** This host was pinned to `2.4.5` while the corpus reached `2.24.0`, and for nineteen releases its published evidence told every reader that openwop served no dead-letter read. It did, from 2.7.0 on. A bundle is a claim about the tree it ran against; re-read the date before treating one as a debt the corpus owes you.

---

> **SUPERSEDED measurement — 2026-09-18, `@openwop/openwop-conformance@2.4.5` + `@openwop/spec-artifacts@2.4.5`, `--target-major 2 --require-behavior --max-workers 1`, build `commit:5416757dbe69`.**
>
> **RFC 0148 §A dispositions (245 rows, 1997 assertions): executed-pass 231 · executed-fail 0 · blocked 0 · inapplicable 7 · skipped 7.** All three profiles certified. `witnessSha256` **`4d76b664e02e…`**.
>
> **This is the first cut in which `--require-behavior` did anything.** Suite 2.4.5 wired it; before that the CLI never parsed the flag and it fell into a silent default arm, so every earlier bundle from this host named strict mode on its command line and ran NON-strict. The first genuinely strict run returned **7 `executed-fail` rows** — none of them a protocol defect: strict mode requires every capability-gated scenario to find its family advertised **or** find an explicit opt-out, and this host had neither for `family.forms`, `family.memory` and `connections.packsSupported`. It had been soft-skipping all three silently.
>
> **The three opt-outs are now declared** (`OPENWOP_OPTED_OUT_PROFILES`), which is why `skipped` moves 0 → 7. An opt-out is a CLAIM, not a hiding place: each row carries "operator declared an honest opt-out" in the bundle where a reader can see it. `forms` remains the deliberate one — the family obliges field validation and internationalized labels at a form-bearing surface this host does not have.
>
> **10 rows now carry `partial-witness:`.** Suite 2.4.5 propagates that marker to the per-`it` records, which are what RFC 0174 §B.1 rule 4 reads; before, a leg that asserted and then soft-skipped recorded a bare `executed-pass`. The clearest case is `0173.webhook-durable-delivery.dead-letter`, which ends in an unconditional soft-skip on every host because the corpus serves no dead-letter read surface at all.

---

> **SUPERSEDED measurement — 2026-09-18, `@openwop/openwop-conformance@2.4.2` + `@openwop/spec-artifacts@2.4.2` (npm, corpus stamp VERIFIED), `--target-major 2 --require-behavior --max-workers 1`, build `commit:87cb8a007d056b2579ccfab622498fcca427088c`.**
>
> **RFC 0148 §A dispositions (245 rows, 1985 assertions): executed-pass 231 · executed-fail 0 · blocked 0 · inapplicable 14 · skipped 0.** All three claimed profiles certified. `witnessSha256` **`9217e347b85f…`**, Ed25519 under key id `v2-reference-3`.
>
> **`check-cut-gates.mjs --host-bundle` now reports `0 failed, 0 blocked` — RFC 0167 §G.2 passes completely against this bundle for the first time.** The last outstanding id was `openwop.requirement.0173.pack-isolation.seam`, which no host could ever have witnessed: it was minted only inside `v2-pack-isolation`'s shared `invoke()` helper, and `generate-requirement-registry.mjs` harvests `req(…)` within an `it`, so the id never reached `requirements.json` and no bundle could carry a row — while `check-cut-gates.mjs`, which scans every `req(` in the source, went on demanding one. Suite 2.4.2 gave the seam contract its own `it`; this cut carries the row.

---

> **SUPERSEDED measurement — 2026-09-18, `@openwop/openwop-conformance@2.4.1` + `@openwop/spec-artifacts@2.4.1` (npm, corpus stamp VERIFIED), `--target-major 2 --require-behavior --max-workers 1`, build `commit:c6ee97c247ef4d255d67afb61daf615c71e0dfe4`.**
>
> **RFC 0148 §A dispositions (244 rows, 1979 assertions): executed-pass 230 · executed-fail 0 · blocked 0 · inapplicable 14 · skipped 0.** All three claimed profiles certified. `witnessSha256` **`b8a7d1d6941d…`**, Ed25519 under key id `v2-reference-3`.
>
> **What the extra row is.** 2.4.1 adds `v2-chain-pin-exact`'s third leg — an EXTERNAL `subChainRef` carrying `version: "^1.0.0"`. The other two legs are satisfied by schema validation alone (sabotage-proved here: delete this host's §E.1 pin rule and both stay green), because `ids.schema.json`'s `typeId` pattern already refuses the sibling spelling. `SubChainRef.ref` types the external `version` as a semver RANGE, so only the host's own rule can refuse it. `openwop.requirement.0177.chain-pin-exact.external-range-refused` is now **executed-pass in committed evidence** — the row reads host-enforced, not schema-refused.
>
> **A second preflight gap, found the same way as the first.** The initial 2.4.1 cut came back `blocked 4`: `v2-negotiation-decided-emitted` (both legs) and `0175.mrtr-rounds-ceiling.refused`. The host was fine again. The suite starts its A2A peer and MCP server **in-process, opt-in** on `OPENWOP_A2A_FAKE_PEER` / `OPENWOP_MCP_FAKE_SERVER`, and `cut-bundle.sh` set neither — so the host advertised `a2a` and `mcp`, the scenarios found no peer, and four rows recorded `blocked` rather than `inapplicable`. The script now sets both and asserts discovery really advertises the two families before it cuts, so the two halves cannot drift apart silently.

---

> **SUPERSEDED measurement — 2026-09-17, `@openwop/openwop-conformance@2.4.0` + `@openwop/spec-artifacts@2.4.0` (npm, corpus stamp VERIFIED), `--target-major 2 --require-behavior --max-workers 1`, build `commit:f940927928a63dbcf2417760a99befc3c6a0330c` (generated `2026-09-18T03:52:16Z`).**
>
> **RFC 0148 §A dispositions (243 rows, 1971 assertions): executed-pass 229 · executed-fail 0 · blocked 0 · inapplicable 14 · skipped 0.** All three claimed profiles certified — `openwop-discovery-core` (witnessCount 3), `openwop-core-standard` (13), `openwop-conformance-seams-v2` (4).
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`d3241cbf163b…`**, Ed25519 under key id `v2-reference-3`.
>
> **What this cut adds.** Every optional family the host has implemented since the 2.3.2 row is now ADVERTISED and therefore MEASURED, not described: `sandbox` (#50), `saml` + `scim` (#51), `a2a` + `mcp` (#52), `webhooks` per-contract fan-out (#53), `workflowChainPacks` (#54). `inapplicable` falls 44 → 14 and eight of the nine host-tier ids move from *implemented* to *witnessed in committed evidence*. The ninth is `forms`, which stays unadvertised: the family obliges field validation and internationalized labels at a form-bearing surface this host does not have, and advertising it to turn one row green would make the discovery document lie.
>
> **The 14 inapplicable rows** are honest gaps, not skips: `forms` (2 rows) and the `connections` provider-conflict seam (3) are unadvertised families; `0168.coherence-not-in-bundle` is inapplicable in the npm layout; `0170.run-diff-identical` and `memory-attribution-replay-stable` need surfaces this host does not serve; `v2-bound-id-kinds`'s `deliveryId` leg records a CORPUS gap — the kind is bound in `ids.schema.json` but no read surface in the corpus returns one, so no suite can witness it on any host.
>
> **Supplied, not lucky.** `skipped 0` needs `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` naming a change id in `OPENWOP_IMPLEMENTED_CHANGE_IDS` (both `rfc-0176-witness`), plus the `a2a`/`mcp` fake peers and the synthetic SAML IdP running. **Preflight every one of those before certifying:** the first attempt at this cut recorded three `blocked` rows — and one `blocked` row denies certification under RFC 0168 §E.1 — because the synthetic IdP had exited, which is indistinguishable from a broken host in the result. `scripts/cut-bundle.sh` now drives a real SCIM provision and a real SAML assertion and asserts the `link` field is present before it starts the suite.

---

> **SUPERSEDED measurement — 2026-09-17, `@openwop/openwop-conformance@2.3.2` + `@openwop/spec-artifacts@2.3.2` (npm, corpus stamp VERIFIED), `--target-major 2 --require-behavior --max-workers 4`, build `commit:4e164465`.**
>
> **RFC 0148 §A dispositions (239 rows, 1686 assertions): executed-pass 195 · executed-fail 0 · blocked 0 · inapplicable 44 · skipped 0.** All three claimed profiles certified.
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`429fedbc53eb…`**, Ed25519 under the ROTATED key id `v2-reference-3` (`keys/host.pub.pem`; the `-2` private half was never on the cutting machine, same shape as the 09-05 rotation).
>
> **Why this re-cut happened.** The previous row measured `2.1.6`. Cutting on `2.3.1` found two gaps in THIS host that were already binding on main — RFC 0184's `~`-projection (accepted `%2F` only, links spelled `%2F`) and the v2 owner echo + integer `engineVersion` served on the **v1** wire (poll, SSE, snapshot, every webhook subscriber) — and one defect in the SUITE: 2.3.1's `v2-webhook-delivery-shape` read `event.owner` on `run.completed`, a shape no host can emit (openwop #1376, fixed in 2.3.2). The 2.3.2 cut's RETIREMENT lane then found a second suite defect — `v2-bound-id-path-projection` asserted `404` for a double-projected segment where a single-major host MUST answer `400 validation_error` (`identity.md` §5) — fixed in 2.3.3 (openwop #1378), which this row measures. Both host gaps are closed here (openwop-examples #48): the router decodes the projection once, links emit it, a subscription records its contract major and the fan-out renders per contract, `/v1/webhooks` is served.
>
> **`skipped 0` is supplied, not lucky.** `0176.pinned-run-disposition.continued` needs `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID` naming a change id the host lists in `OPENWOP_IMPLEMENTED_CHANGE_IDS`; both were set to `rfc-0176-witness`.
>
> **The 44 inapplicable rows:** optional families this host does not advertise (`a2a`, `mcp`, `saml`, `scim`, packs), each recorded with its reason; `0168.coherence-not-in-bundle` is inapplicable in the npm layout.
>
> **Since this measurement (openwop-examples #54):** the host advertises `workflowChainPacks` and honours what the family obliges, not only what the suite reads — `chains.ts`: every node reference pins an exact version (`core.ai.callPrompt@1.0.0`) and an EXTERNAL sub-chain reference carrying a semver range is refused (the schema types that field as a range, so it is the one pin case a schema cannot catch); sub-chains register under a deterministic child id with a per-parent ownership row carrying the resolved reference, so two parents share one registration and the child outlives the first parent deleted; `{{params.*}}` is substituted at expansion and the expanded definition is asserted free of tokens before it is persisted; depth and cycle are ONE guard bounded by the advertised `subChains.maxDepth` (8). `v2-chain-pin-exact` 2/2. Host pins 2.4.0.
>
> **Since this measurement (openwop-examples #52):** the `a2a` and `mcp` facets are advertised (`a2a` versions `["1.0"]`, floor `1.0`; `mcp` revisions `["2026-07-28"]`, floor the same, `mrtr.maxRounds` 4; `refreshedAt` 2026-09-18) and the §22/§23 invoke seams drive the host's real client path: the Agent Card / `server/discover` read, the decision (floor → unsupported → authenticated), the wire call under the negotiated version, and `negotiation.decided` on a completed audit run under the caller's tenant — the refusal envelope names that run in `details.runId`. All five RFC 0175 scenarios pass (9 tests); two rows record `blocked` on suite gaps, not host ones — the fake MCP server has no `needs_input_loop` tool, and `v2-negotiation-authenticated` reads only a top-level `runId` from what is a closed error envelope — both fixed in the 2.4.0 cut before this bundle is re-cut with the families advertised.
>
> **Since this measurement (openwop-examples #51):** the `saml` and `scim` lanes are advertised with `subjectLinkKey: opaque-idp` (RFC 0163 §A), and the RFC 0050 seams are mounted: the host's genuine ACS validates the suite's assertion format (RSA-SHA256 over the signed canonical element, anti-wrapping, window, alg:none refused), a SCIM connection binds the IdP trust root it is fed by, a link forms only on that root (§B), and deactivation stamps `deniedAt` and fails the SAML decision closed (RFC 0159 §A.3). The synthetic IdP the seams need is `scripts/synthetic-idp.ts` (`GET /metadata`, `GET /assert?variant=&nameId=`), built on the suite's minter. `v2-subject-link-record` 2/2 locally with `OPENWOP_TEST_SAML_IDP_URL` + `OPENWOP_TEST_SCIM_URL` supplied.
>
> **Since this measurement (openwop-examples #50):** the host advertises the `sandbox` family — isolationModel `process`: one `--permission` child per invocation with an empty environment, a heap cap and a wall-clock kill — and mounts the §8 seam (`sample/test/sandbox-{load,invoke}`) with the eleven synthetic packs as real escape attempts. `v2-pack-isolation` (9 legs) passes locally; it was one of the nine host-tier ids no committed bundle witnessed. Next cut moves `inapplicable` 44 → 43 and adds the pack-isolation rows.
>
> **Since this measurement (openwop-examples #49):** the v1 read path now spells an era-3 log's `type` through the inverted codemap row (`persistence.md` §The v1 wire of an era-`3` log — 36 renamed rows, bijection verified at load), on poll, SSE and the fan-out incl. the `OpenWOP-Event-Type` header; a 1.x registration names its types in v1 spelling. The noop fixture emits none of the renamed types, so the bundle totals are unchanged; the route test seeds `run.resuming` and reads it both ways.

---

> **SUPERSEDED measurement — 2026-09-13, `@openwop/openwop-conformance@2.1.6` + `@openwop/spec-artifacts@2.1.6` (npm, corpus stamp VERIFIED), `--target-major 2 --require-behavior --max-workers 4`, **74** scenario files.** Host `openwop-host-v2-reference`, build `commit:0db8e18706214462ee3022ca9fc2b35d05956e3b`.
>
> **RFC 0148 §A dispositions (231 rows, 1606 assertions): executed-pass 187 · executed-fail 0 · blocked 0 · inapplicable 44 · skipped 0.** `claimedProfiles` = `openwop-discovery-core` (witnessCount 3, **certified**), `openwop-core-standard` (witnessCount **13**, **certified**), `openwop-conformance-seams-v2` (witnessCount 4, **certified**).
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`c7ace8376d37...`**, Ed25519 under `v2-reference-2` (`keys/host.pub.pem`). `check-cut-gates.mjs --host-bundle` against the 2.1.5 corpus: **all ten predicate groups PASS, 0 failed 0 blocked, exit 0** (Identity, Registers, Closure, Deprecation, Paths, Codemods, Waiver, Witness, Coexistence, Front door).
>
> **Why this re-cut happened, and it is the point of it.** The previous row measured `2.0.0-rc.61` on 2026-09-05 and stood while the suite moved **sixty-plus releases** — through the `v2.0.0` tag and on to 2.1.5. Nothing was wrong with it: it was accurate for the suite that ran it, which is exactly what `INTEROP-MATRIX.md` asks of a row. But `check-cut-gates`s `suiteVersionCheck` asks a different question — *"did this bundle run everything this corpus now requires of a host at its major"* — and a row that cannot answer that is not a neutral default. The reference host held the stalest row of the three while its steward was telling two production hosts that staleness costs something. This is that advice taken.
>
> **What the re-cut measured that rc.61 could not.** `runList` (RFC 0182, a family that did not exist at rc.61), the single-major branch of `v2-version-header-honored` (2.1.2), the self-describing replay terminal detail (2.1.4), and 74 scenario files against rc.61s 72.
>
> **`skipped 0` is supplied, not lucky.** `0176.pinned-run-disposition.continued` records `skipped` unless the operator names a change id the host implements — *"no normative surface lists the change ids a host implements"* — so this cut sets `OPENWOP_IMPLEMENTED_CHANGE_IDS=v2-reference-change-1` on the host and `OPENWOP_TEST_IMPLEMENTED_CHANGE_ID=v2-reference-change-1` on the runner. **Both are required to reproduce these totals**; without them the same run is `executed-pass 186 · skipped 1` and still certifies all three profiles.
>
> **The 44 inapplicable rows:** optional families this host does not advertise (`a2a`, `mcp`, `saml`, `scim`, packs), each recorded with its reason by `behaviorGate` / `softSkip`, plus the corpus-ledger row.

---

> **SUPERSEDED measurement — 2026-09-05, `@openwop/openwop-conformance@2.0.0-rc.61` + `@openwop/spec-artifacts@2.0.0-rc.61` (npm, corpus stamp VERIFIED), `--target-major 2 --max-workers 4`, **72** scenario files.** Host `openwop-host-v2-reference@2.0.0-rc.1`, build `commit:d029f8fe320eaa68df702f3fa110f782d1f02415`, local boot on port 3839, fresh store, one run; the bundle's `discovery.url` names that port and its `signature.keyId` the rotated key — asserted by the cut script before the artifact is kept (see the superseded measurement below for why). Route-level harness 21 / 21.
>
> **RFC 0148 §A dispositions (223 rows, 1551 assertions): executed-pass 181 · executed-fail 0 · blocked 0 · inapplicable 42 · skipped 0.** `claimedProfiles` = `openwop-discovery-core` (witnessCount 3, **certified**), `openwop-core-standard` (witnessCount **13**, **certified**), `openwop-conformance-seams-v2` (witnessCount 4, **certified**) — every profile it claims, for the third consecutive cut. The two rows added since rc.59 are rc.60's `v2-run-fork-prefix` (the unaided fork-boundary witness: this host is exclusive and passes it) and rc.61's `kind: other` note assertion on the effect-seam manifest (vacuous here — this host declares no `other` row).
>
> **Signed bundle: [`bundle-v3.json`](./bundle-v3.json)** — `witnessSha256` **`180b49fd2f7f…`**, Ed25519 under `v2-reference-2` (`keys/host.pub.pem`). `check-cut-gates.mjs --host-bundle --host-discovery --network` (spec repo at rc.61): every predicate PASS — Identity, Registers, Closure, Deprecation, Paths, Codemods, Waiver, Witness, Coexistence, Front door.
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
