# MCP Tool

An OpenWOP v2 host seen through its MCP server mount: list its workflows as MCP tools, call one, and observe the run that call started on the OpenWOP wire.

| v2 family required | `mcp` (a server mount in `mcp.serverUrls[]`) |
| Host target        | the v2 reference host, or any v2 host that advertises an MCP server mount |
| Run modes          | default |

## How OpenWOP and MCP compose

The `mcp` family ([`interop.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md)) says which way a host composes:

- **Server** — `profiles[]` (e.g. `mcp-2026-07-28`) and `serverUrls[]`: the host's workflows are MCP tools an MCP client calls; `tools/call` starts a run.
- **Client** — `client: true`: pack code reaches MCP servers through `ctx.mcp`.

The operation mappings are the `mcp.*` rows of [`spec/v2/interop-map.json`](https://github.com/openwop/openwop/blob/main/spec/v2/interop-map.json). The mount is stateless at revision `2026-07-28`: no `initialize`, no session id; every request carries its revision in the `MCP-Protocol-Version` header and in `_meta["io.modelcontextprotocol/protocolVersion"]`, and the two MUST agree.

## Run

```bash
npm start                                   # the v2 reference host
OPENWOP_MCP_TOOL=conformance-delay npm start   # call another tool
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=$YOUR_KEY npm start
```

When the host does not advertise `mcp`, or advertises no server mount, the example says so and exits 0.

## Output (a real run against the v2 reference host)

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  Host: openwop-host-v2-reference
  ✓ mcp advertised (status: experimental)
    profiles:   [mcp-2026-07-28]
    revisions:  [2026-07-28]
    serverUrls: [http://127.0.0.1:3838/mcp]
    client:     not advertised
→ tools/list  (http://127.0.0.1:3838/mcp, MCP-Protocol-Version: 2026-07-28)
  17 tool(s): conformance-approval, conformance-approval-approvers, conformance-artifact-emit, conformance-cancellable, conformance-clarification, conformance-clarification-nested, …
→ tools/call { name: "conformance-noop" }
  isError: false
  runId:   openwop-reference-tenant/Gi_OdFMlKwPow81mLBCXbQ9W
  status:  completed
→ GET /runs/openwop-reference-tenant~2FGi_OdFMlKwPow81mLBCXbQ9W/events/poll  (the same run, over REST)
  [0] run.started
  [1] node.started node=noop
  [2] node.completed node=noop
  [3] run.completed
  run.started transport: mcp

✓ MCP tools/list + tools/call round-trip observed on the OpenWOP wire
```

## What this teaches

- **Discovery first.** The mount URL and revision come from the `mcp` record, not from a guessed path.
- **One run, two views.** `tools/call` returns a `CallToolResult`; the run it started is an ordinary OpenWOP run, readable over REST, and `run.started` records `transport: mcp`.
- **Tool output is untrusted.** The result is pack- and workflow-authored content; the example parses it only to find the runId.
- **Suspending tools.** A tool whose run suspends on an approval or clarification answers `InputRequiredResult` (multi-round tool results) instead; try `OPENWOP_MCP_TOOL=conformance-approval` to see the non-completed path fail the example.

## See also

- [`spec/v2/core/interop.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/interop.md) — MCP and A2A interop, MCP tasks and cancellation, the round ceiling
- [`examples/mcp-stdio-bridge/`](../mcp-stdio-bridge/) — an HTTP-to-stdio shim for stdio MCP servers
