/**
 * interop.md §"Trace context" (RFC 0207) — W3C Trace Context across MCP and A2A.
 *
 * Correlation only: nothing here is ever read as tenant, principal or scope.
 *
 *   Inbound  — a request's trace context is `params._meta.traceparent` (MCP) or
 *              `Message.metadata.openwop.traceparent` (A2A) when present and
 *              valid, else the HTTP `traceparent` header, else none. A
 *              malformed value is ignored (a new trace starts); it never fails
 *              the request (W3C Trace Context §3.2 "restart the trace").
 *   Outbound — every MCP request and A2A message a run (or a seam acting for
 *              one) sends carries a CHILD of that context — same trace id, a
 *              fresh span id — in BOTH carriers: the in-message one the RFC
 *              says SHOULD be used (the only one that exists on stdio) and the
 *              HTTP header that stays conforming.
 *
 * The run keeps the context it was started under in its options row
 * (`traceContext`), so a `ctx.mcp` call made long after `POST /runs` returned
 * still continues the caller's trace.
 */
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

const GRAMMAR = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A valid W3C `traceparent` (version-00 exactly; a future version may append `-…` fields), or null. */
export function parseTraceparent(value: unknown): { traceId: string; flags: string } | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const m = GRAMMAR.exec(v.slice(0, 55));
  if (m === null) return null;
  const version = m[1]!; const traceId = m[2]!; const parentId = m[3]!; const flags = m[4]!;
  if (version === 'ff' || (v.length > 55 && (version === '00' || v[55] !== '-'))) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { traceId, flags };
}

function ofValue(traceparent: unknown, tracestate: unknown): TraceContext | null {
  if (parseTraceparent(traceparent) === null) return null;
  const tp = (traceparent as string).trim();
  return typeof tracestate === 'string' && tracestate.length > 0 && tracestate.length <= 512 ? { traceparent: tp, tracestate } : { traceparent: tp };
}

/** The inbound context: the in-message value when valid, else the header, else null. */
export function inboundTraceContext(inMessage: { traceparent?: unknown; tracestate?: unknown } | null | undefined, header: (name: string) => string | null): TraceContext | null {
  return ofValue(inMessage?.traceparent, inMessage?.tracestate) ?? ofValue(header('traceparent'), header('tracestate'));
}

/** A child of `tc` for one outbound request: same trace id, fresh span id. */
export function childOf(tc: TraceContext): TraceContext {
  const p = parseTraceparent(tc.traceparent)!;
  let span = randomBytes(8).toString('hex');
  while (/^0+$/.test(span)) span = randomBytes(8).toString('hex');
  const traceparent = `00-${p.traceId}-${span}-${p.flags}`;
  return tc.tracestate !== undefined ? { traceparent, tracestate: tc.tracestate } : { traceparent };
}

/** The HTTP header carrier (Streamable HTTP / A2A HTTP). */
export function traceHeaders(tc: TraceContext | null): Record<string, string> {
  if (tc === null) return {};
  return { traceparent: tc.traceparent, ...(tc.tracestate !== undefined ? { tracestate: tc.tracestate } : {}) };
}

/** The in-message carrier: unprefixed keys for MCP `_meta`, the same pair for A2A `metadata.openwop`. */
export function traceFields(tc: TraceContext | null): Record<string, string> {
  return traceHeaders(tc);
}

/** The context a run was started under (runs.ts / mcp-server.ts / a2a-server.ts store it in options). */
export function runTraceContext(optionsJson: string): TraceContext | null {
  try {
    const tc = (JSON.parse(optionsJson) as { traceContext?: { traceparent?: unknown; tracestate?: unknown } }).traceContext;
    return ofValue(tc?.traceparent, tc?.tracestate);
  } catch {
    return null;
  }
}
