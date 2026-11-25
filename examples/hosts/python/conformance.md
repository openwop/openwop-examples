# Conformance: Python host (v2)

Measured 2026-11-25 with `@openwop/openwop-conformance@2.49.14` (peer `@openwop/spec-artifacts@2.49.14`) at `--target-major 2`, against a local host on CPython 3.11.4 and a fresh database file, with a second-tenant key set. Two full runs, identical results.

```bash
OPENWOP_TENANT2_API_KEY=openwop-python-tenant-b-key PYTHONPATH=src python3 -m openwop_host
OPENWOP_TEST_TENANT_B_API_KEY=openwop-python-tenant-b-key \
  npx -y @openwop/openwop-conformance@2.49.14 --base-url http://127.0.0.1:3840 \
  --api-key openwop-python-dev-key --target-major 2 --max-workers 2
```

## Result

| | Python host | SQLite host (same suite, for reference) |
|---|---:|---:|
| Scenario files failed / passed (of 234) | 1 / 233 | 2 / 232 |
| Tests failed / passed (of 945) | 1 / 944 | 2 / 943 |
| Requirements executed-pass | 460 | 458 |
| Requirements executed-fail | 2 | 4 |
| Requirements blocked | 0 | 0 |
| Requirements inapplicable | 774 | 774 |

"Passed" in vitest includes soft skips; the RFC 0148 dispositions are the honest count. The inapplicable rows are families this host does not advertise (A2A, MCP, agents, prompts, budget, webhooks and so on). The SQLite column is its recorded run, which predates its pause fix.

The one failure:

- **`v2-effect-seam-manifest`: known, shared with the SQLite host.** A host advertising `replay` must list at least one outbound effect seam in `GET /host/effect-seams`. This host's node runtime reaches none (no HTTP node, no webhook fan-out), so it publishes an empty list and the scenario fails, rather than the host advertising a seam it does not have. The two executed-fail requirement rows are this scenario and its requirement id.

## Not claimed

`openwop-core-standard` requires the `webhooks` family, which this host does not serve, so of the derived profiles it meets `openwop-discovery-core` only; what it serves beyond that is the families its discovery document lists. No certification bundle is published, and no durability rung is claimed: the crash-resume test in `tests/test_host.py` is a regression check, not RFC 0158 evidence.
