/**
 * RFC 0213 §B witness seam — `POST /conformance/seams/sample/test/idempotency/hold`.
 *
 * The 409 `idempotency_in_flight` branch of idempotency.md §Concurrency runs only
 * while a same-key create is still in flight, and this host answers a create in
 * milliseconds, so five concurrent POSTs never overlap (the unaided leg records
 * `partial-witness`). The seam ARMS a single-use hold: the host's next real
 * `POST /runs` carrying that Idempotency-Key, from that tenant, keeps its claim in
 * flight for `holdMs` before running. The seam never answers a create and never
 * emits a 409 itself — every refusal comes from `withIdempotency`'s unmodified
 * in-flight branch.
 *
 * Scope: keyed by (tenant, key); single-use; an armed hold expires unconsumed
 * after ARM_TTL_MS. Only the seam route (mounted only under the seams profile)
 * ever arms one, so the production path reads an empty map.
 */
import type { Host } from './host.js';

export const MAX_HOLD_MS = 10_000;
const ARM_TTL_MS = 60_000;

interface Armed { readonly holdMs: number; readonly expiresAt: number }
const holds = new WeakMap<Host, Map<string, Armed>>();
const slot = (tenant: string, key: string): string => `${tenant}\n${key}`;

export function armHold(host: Host, tenant: string, key: string, holdMs: number): void {
  let m = holds.get(host);
  if (m === undefined) { m = new Map(); holds.set(host, m); }
  m.set(slot(tenant, key), { holdMs, expiresAt: Date.now() + ARM_TTL_MS });
}

/** Consume the armed hold for (tenant, key), if any; returns its duration in ms, else 0. */
export function consumeHold(host: Host, tenant: string, key: string): number {
  const m = holds.get(host);
  if (m === undefined) return 0;
  const k = slot(tenant, key);
  const armed = m.get(k);
  if (armed === undefined) return 0;
  m.delete(k);
  return armed.expiresAt >= Date.now() ? armed.holdMs : 0;
}
