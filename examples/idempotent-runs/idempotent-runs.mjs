// Idempotent-runs example — Layer-1 request idempotency on the v2 wire
// (spec/v2/core/idempotency.md).
//
// Sends POST /runs three times with the same Idempotency-Key and the same
// body. The first call creates a run; the second and third return the cached
// response marked `OpenWOP-Idempotent-Replay: true`. All three share one runId.
//
// A fourth call reuses the key with a different body. A different request
// digest under the same key fails with `409 idempotency_key_mismatch` and
// never returns the cached body.
//
// Every request carries `OpenWOP-Version: 2`.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL  default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY   default openwop-v2-dev-key
//
// Zero external dependencies — Node 20+ fetch.

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.OPENWOP_BASE_URL || 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY || 'openwop-v2-dev-key';

async function postRun(idempotencyKey, body) {
  const res = await fetch(`${BASE_URL}/runs`, {
    method: 'POST',
    headers: {
      'OpenWOP-Version': '2',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    replay: res.headers.get('openwop-idempotent-replay'),
    body: await res.json().catch(() => null),
  };
}

async function main() {
  const key = `idempotent-example-${randomUUID()}`;
  const body = {
    workflowId: 'conformance-idempotent',
    inputs: { nonce: 'first-attempt' },
  };

  console.log(`Idempotency-Key: ${key}`);
  console.log('');

  const calls = [];
  for (const [n, label] of [[1, 'fresh'], [2, 'same key, same body — expect cached replay'], [3, 'same key, same body — expect cached replay']]) {
    console.log(`→ Call ${n} (${label})`);
    const r = await postRun(key, body);
    console.log(`  status:  ${r.status}`);
    console.log(`  runId:   ${r.body?.runId}`);
    console.log(`  replay:  ${r.replay}`);
    calls.push(r);
  }
  const [a, b, c] = calls;

  console.log('');
  if (a.status !== 201) {
    console.error(`✗ Expected 201 on the fresh call, got ${a.status} ${JSON.stringify(a.body)}`);
    process.exit(1);
  }
  if (a.body?.runId !== b.body?.runId || a.body?.runId !== c.body?.runId) {
    console.error('✗ runIds differ across replays');
    process.exit(1);
  }
  if (b.replay !== 'true' || c.replay !== 'true') {
    console.error('✗ Expected OpenWOP-Idempotent-Replay: true on calls 2 and 3');
    process.exit(1);
  }
  console.log(`✓ All three responses share runId ${a.body?.runId}`);

  console.log('');
  console.log('→ Call 4 (same key, DIFFERENT body — expect 409 idempotency_key_mismatch)');
  const conflict = await postRun(key, {
    workflowId: 'conformance-idempotent',
    inputs: { nonce: 'DIFFERENT-attempt' },
  });
  console.log(`  status: ${conflict.status}`);
  console.log(`  error:  ${conflict.body?.error}`);

  if (conflict.status !== 409 || conflict.body?.error !== 'idempotency_key_mismatch') {
    console.error('✗ Expected 409 idempotency_key_mismatch');
    process.exit(1);
  }
  console.log('✓ Body mismatch correctly rejected');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
