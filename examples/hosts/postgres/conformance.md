# Conformance: Postgres host (v2)

Measured 2026-11-25 with `@openwop/openwop-conformance@2.49.15` (peer `@openwop/spec-artifacts@2.49.15`) at `--target-major 2`, against a local host on PGlite in memory, with a second-tenant key set (`OPENWOP_TENANT2_API_KEY` on the host, `OPENWOP_TEST_TENANT_B_API_KEY` for the suite). Two full runs, identical results.

```bash
OPENWOP_TENANT2_API_KEY=openwop-postgres-tenant-b-key npm run start:pglite
OPENWOP_TEST_TENANT_B_API_KEY=openwop-postgres-tenant-b-key \
  npx openwop-conformance --base-url http://127.0.0.1:3841 --api-key openwop-postgres-dev-key --target-major 2 --max-workers 2
```

## Result

| | v2 host |
|---:|---:|
| Scenario files failed / passed (of 239) | 1 / 238 |
| Tests failed / passed (of 957) | 1 / 956 |
| Requirements executed-pass | 480 |
| Requirements executed-fail | 2 |
| Requirements blocked | 0 |
| Requirements inapplicable | 771 |

"Passed" in vitest includes soft skips; the RFC 0148 dispositions are the honest count. The inapplicable rows are families the host does not advertise (A2A, MCP, agents, budget, webhooks and so on). Against the SQLite host's 2.49.14 measurement, the difference is the `auditLogIntegrity` family: `audit-log-integrity`, `audit-checkpoint-signature`, `audit-checkpoint-vectors` and `audit-anomaly-shape` all execute and pass.

The one failing file, both runs:

- **`v2-effect-seam-manifest`: known.** A host advertising `replay` must list at least one outbound effect seam in `GET /host/effect-seams`. This host's node runtime reaches none yet (no HTTP node, no webhook fan-out), so it publishes an empty list rather than a seam it does not have. Its two requirements are the two executed-fail rows.

The five v2 samples that need only the core floor (`tiny-workflow`, `streaming-client`, `idempotent-runs`, `approval-workflow`, `branch-fork`) pass against the same host.

The multi-process properties are not black-box testable on PGlite (one connection, one process); `test/durability.test.ts` covers them against a real Postgres, and `examples.yml` runs it with a Postgres service.

## Not claimed

`openwop-core-standard` requires the `webhooks` family, which this host does not serve yet, so of the derived profiles it meets `openwop-discovery-core` only. No certification bundle is published for it; the v1 bundle and `conformance-full.md` that used to sit here were v1 evidence and substantiate nothing at major 2.
