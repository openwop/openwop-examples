# Idempotent Runs

Layer-1 request idempotency on the v2 wire ([`spec/v2/core/idempotency.md`](https://github.com/openwop/openwop/blob/main/spec/v2/core/idempotency.md)). Three identical `POST /runs` calls with the same `Idempotency-Key` collapse to a single run; a fourth with the same key and a different body is refused.

| v2 family required | `idempotency` |
| Host target        | the v2 reference host, or any v2 host |
| Run modes          | default |

## Run

Against the v2 reference host (start it first — see [`examples/hosts/v2-reference/`](../hosts/v2-reference/)):

```bash
npm start
```

## Output (a real run against the v2 reference host)

```
Idempotency-Key: idempotent-example-11b53a9d-bc38-4361-9290-2cc1dd469966

→ Call 1 (fresh)
  status:  201
  runId:   openwop-reference-tenant/dU01qV4ZWHYlTwwDndm74Q5O
  replay:  null
→ Call 2 (same key, same body — expect cached replay)
  status:  201
  runId:   openwop-reference-tenant/dU01qV4ZWHYlTwwDndm74Q5O
  replay:  true
→ Call 3 (same key, same body — expect cached replay)
  status:  201
  runId:   openwop-reference-tenant/dU01qV4ZWHYlTwwDndm74Q5O
  replay:  true

✓ All three responses share runId openwop-reference-tenant/dU01qV4ZWHYlTwwDndm74Q5O

→ Call 4 (same key, DIFFERENT body — expect 409 idempotency_key_mismatch)
  status: 409
  error:  idempotency_key_mismatch
✓ Body mismatch correctly rejected
```

## What this teaches

- **Same key + same body** → the cached response, marked `OpenWOP-Idempotent-Replay: true`. The fresh response carries no marker.
- **Same key + different body** → `409 idempotency_key_mismatch`, the only mismatch code, and never the cached body. The key pins one logical operation.
- **Concurrent duplicates.** While the first request is still in flight, a duplicate either waits for the winner's final outcome or gets `409 idempotency_in_flight`.

## Why this matters

A network blip, retry storm, or second tab can fire the same logical operation several times. Without idempotency each retry creates a new run; with `Idempotency-Key` every retry lands on the same `runId`.

## Zero dependencies

Pure Node `fetch`. The protocol contract is what's interesting; the client code is incidental.
