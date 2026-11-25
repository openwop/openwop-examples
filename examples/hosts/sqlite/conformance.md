# Conformance: SQLite host (v2)

Measured 2026-11-25 with `@openwop/openwop-conformance@2.49.14` (peer `@openwop/spec-artifacts@2.49.14`) at `--target-major 2`, against a local host on a fresh database, with a second-tenant key set (`OPENWOP_TENANT2_API_KEY` on the host, `OPENWOP_TEST_TENANT_B_API_KEY` for the suite).

```bash
OPENWOP_TENANT2_API_KEY=openwop-sqlite-tenant-b-key npm start
OPENWOP_TEST_TENANT_B_API_KEY=openwop-sqlite-tenant-b-key \
  npx openwop-conformance --base-url http://127.0.0.1:3839 --api-key openwop-sqlite-dev-key --target-major 2 --max-workers 2
```

## Result

| | v1 host (before the port) | v2 host |
|---|---:|---:|
| Scenario files failed / passed | 27 / 207 | 2 / 232 |
| Tests failed / passed (of 945) | 39 / 906 | 2 / 943 |
| Requirements executed-pass | 324 | 458 |
| Requirements executed-fail | 69 | 4 |
| Requirements blocked | 103 | 0 |
| Requirements inapplicable | 748 | 774 |

"Passed" in vitest includes soft skips; the RFC 0148 dispositions are the honest count. Most of the v2 host's inapplicable rows are families it does not advertise (A2A, MCP, agents, prompts, budget, webhooks and so on).

Of the two failures in the full run:

- **`v2-run-pause-resume`: fixed.** An `immediate` pause on an executing run was recorded by the executor on its next poll, so a second pause sent at once still saw `running` and got `202`. The pause is now recorded by the request itself; a filtered rerun of the scenario passes.
- **`v2-effect-seam-manifest`: known.** A host advertising `replay` must list at least one outbound effect seam in `GET /host/effect-seams`. This host's node runtime reaches none yet (it has no HTTP node and no webhook fan-out), so it publishes an empty list. The first seam arrives with webhooks; until then the scenario fails rather than the host advertising a seam it does not have.

## Before the port

The v1 host answered the v2 suite mostly with 404s on unversioned paths and a v1 discovery document. Its failing scenario families: webhooks (5 files), version negotiation and the discovery root (`preferred-version-default`, `version-header-honored`, `header-scheme`, `discovery-etag`, `capabilities-root-closed`, `capability-record-shape`, `profiles-derived-only`, `advertised-fixtures-exist`, `no-transport-advertisement`, `envelope-surfaces-absent`), sub-workflows and dispatch (4), run options and limits (2), model capabilities (2), and one each for the malformed-body envelope, the era key, bound-id kinds and eval mode.

## Not claimed

`openwop-core-standard` requires the `webhooks` family, which this host does not serve yet, so of the derived profiles it meets `openwop-discovery-core` only; what it serves beyond that is the families its discovery document lists. No certification bundle is published for it; the v1 bundle that used to sit here was v1 evidence and substantiates nothing at major 2 (`persistence.md` §Everything else a v1 host persisted).
