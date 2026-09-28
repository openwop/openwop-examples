# Cross-host parent-child workflow sample

An OpenWOP parent hands a child task to an **A2A 1.0 peer** on another host and projects the peer's task state back onto the parent's `run.status`. The peer is real: a v2 host's A2A interface (the v2 reference host serves one — `a2a.profiles: [a2a-1.0]`, an Agent Card at `a2a.agentCardUrl`, one JSONRPC interface).

Companion to [`examples/multi-agent-research-assistant/`](../multi-agent-research-assistant/README.md) (in-host multi-agent composition). This sample covers the **other** boundary — when the worker lives on a different host reachable over [A2A](https://a2a-protocol.org/).

| v2 family required | `a2a` on the peer (profile `a2a-1.0`, `agentCardUrl`) |
| Host target        | the v2 reference host as the peer, or any v2 host serving an A2A 1.0 interface |
| Run modes          | default |

## What it does

[`bridge.mjs`](./bridge.mjs) plays the parent host's bridge node:

1. `GET /.well-known/openwop` with `OpenWOP-Version: 2` → `a2a.agentCardUrl`; `GET` the card → the JSONRPC interface at `protocolVersion` 1.0.
2. `SendMessage` → the peer starts a run of its one skill (on the reference host, `conformance-approval`), whose approval gate suspends the task: `TASK_STATE_INPUT_REQUIRED`.
3. A second `SendMessage` on the task (`taskId`, `contextId`) with a `data` part `{ action, decidedAt }` resolves the gate through the peer's REST resolve path:
   - `accept` → `TASK_STATE_COMPLETED` → `run.status` `completed`
   - `reject` → `TASK_STATE_FAILED` → `run.status` `failed`
4. `SendMessage` then `CancelTask` → `TASK_STATE_CANCELED` → `run.status` `cancelled`.
5. The projection rows a live peer does not reach on demand (`auth-required`, `rejected`, an unknown state) and the projection's determinism, checked as a pure function.

`message.messageId` is the peer's idempotency seed (a repeat answers the task it already reached), so the bridge derives it from `(parentRunId, "delegate", step)`; the sample resends one reply and asserts the same task comes back.

## Run

```bash
npm start                                   # the v2 reference host as the peer
OPENWOP_BASE_URL=https://peer-host.example OPENWOP_API_KEY=$PEER_KEY npm start
```

When the peer does not advertise an A2A 1.0 interface, the sample says so and exits 0.

## Output (a real run against the v2 reference host)

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  peer: openwop-host-v2-reference — skill conformance-approval at http://127.0.0.1:3838/a2a/jsonrpc
ok multi-agent-cross-host — A2A 1.0 peer state projected onto run.status end-to-end
  accept:         TASK_STATE_INPUT_REQUIRED → TASK_STATE_COMPLETED ⇒ OpenWOP=completed
  reject:         TASK_STATE_INPUT_REQUIRED → TASK_STATE_FAILED ⇒ OpenWOP=failed
  cancel:         TASK_STATE_INPUT_REQUIRED → TASK_STATE_CANCELED ⇒ OpenWOP=cancelled
  AUTH_REQUIRED:  ⇒ OpenWOP=waiting-input (reason=auth_required_by_remote)  [pure]
  REJECTED:       ⇒ OpenWOP=failed (reason=rejected_by_remote)  [pure]
  idempotent:     a repeated messageId answered the same task
```

## The projection

`projectA2AStateToOpenWop(wireState)` is the reverse projection (consuming an external A2A agent). It accepts both spellings: A2A 1.0 renders the state as `TASK_STATE_*`; the stored vocabulary ([`schemas/v2/a2a-task-state.schema.json`](https://github.com/openwop/openwop/blob/main/schemas/v2/a2a-task-state.schema.json)) is lowercase-hyphen, and the two are a bijection.

| A2A state | Parent `run.status` | Reason code |
|---|---|---|
| `submitted`, `working` | `running` | — |
| `input-required` | `waiting-input` (a bridge that reads the status message MAY choose `waiting-approval`) | — |
| `auth-required` | `waiting-input` | `auth_required_by_remote` |
| `completed` | `completed` | — |
| `failed` | `failed` | — |
| `canceled` (1 `l`) | `cancelled` (2 `l`) | — |
| `rejected` | `failed` | `rejected_by_remote` |
| anything else | `failed` | `unknown_remote_state` |

## What this is NOT

A production bridge also needs:

- **Timeouts and backoff** — the settle loop polls `GetTask` at a fixed 100 ms for at most 4 s.
- **The peer's auth scheme** — the sample sends the peer's own API key as a Bearer; a real bridge authenticates as the parent host's outbound identity per the card's `securitySchemes`.
- **Trace propagation** — carry the parent run's trace context on the message ([`interop.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md) §"Trace context").
- **Push or streaming** — the reference host advertises neither `streaming` nor `pushNotifications` by default, so the sample polls.

## See also

- [`spec/v2/core/interop.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md) — A2A and MCP interop: negotiation, the operation mappings, multi-turn, error details, per-agent cards
- [`spec/v2/interop-map.json`](https://github.com/openwop/openwop/blob/main/spec/v2/interop-map.json) — the `a2a.*` operation, state and error rows
- [`examples/multi-agent-research-assistant/README.md`](../multi-agent-research-assistant/README.md) — in-host multi-agent composition
