/**
 * host-services.md §`httpClient` — `ctx.http.safeFetch`, as this host serves it.
 *
 * One function, used by the reserved `core.conformance.safefetch-probe` node
 * (conformance/fixtures.md §"The safeFetch probe fixture"). It applies the
 * address guard of egress.ts and never relaxes it: the operator switches that
 * open the guard for webhooks and OAuth (`OPENWOP_*_ALLOW_PRIVATE`) do not
 * reach this path, so a loopback conformance lane still measures a closed guard.
 *
 *   - the target is resolved, every address is checked, and the connection is
 *     pinned to the checked address (`guardedRequest`);
 *   - a refused target is `egress_denied`, `details.reason: ssrf-blocked`;
 *   - a target that gives no answer is `upstream_unavailable`;
 *   - the response is cut at `maxResponseBodyBytes` and the request at
 *     `requestTimeoutMs`; a redirect is not followed and a connection upgrade
 *     is not accepted (Node destroys an upgrade no listener takes).
 *
 * `GET` only: it is the one method the probe uses and the one `methods` lists.
 */

import { guardedRequest, hostnameDenied } from './egress.js';

export const HTTP_CLIENT = { ssrfGuard: true, maxResponseBodyBytes: 1_048_576, requestTimeoutMs: 5_000, methods: ['GET'] } as const;

export class SafeFetchRejection extends Error {
  constructor(readonly code: 'egress_denied' | 'upstream_unavailable', message: string, readonly details: Record<string, unknown>) { super(message); }
}

/** GET `raw` through the guard. Resolves with the response status; rejects with a {@link SafeFetchRejection}. */
export async function safeFetch(raw: string): Promise<{ status: number }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SafeFetchRejection('egress_denied', 'the target is not an absolute URL', { reason: 'ssrf-blocked' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchRejection('egress_denied', `the ${url.protocol} scheme is not fetched`, { reason: 'ssrf-blocked' });
  // Refused on the NAME before any lookup (localhost, *.internal, metadata hosts, literal addresses) …
  if (hostnameDenied(url.hostname)) throw new SafeFetchRejection('egress_denied', 'the target names a loopback, private, link-local or metadata host', { reason: 'ssrf-blocked' });
  // … and on every RESOLVED address inside guardedRequest, which then pins the connection to it.
  let r;
  try {
    r = await guardedRequest(url, { method: 'GET', headers: {}, timeoutMs: HTTP_CLIENT.requestTimeoutMs, allowPrivate: false, maxResponseBodyBytes: HTTP_CLIENT.maxResponseBodyBytes });
  } catch (e) {
    throw new SafeFetchRejection('upstream_unavailable', `the target could not be resolved: ${(e as Error).message}`, { reason: 'unreachable' });
  }
  if (r.error !== undefined && r.error.startsWith('egress denied')) throw new SafeFetchRejection('egress_denied', 'the target resolves to a loopback, private, link-local or metadata address', { reason: 'ssrf-blocked' });
  if (r.error === 'redirect refused') return { status: r.status };
  if (r.error !== undefined || r.status === 0) throw new SafeFetchRejection('upstream_unavailable', `no answer from the target (${r.error ?? 'no status'})`, { reason: r.error === 'response too large' ? 'response-too-large' : 'unreachable' });
  return { status: r.status };
}
