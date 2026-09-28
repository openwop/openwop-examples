# streaming-client

Consume a run's OpenWOP v2 event stream over SSE: create a run, connect to its stream, print each event until the terminal one.

## Run

Against the v2 reference host (start it in another terminal first — see `examples/hosts/v2-reference/`):

```bash
npm start
```

Sample output:

```
→ POST /runs { workflowId: "conformance-noop" }
  runId: openwop-reference-tenant/Zt8B4tXEcuST8as0BS46MFLM
→ Streaming /runs/openwop-reference-tenant~2FZt8B4tXEcuST8as0BS46MFLM/events
  [0] run.started
  [1] node.started node=noop
  [2] node.completed node=noop
  [3] run.completed
✓ Stream ended with run.completed after 4 events
```

Against any other v2 host:

```bash
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=your-key npm start
```

Stream a different workflow:

```bash
OPENWOP_WORKFLOW=conformance-cancellable npm start
```

## What it shows

- Every request carries `OpenWOP-Version: 2` (`spec/v2/core/versioning.md` §1.3).
- The host replays the backlog on connect and closes the stream after the terminal event (`run.completed`, `run.failed` or `run.cancelled`), so no polling loop is needed (`spec/v2/core/events.md` §SSE frames).
- Each frame's `id:` is the event's sequence. Reconnecting with `Last-Event-ID: <id>` resumes after that event and never repeats it.
- A client that sees the stream close without a terminal event should treat the run as still in progress and reconnect.

## One file, zero dependencies

Node's `fetch` and a small hand-written SSE parser. Production clients use an SSE library, but the protocol is small enough that a one-file client is correct. For automatic reconnection with `Last-Event-ID`, use the TypeScript SDK (`@openwop/openwop@2`, `client.runs.events`).
