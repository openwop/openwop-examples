# Branch Fork

`POST /runs/{runId}:fork` with `mode: "branch"` on the v2 wire — diverge a run's execution from a chosen sequence, optionally with a `runOptionsOverlay`.

| v2 family required | `replay` (with `branch` in `modes`) |
| Host target        | the v2 reference host, or any v2 host that advertises it |
| Run modes          | default |

## Branch vs replay

`forkRun` accepts `{ mode: replay | branch, fromSeq?, runOptionsOverlay? }` ([`runs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/runs.md) §Fork):

- **`branch`** starts from the projected state at `fromSeq` with the caller's overlay. **Divergent by design**; `fromSeq` is REQUIRED. Effects at or after `fromSeq` re-fire.
- **`replay`** re-executes against current code, consuming the source run's events before `fromSeq` as fixed history, with side effects suppressed ([`replay.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/replay.md)). `fromSeq` defaults to 0 and an overlay is refused.

This example uses branch mode.

## Run

```bash
npm start                                            # the v2 reference host
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=$YOUR_KEY npm start
```

When the host does not advertise `replay`, or `branch` is not in `replay.modes`, the example says so and exits 0.

## Output (a real run against the v2 reference host)

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  ✓ replay advertised; modes: [replay, branch]
→ POST /runs (parent) { workflowId: "conformance-noop" }
  parentRunId: openwop-reference-tenant/wrgj8MoIe5mcr-KUAUXGKxhk
  ✓ parent reached terminal: completed
→ POST /runs/openwop-reference-tenant~2Fwrgj8MoIe5mcr-KUAUXGKxhk:fork { mode: 'branch', fromSeq: 0 }
  forkRunId:   openwop-reference-tenant/b_IItHKR7O06FCa4bwqRxakU
  sourceRunId: openwop-reference-tenant/wrgj8MoIe5mcr-KUAUXGKxhk
  mode:        branch
  eventsUrl:   http://127.0.0.1:3838/runs/openwop-reference-tenant~2Fb_IItHKR7O06FCa4bwqRxakU/events
  ✓ fork reached terminal: completed
→ GET /runs/{fork}/ancestry
  {"runId":"openwop-reference-tenant/b_IItHKR7O06FCa4bwqRxakU","hostId":"openwop.dev/examples/hosts/v2-reference","parent":{"runId":"openwop-reference-tenant/wrgj8MoIe5mcr-KUAUXGKxhk","hostId":"openwop.dev/examples/hosts/v2-reference","cause":"core.subWorkflow"}}

✓ Branch fork lifecycle complete

Note: branch mode permits divergent execution by design.
For deterministic re-execution use mode: 'replay' (spec/v2/core/replay.md).
```

## What this teaches

- **The `201` shape.** `{ runId, sourceRunId, fromSeq?, mode, status, eventsUrl }`; the fork is a new run with its own id, and its `owner` is copied from the parent.
- **Projected ids.** Both the parent and fork ids are tenant-bound; in the `:fork` path the parent travels as one segment (`tenant~2Fopaque`).
- **Ancestry.** `GET /runs/{runId}/ancestry` names the fork's parent.
- **Errors.** A `fromSeq` not in the source log is `422 fork_point_invalid`; an expired retention window is `410` or `422`.

## See also

- [`spec/v2/core/replay.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/replay.md) — modes, determinism, suppression, retention
- [`spec/v2/core/runs.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/runs.md) §Fork
