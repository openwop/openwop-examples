/**
 * RFC 0262 — the `telemetry` family (telemetry.ts) and the store canary it is
 * checked against (secrets.ts). The suite's v2-telemetry-export witnesses the
 * rules against its own collector. This file pins the host's half with a
 * capture listener standing in for that collector:
 *   - `telemetry` is advertised only while an OTLP endpoint is configured;
 *   - a run exports `openwop.run` and `openwop.node.<typeId>` with their
 *     attributes, the node span a child of the run span;
 *   - a run created with a `traceparent` exports into that trace, its run span
 *     parented on the caller's span;
 *   - the canary node outputs only `{secretSha256, secretLength}`, and no span
 *     carries an attribute outside the closed id/type/count set.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let collector: Server;
let B = '';
const K = 'test-key-0262';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
interface Span { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }
const spans: Span[] = [];
const prior = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

beforeAll(async () => {
  collector = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> };
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise<void>((ok) => collector.listen(0, '127.0.0.1', () => ok()));
  const a = collector.address();
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => {
  await running.close();
  await new Promise<void>((ok) => collector.close(() => ok()));
  if (prior === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']; else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prior;
});

const attr = (s: Span, key: string): unknown => { const v = s.attributes.find((a) => a.key === key)?.value; return v?.['stringValue'] ?? (v?.['intValue'] !== undefined ? Number(v['intValue']) : undefined); };
async function terminal(runId: string): Promise<any[]> {
  for (let i = 0; i < 80; i++) {
    const p = (await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: H })).json()) as any;
    if (p.events.some((e: any) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type))) return p.events;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} did not end`);
}
async function runSpans(workflowId: string, headers: Record<string, string> = {}): Promise<{ runId: string; events: any[]; mine: Span[] }> {
  const c = await fetch(`${B}/runs`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify({ workflowId }) });
  expect(c.status).toBe(201);
  const runId = ((await c.json()) as any).runId as string;
  const events = await terminal(runId);
  for (let i = 0; i < 60 && !spans.some((s) => s.name === 'openwop.run' && attr(s, 'openwop.run_id') === runId); i++) await new Promise((r) => setTimeout(r, 25));
  return { runId, events, mine: spans.filter((s) => attr(s, 'openwop.run_id') === runId) };
}

describe('RFC 0262 — telemetry export', () => {
  it('advertises telemetry (http/json) and secrets while an endpoint is configured, and not otherwise', async () => {
    const doc = async (): Promise<any> => (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    const on = await doc();
    expect(on.telemetry).toMatchObject({ witness: 'witnessable-gated', otlp: { protocols: ['http/json'] } });
    expect(on.secrets).toMatchObject({ witness: 'witnessable-gated' });
    const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    try { expect((await doc()).telemetry).toBeUndefined(); } finally { process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint; }
  });

  it('a run exports openwop.run and a child openwop.node.<typeId> span with their attributes', async () => {
    const { runId, mine } = await runSpans('conformance-noop');
    const run = mine.find((s) => s.name === 'openwop.run');
    expect(run, 'no openwop.run span').toBeDefined();
    expect(attr(run!, 'openwop.workflow_id')).toBe('conformance-noop');
    const node = mine.find((s) => s.name.startsWith('openwop.node.'));
    expect(node, 'no node span').toBeDefined();
    expect(node!.parentSpanId).toBe(run!.spanId);
    expect(node!.traceId).toBe(run!.traceId);
    expect(attr(node!, 'openwop.node_type')).toBe(node!.name.slice('openwop.node.'.length));
    expect(attr(node!, 'openwop.node_attempt')).toBe(0);
    expect(typeof attr(node!, 'openwop.node_id')).toBe('string');
    expect(runId).toBeTruthy();
  });

  it('a run created with a traceparent exports into that trace, parented on the caller', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const { mine } = await runSpans('conformance-noop', { traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((s) => s.traceId === traceId)).toBe(true);
    expect(mine.find((s) => s.name === 'openwop.run')!.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('the canary node outputs only its digest and length, and spans carry only ids, types and counts', async () => {
    const { events, mine } = await runSpans('openwop-smoke-byok-roundtrip');
    const done = events.find((e: any) => e.type === 'node.completed' && e.nodeId === 'resolve-secret');
    expect(Object.keys(done.payload.outputs).sort()).toEqual(['secretLength', 'secretSha256']);
    expect(done.payload.outputs.secretSha256).toMatch(/^[0-9a-f]{64}$/);
    const allowed = new Set(['openwop.run_id', 'openwop.workflow_id', 'openwop.node_id', 'openwop.node_type', 'openwop.node_attempt']);
    for (const s of mine) for (const a of s.attributes) expect(allowed.has(a.key), `${s.name} carries ${a.key}`).toBe(true);
  });
});
