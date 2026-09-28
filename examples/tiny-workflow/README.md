# tiny-workflow

The smallest possible OpenWOP v2 run lifecycle: discover the host, start a run, poll it until it ends.

## Run

Against the v2 reference host (start it in another terminal first — see `examples/hosts/v2-reference/`):

```bash
npm start
```

Sample output:

```
→ Discovery: http://127.0.0.1:3838/.well-known/openwop (OpenWOP-Version: 2)
  served as:         OpenWOP-Version 2.0
  protocolVersions:  1.11, 2.0
  implementation:   openwop-host-v2-reference
→ POST /runs { workflowId: "conformance-noop" }
  runId:  openwop-reference-tenant/xvp5OfaiTM7qfOfYcDktgA4k
  status: pending
→ Polling until terminal...
  status: completed
✓ Run completed successfully
```

Against any other v2 host:

```bash
OPENWOP_BASE_URL=https://your-host.example OPENWOP_API_KEY=your-key npm start
```

## What it shows

- Every request carries `OpenWOP-Version: 2`. Through the v1 overlap, a discovery request without it is answered as v1 (`spec/v2/core/versioning.md` §1.3).
- Run creation is `POST /runs` with `{ workflowId }` and an `Idempotency-Key`, so a retry returns the same run.
- Run ids are tenant-bound (`tenant/opaque`). In a path they travel as one projected segment, `tenant~2Fopaque` (`spec/v2/core/identity.md` §5).
- Polling `GET /runs/{runId}` is the simplest way to track a run. For live events, see `examples/streaming-client/`.

## One file, zero dependencies

The example uses only Node 20+'s built-in `fetch`: no SDK, no transport library. The point is that the protocol is small enough to write a client in one file. For a production client, use the v2 SDKs in [`openwop-sdks`](https://github.com/openwop/openwop-sdks) (`@openwop/openwop@2` for TypeScript, `openwop-client>=2` for Python).
