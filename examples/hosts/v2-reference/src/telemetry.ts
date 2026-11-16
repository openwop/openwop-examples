/**
 * telemetry.md (RFC 0262) — OTLP trace export, the `telemetry` family.
 *
 *   - Every run exports a span named `openwop.run` carrying `openwop.run_id` and
 *     `openwop.workflow_id`, ended when the run reaches a terminal event.
 *   - Every node execution exports a span named `openwop.node.<typeId>` carrying
 *     `openwop.run_id`, `openwop.node_id`, `openwop.node_type` and the zero-based
 *     `openwop.node_attempt`, as a child of the run's span.
 *   - A run created with a valid W3C `traceparent` exports its spans in that
 *     trace: the run span's parent is the caller's span.
 *   - No span name, attribute or resource attribute carries credential material.
 *     Every value is an id, a type or a count the run log already holds. Inputs,
 *     outputs and resolved secrets are never read.
 *
 * Built from the event bus, so the executor is untouched and the spans say what
 * the log says. Span ids are DERIVED (sha-256 of run, node and attempt), so a run
 * that crosses a restart still exports one tree. The exporter is OTLP/HTTP-JSON
 * over `fetch`, with no SDK, matching this host's node:http + node:crypto
 * footprint.
 *
 * Off unless the operator sets the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). Discovery advertises `telemetry` only
 * then, because the family's presence is the claim that the host exports.
 */
import { createHash } from 'node:crypto';
import type { AppendedEvent, Host } from './host.js';
import { parseTraceparent, runTraceContext } from './trace-context.js';

/** The transports this exporter speaks (`telemetry.otlp.protocols`). */
export const OTLP_PROTOCOLS = ['http/json'] as const;

/** Where traces go: the signal-specific endpoint as given, else `<base>/v1/traces` (OTLP exporter spec). */
export function tracesEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const specific = env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']?.trim();
  if (specific) return specific;
  const base = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  return base ? `${base.replace(/\/+$/, '')}/v1/traces` : null;
}

export const telemetryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => tracesEndpoint(env) !== null;

const hex = (input: string, bytes: number): string => createHash('sha256').update(input).digest('hex').slice(0, bytes * 2);
const nanos = (iso: string): string => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
type AttrValue = string | number;
const attrs = (o: Record<string, AttrValue>): Array<{ key: string; value: Record<string, unknown> }> =>
  Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: ReturnType<typeof attrs>;
  status: { code: number };
}

/** The run's trace: the caller's when it came with a valid `traceparent`, else one derived from the run id. */
function runTrace(host: Host, runId: string): { traceId: string; parentSpanId?: string } {
  const row = host.store.getRun(runId);
  const tc = row ? runTraceContext(row.options_json) : null;
  const parsed = tc ? parseTraceparent(tc.traceparent) : null;
  if (parsed && tc) return { traceId: parsed.traceId, parentSpanId: tc.traceparent.trim().split('-')[2]! };
  return { traceId: hex(`openwop.run:${runId}`, 16) };
}

/**
 * Start exporting. Returns a stop function that flushes what is buffered. A
 * failed export is dropped and never fails a run (telemetry is observability,
 * not the log).
 */
export function startTelemetry(host: Host): () => Promise<void> {
  const endpoint = tracesEndpoint();
  if (endpoint === null) return async () => {};
  const runStart = new Map<string, string>();
  const nodeStart = new Map<string, { at: string; typeId: string; attempt: number }>();
  let buffer: Span[] = [];
  let timer: NodeJS.Timeout | null = null;
  const inflight = new Set<Promise<unknown>>();

  const flush = (): void => {
    timer = null;
    if (buffer.length === 0) return;
    const spans = buffer; buffer = [];
    const body = {
      resourceSpans: [{
        resource: { attributes: attrs({ 'service.name': 'openwop-host-v2-reference', 'telemetry.sdk.name': 'openwop-v2-reference', 'telemetry.sdk.language': 'nodejs' }) },
        scopeSpans: [{ scope: { name: 'openwop.v2-reference' }, spans }],
      }],
    };
    const p = fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };
  const push = (span: Span): void => {
    buffer.push(span);
    timer ??= setTimeout(flush, 50);
  };

  const onEvent = ({ run, doc }: AppendedEvent): void => {
    const runId = run.runId;
    const p = (doc.payload ?? {}) as Record<string, unknown>;
    if (doc.type === 'run.started') { runStart.set(runId, doc.timestamp); return; }
    if (doc.type === 'node.started' && doc.nodeId) {
      nodeStart.set(`${runId}\u0000${doc.nodeId}`, { at: doc.timestamp, typeId: String(p['typeId'] ?? 'unknown'), attempt: typeof p['attempt'] === 'number' ? p['attempt'] : 0 });
      return;
    }
    const trace = (): { traceId: string; parentSpanId?: string } => runTrace(host, runId);
    if ((doc.type === 'node.completed' || doc.type === 'node.failed' || doc.type === 'node.cancelled') && doc.nodeId) {
      const key = `${runId}\u0000${doc.nodeId}`;
      const started = nodeStart.get(key);
      if (!started) return;
      nodeStart.delete(key);
      push({
        traceId: trace().traceId,
        spanId: hex(`openwop.node:${runId}:${doc.nodeId}:${started.attempt}:${started.at}`, 8),
        parentSpanId: hex(`openwop.run:${runId}`, 8),
        name: `openwop.node.${started.typeId}`,
        kind: 1,
        startTimeUnixNano: nanos(started.at),
        endTimeUnixNano: nanos(doc.timestamp),
        attributes: attrs({ 'openwop.run_id': runId, 'openwop.node_id': doc.nodeId, 'openwop.node_type': started.typeId, 'openwop.node_attempt': started.attempt }),
        status: { code: doc.type === 'node.failed' ? 2 : 1 },
      });
      return;
    }
    if (doc.type === 'run.completed' || doc.type === 'run.failed' || doc.type === 'run.cancelled') {
      const row = host.store.getRun(runId);
      const t = trace();
      push({
        traceId: t.traceId,
        spanId: hex(`openwop.run:${runId}`, 8),
        ...(t.parentSpanId ? { parentSpanId: t.parentSpanId } : {}),
        name: 'openwop.run',
        kind: 2,
        startTimeUnixNano: nanos(runStart.get(runId) ?? row?.created_at ?? doc.timestamp),
        endTimeUnixNano: nanos(doc.timestamp),
        attributes: attrs({ 'openwop.run_id': runId, 'openwop.workflow_id': row?.workflow_id ?? 'unknown' }),
        status: { code: doc.type === 'run.failed' ? 2 : 1 },
      });
      runStart.delete(runId);
    }
  };
  host.bus.on('event', onEvent);
  return async () => {
    host.bus.off('event', onEvent);
    if (timer) { clearTimeout(timer); flush(); }
    await Promise.all([...inflight]);
  };
}
