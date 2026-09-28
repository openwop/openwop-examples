# Approval Workflow

The full HITL approval-gate lifecycle on the v2 wire: start a workflow that suspends at an approval gate, resolve the interrupt through the run-scoped surface, observe it complete, and read the interrupt pair in the event log.

| v2 family required | `interrupt` |
| Host target        | the v2 reference host, or any v2 host that advertises `interrupt` and seeds an approval workflow |
| Run modes          | default |

## Run

Against the v2 reference host (start it first — see [`examples/hosts/v2-reference/`](../hosts/v2-reference/)):

```bash
npm start
```

Against another v2 host, or with another approval workflow:

```bash
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=$YOUR_KEY npm start
OPENWOP_WORKFLOW_ID=launch-studio-brief-approval npm start
```

When the host does not advertise `interrupt`, or does not list the workflow in discovery `fixtures[]` (or answers `404` for it), the example says so and exits 0.

## Output (a real run against the v2 reference host)

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  ✓ interrupt advertised (status: experimental, tokenAlgs: [hs256])
→ POST /runs { workflowId: "conformance-approval" }
  runId: openwop-reference-tenant/L3MgVf1m4rInOTMWdYAQzNME
→ Polling until waiting-approval...
  ✓ Suspended at node gate
→ POST /runs/openwop-reference-tenant~2FL3MgVf1m4rInOTMWdYAQzNME/interrupts/gate { resumeValue: { action: 'accept' } }
  ✓ accept recorded
→ Polling until terminal...
  status: completed
→ GET /runs/openwop-reference-tenant~2FL3MgVf1m4rInOTMWdYAQzNME/events/poll
  [0] run.started
  [1] node.started node=gate
  [2] interrupt.requested node=gate
  [3] node.suspended node=gate
  [4] interrupt.resolved node=gate
  [5] node.resumed node=gate
  [6] node.completed node=gate
  [7] run.completed
  ✓ resolved action: accept

✓ Approval workflow round-trip complete
```

## What this teaches

- **Family-gated execution.** The example reads the `interrupt` record from the v2 discovery root (`GET /.well-known/openwop` with `OpenWOP-Version: 2`) and does not run against a host without it.
- **Suspended-snapshot semantics.** While suspended, `GET /runs/{runId}` returns `status: "waiting-approval"` and `currentNodeId` names the open gate.
- **One resolve contract.** `POST /runs/{runId}/interrupts/{nodeId}` takes the closed body `{ resumeValue }`; for an approval the resume value is `{ action, decidedAt, feedback? }`, and `action` MUST be one of the gate's `actions`. Of two concurrent resolves exactly one wins; the other gets `409 interrupt_already_resolved`. A signed-token surface (`POST /interrupts/{token}`) serves callers not authenticated to the protocol.
- **One pair of events.** Every interrupt kind is `interrupt.requested` then `interrupt.resolved`; the approval's `action` is recorded on the resolve.
- **Idempotent creates and resolves.** Both carry an `Idempotency-Key`, so a retry never starts a second run or casts a second vote.
- **`decidedBy` is host-derived.** An authenticated caller MAY omit it; the host takes it from the caller's Subject.

## Workflow requirement

The default `OPENWOP_WORKFLOW_ID` is `conformance-approval`, the conformance fixture the v2 reference host seeds. Any workflow with the same shape works (suspends at one gate, completes after one `accept`).

## See also

- [`spec/v2/core/interrupt.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interrupt.md) — payload, events, resolve surfaces, tokens, approval, rejection
- [`spec/v2/core/idempotency.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/idempotency.md) — `Idempotency-Key`
- [`SECURITY/threat-model-prompt-injection.md`](https://github.com/openwop/openwop/blob/main/SECURITY/threat-model-prompt-injection.md) — the `decidedBy` invariants
