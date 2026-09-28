# Branching Workflow

Demonstrates the openwop DAG executor: a single workflow with **two parallel paths** that fan out from one source, run concurrently, then fan back in at a merge node. Fan-out is plain edges from `source`; fan-in is `core.flow.merge`.

This is the canonical "branching is real" demo: a host whose executor is linear either refuses the workflow or runs the branches serially, and the example's interleaving check fails.

| v2 family required | none — an installed `branching-demo` workflow and a DAG executor that runs branches concurrently |
| Host target        | a v2 host with [`workflow.json`](./workflow.json) installed |
| Run modes          | default |

## What the workflow does

```
         ┌─────────────┐
         │   source    │ (passthrough, emits the run's inputs)
         └──────┬──────┘
                │
       ┌────────┴────────┐
       │                 │
       ▼                 ▼
┌─────────────┐   ┌─────────────┐
│  branchA    │   │  branchB    │  ← parallel paths
│ (uppercase) │   │ (mock-ai)   │
└──────┬──────┘   └──────┬──────┘
       │                 │
       └────────┬────────┘
                │
                ▼
         ┌─────────────┐
         │    merge    │ (mode: combine-by-position)
         └──────┬──────┘
                │
                ▼
         ┌─────────────┐
         │    sink     │ (passthrough)
         └─────────────┘
```

- **`source`** receives the run inputs. `{ message: "hello" }`.
- **`branchA`** uppercases the message → `{ message: "HELLO" }`.
- **`branchB`** runs a mock-AI completion → `{ completion: "Mock response to: hello" }`.
- **`merge`** combines both branch outputs by position into a single record.
- **`sink`** terminates the workflow with the merged payload.

The two branches MUST run concurrently — the run completes when both upstream paths finish AND the merge's default `triggerRule: 'all_success'` fires the sink.

## Run

```bash
npm start                                   # defaults to the v2 reference host
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=$YOUR_KEY npm start
```

v2 defines no workflow-registration operation, so the example does not register anything: it reads `GET /workflows/branching-demo` and, when the host does not have it, says so and exits 0. Install [`workflow.json`](./workflow.json) through the host's own tooling first. Its node types (`local.sample.demo.uppercase`, `local.sample.demo.mock-ai`, `core.flow.merge`) must be ones the host executes.

The v2 reference host does not have it (its catalog is the conformance fixtures, and its executor runs nodes one at a time). A real run there:

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  ✓ Host reachable (OpenWOP-Version 2.0, openwop-host-v2-reference)
→ GET /workflows/branching-demo
⊘ Workflow "branching-demo" is not installed on this host.
  v2 defines no workflow-registration operation; install workflow.json through the
  host's own tooling, then re-run. Its node types (local.sample.demo.*, core.flow.merge)
  must be ones the host executes, and the executor must run DAG branches concurrently.
```

On a host that has it, the example starts the run, polls it to `completed`, reads `GET /runs/{runId}/events/poll`, and asserts the interleaving below:

```
    seq= 0  started                 (run.started)
    seq= 1  started       source
    seq= 2  completed     source
    seq= 3  started       branchA      ┐
    seq= 4  started       branchB      │ interleaved — parallel paths
    seq= 5  completed     branchA      │
    seq= 6  completed     branchB      ┘
    ...
  ✓ Both branches emitted node.started before either emitted node.completed
```

(That listing is the assertion's shape, not a captured run: no v2 example host executes this workflow yet.)

## How to know it really branched

The `node.started` events for `branchA` and `branchB` both appear in the log **before** either branch's `node.completed`. Under a linear executor (or a host that serialized the DAG into a chain), one branch would always complete before the other started:

```
linear:        started_A → completed_A → started_B → completed_B   ❌
concurrent:    started_A → started_B → completed_A → completed_B   ✓
```

The example asserts this interleaving and exits non-zero if it doesn't hold.

## What this exercises

- Edge fan-out: two edges from one source schedule both targets once the source completes.
- `core.flow.merge` fan-in with `mode: 'combine-by-position'` (zip branchA's output with branchB's).
- The DAG scheduler's bounded concurrency — a host that caps node concurrency at 1 serializes the branches and fails the assertion.
- The canonical `WorkflowEdge.triggerRule` default (`all_success`) waits for both upstreams before firing the merge.

## See also

- [`schemas/v2/workflow-definition.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/workflow-definition.schema.json) §`WorkflowEdge` — the edge shape and the `triggerRule` enum
- [`spec/v2/core/events.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/events.md) — the event log and `events/poll`
- [`examples/multi-agent-research-assistant/`](../multi-agent-research-assistant/) — a multi-agent DAG composition
