# Multi-Agent Research Assistant — Reference Composition

> MA-1 from `plans/openwop-protocol-gap-closure-plan.md` Workstream 6. End-to-end reference walkthrough of the OpenWOP multi-agent surface: how `core.orchestrator.supervisor` + `core.dispatch` + `AgentRef` + reasoning events + HITL approval + memory compose into one workflow.

This example is **documentation-first** — it doesn't ship a runnable host; it composes existing reference fixtures (`conformance/fixtures/conformance-orchestrator-*.json` + `conformance-agent-*.json`) into a single narrative an adopter can read end-to-end. The runnable bits live in the conformance suite + the Postgres reference host.

Event names below are the v2 names (`spec/v2/event-codemap.json`). No v2 example host advertises the multi-agent families yet: the v2 reference host (`examples/hosts/v2-reference`) does not serve `core.orchestrator.supervisor` or `core.dispatch`, and the Postgres reference host ([`examples/hosts/postgres/`](../hosts/postgres/)), which implements every shape this composition exercises, serves v1 through the overlap (its paths are `/v1/…` and its events carry the v1 names).

---

## The shape

A research-assistant workflow is the canonical multi-agent worked example. A user submits a query; an orchestrator agent decides how to route it across one or more worker agents; workers reason + call tools; the orchestrator gates the final answer through HITL approval before completing.

```
              ┌──────────────────────────┐
              │ run.started              │
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ core.orchestrator        │
              │   .supervisor            │   AgentRef:
              │ (RFC 0006)               │   { agentId: "core.research.supervisor",
              │                          │     modelClass: "reasoning" }
              │ Emits:                   │
              │   orchestrator.decided   │
              │                          │
              │     { kind: "next-worker"│
              │       nextWorkerIds: ["worker-research"] }
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ core.dispatch            │
              │ (RFC 0007)               │
              │                          │   Routes to the named worker
              │ Emits:                   │   workflow ID; child run inherits
              │   node.started for       │   parent's trace context
              │     child run            │
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ Worker workflow          │   AgentRef:
              │   (conformance-noop or   │   { agentId: "vendor.example.research-worker",
              │    custom)               │     modelClass: "tool-using",
              │                          │     memoryRef: "mem_<tenant>_<agent>_longTerm" }
              │ Emits:                   │
              │   agent.reasoned         │   ← verbosity-gated per
              │   agent.tool-called      │     RunOptions.configurable
              │   agent.tool-returned    │     .ai.reasoningVerbosity
              │   agent.decided          │
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ core.approvalGate        │
              │                          │
              │ Emits:                   │
              │   interrupt.requested    │
              │ Suspends:                │
              │   waiting-approval       │
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ (HITL resolution via     │
              │  POST /interrupts/{token}│
              │  or POST /runs/{runId}/  │
              │  interrupts/{nodeId})    │
              │                          │
              │ Emits:                   │
              │   interrupt.resolved     │
              └──────────┬───────────────┘
                         ▼
              ┌──────────────────────────┐
              │ run.completed            │
              └──────────────────────────┘
```

Every event in the boxes above is a registered v2 type ([`events.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/events.md), names from [`event-codemap.json`](https://github.com/openwop/openwop/blob/main/spec/v2/event-codemap.json)); a host emitting `interrupt.requested` SHOULD also emit the kind-specific `approval.requested` ([`interrupt.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interrupt.md) §Events). Every `AgentRef` shape is normative per [`schemas/v2/agent-ref.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/agent-ref.schema.json) + RFC 0002.

---

## Reference fixtures this composition uses

| Fixture | Role | Spec doc / RFC |
|---|---|---|
| [`conformance-orchestrator-dispatch`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-orchestrator-dispatch.json) | Orchestrator + dispatch topology with mock supervisor decisions | RFC 0006 + RFC 0007 |
| [`conformance-orchestrator-low-confidence`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-orchestrator-low-confidence.json) | CP-1 escalation contract — low-confidence supervisor decision suspends with `reason: 'low-confidence'` | RFC 0006 §"Confidence escalation" |
| [`conformance-dispatch-loop`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-dispatch-loop.json) | Multi-tick dispatch loop (supervisor → worker → supervisor → terminate) | RFC 0007 §C |
| [`conformance-agent-reasoning`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-agent-reasoning.json) | Worker emits `agent.reasoned` + `agent.toolCalled` + `agent.handoff` + `agent.decided` | RFC 0002 + `capabilities.md` §`agents.reasoning` |
| [`conformance-agent-memory-roundtrip`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-agent-memory-roundtrip.json) | MemoryAdapter read-side via `list` / `get` with `AgentRef.memoryRef` | RFC 0004 §A |
| [`conformance-agent-memory-redaction`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-agent-memory-redaction.json) | SR-1 invariant — BYOK plaintext NEVER lands on memory entries | RFC 0004 §D + SR-1 |
| [`conformance-approval`](https://github.com/openwop/openwop/blob/main/conformance/fixtures/conformance-approval.json) | HITL approval gate with signed-token callback | `interrupt.md` + `interrupt-profiles.md` |

Each fixture is independently runnable against any host that advertises the relevant capability — see [`docs/PROFILE-DECISION-GUIDE.md`](https://github.com/openwop/openwop/blob/main/docs/PROFILE-DECISION-GUIDE.md) for which fixtures gate on which `capabilities.*` advertisements.

---

## End-to-end run (v2 wire)

Against a v2 host that advertises the `agents`, `memory` and `multiAgent` families and seeds the `conformance-orchestrator-dispatch` fixture (every request carries `OpenWOP-Version: 2`):

```bash
# 1. Discovery: the v2 root carries one record per advertised family.
curl -s https://your-host/.well-known/openwop -H 'OpenWOP-Version: 2' \
  | jq '{agents, memory, multiAgent, fixtures}'

# 2. Create a run (an Idempotency-Key makes a retry return the same run).
curl -s -X POST https://your-host/runs \
  -H 'OpenWOP-Version: 2' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: research-$(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"conformance-orchestrator-dispatch","configurable":{"version":1,"ai":{"reasoningVerbosity":"summary"}}}'

# 3. Stream events. The runId is tenant-bound (`tenant/opaque`); in a path it
#    travels as one projected segment, `/` → `~2F` (identity.md §5).
curl -N "https://your-host/runs/${RUN_ID//\//~2F}/events?streamMode=updates" \
  -H 'OpenWOP-Version: 2' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: text/event-stream'
```

The event stream will carry, in order:

1. `run.started`
2. `node.started` (supervisor)
3. `orchestrator.decided` — typed `{kind: 'next-worker', nextWorkerIds: [...]}`
4. `agent.reasoned` (verbosity-gated; redacted per RFC 0012 §D if compaction is active)
5. `node.started` (dispatch)
6. `node.started` (child run worker)
7. `agent.tool-called` + `agent.tool-returned` (paired via shared `callId`; MCP-1 + SR-1 redacted)
8. `agent.decided` (with `confidence ∈ [0, 1]`)
9. `orchestrator.decided` — typed `{kind: 'terminate', reason: '...'}`
10. `node.completed` (dispatch)
11. `node.completed` (supervisor)
12. `run.completed`

For a HITL-gated variant, replace `conformance-orchestrator-dispatch` with a fixture that chains a `core.approvalGate` after the dispatch — the run pauses with `waiting-approval` until `POST /runs/{runId}/interrupts/{nodeId}` (or the signed-token `POST /interrupts/{token}`) resolves it with `{ "resumeValue": { "action": "accept" } }`. [`examples/approval-workflow/`](../approval-workflow/) runs that resolve live against the v2 reference host.

The Postgres reference host serves this same flow on v1 through the overlap: `POST /v1/runs`, `GET /v1/runs/{runId}/events`, no `OpenWOP-Version` header, v1 event names (`runOrchestrator.decided`, `agent.toolCalled`).

---

## What this composition does NOT do

- **Define agent reasoning internals.** How an agent decides what tool to call, what the prompt looks like, what model serves the call — all host / pack territory. The protocol only normates the events emitted.
- **Specify agent-to-agent transport.** Multi-agent inside one OpenWOP run uses `core.dispatch` (in-host). Cross-host agent messaging composes with [A2A](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md) — distinct surface.
- **Mandate memory backends.** The MemoryAdapter contract is wire-level; implementations choose Postgres / Redis / vector DB / etc.
- **Define a planning algorithm.** RFC 0006 supports `single` / `delegate` / `delegate.smart` patterns; hosts choose. The protocol normates the decision-event shape, not the algorithm that produces it.

---

## Cross-host composition (A2A bridge)

When a worker is an external A2A peer rather than an in-host workflow:

1. The orchestrator's `orchestrator.decided` emits `kind: 'next-worker'` with the external worker's `AgentRef` referencing an A2A AgentCard.
2. `core.dispatch` routes to an A2A bridge node (host-implementation; not normated) that issues an A2A 1.0 `SendMessage`.
3. The bridge node maps A2A `Task.status.state` back to OpenWOP run state (the state vocabulary is [`schemas/v2/a2a-task-state.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/a2a-task-state.schema.json); A2A 1.0 renders it `TASK_STATE_*`).
4. On the A2A peer's `completed` state, the bridge resumes the local run with the A2A `Task.result`.

The protocol-level boundaries — `AgentRef`, the runOrchestrator decision envelope, the dispatch contract — stay identical regardless of whether the worker is local or remote. The A2A bridge is the only host-implementation surface that differs.

See [`spec/v2/core/interop.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md) §"The operation mappings" and [`spec/v2/interop-map.json`](https://github.com/openwop/openwop/blob/main/spec/v2/interop-map.json) for the operation, state and error mappings.

→ Runnable form at [`examples/multi-agent-cross-host/`](../multi-agent-cross-host/README.md). That example drives a real v2 host's A2A 1.0 interface as the peer (the v2 reference host serves one), walks accept / reject / cancel end-to-end, checks the remaining projection rows as a pure function, and exports the projection future hosts can adopt.

---

## Memory compaction (RFC 0012)

When the host advertises `capabilities.memory.compaction.supported: true` (Postgres reference host with `OPENWOP_MEMORY_COMPACTION=true`):

- The orchestrator's `agentRef.memoryRef` points at a long-lived memory scope.
- Host-managed background compaction periodically distills old MemoryEntry rows into newer ones.
- Each compaction emits a canonical `memory.compacted` event per `run-event-payloads.schema.json` §`memoryCompacted`.
- SR-1 carry-forward (RFC 0012 §D) MUST be enforced — derived content passes the BYOK redaction harness.

This is independent of the dispatch loop above; compaction runs on the host schedule. The conformance suite's 3 RFC 0012 scenarios ([`memory-compaction-event-emitted`](https://github.com/openwop/openwop/blob/main/conformance/src/scenarios/memory-compaction-event-emitted.test.ts) + [`memory-compaction-sr1-carry-forward`](https://github.com/openwop/openwop/blob/main/conformance/src/scenarios/memory-compaction-sr1-carry-forward.test.ts) + [`memory-compaction-provenance-tag`](https://github.com/openwop/openwop/blob/main/conformance/src/scenarios/memory-compaction-provenance-tag.test.ts)) verify the surface end-to-end against the Postgres reference.

---

## See also

- [`spec/v2/core/identity.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/identity.md) — Subjects and tenant-bound identifiers, including the `~2F` path projection.
- [`RFCS/0002-agent-identity-and-reasoning-events.md`](https://github.com/openwop/openwop/blob/main/RFCS/0002-agent-identity-and-reasoning-events.md) — canonical `AgentRef` + agent-event vocabulary.
- [`RFCS/0004-memory-layer.md`](https://github.com/openwop/openwop/blob/main/RFCS/0004-memory-layer.md) — MemoryAdapter + SR-1 secret-redaction invariant.
- [`RFCS/0006-orchestrator.md`](https://github.com/openwop/openwop/blob/main/RFCS/0006-orchestrator.md) — orchestrator decision shape + CP-1 escalation.
- [`RFCS/0007-dispatch.md`](https://github.com/openwop/openwop/blob/main/RFCS/0007-dispatch.md) — `core.dispatch` contract.
- [`RFCS/0012-memory-compaction-profile.md`](https://github.com/openwop/openwop/blob/main/RFCS/0012-memory-compaction-profile.md) — memory compaction + SR-1 carry-forward.
- [`spec/v2/core/events.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/events.md) + [`spec/v2/event-codemap.json`](https://github.com/openwop/openwop/blob/main/spec/v2/event-codemap.json) — the v2 event vocabulary and its v1 spellings.
- [`docs/PROFILE-DECISION-GUIDE.md`](https://github.com/openwop/openwop/blob/main/docs/PROFILE-DECISION-GUIDE.md) — which `capabilities.*` advertisements gate which scenarios.
- [`examples/hosts/postgres/README.md`](../hosts/postgres/README.md) — runnable reference host that advertises every capability this composition exercises (v1 through the overlap).
