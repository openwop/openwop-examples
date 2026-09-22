/**
 * RFC 0207 — trace context across MCP and A2A (src/trace-context.ts and its
 * callers). Route-level regression net under v2-interop-trace-context: the
 * suite's own fake MCP server records what this host's client sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpFakeServer } from '@openwop/openwop-conformance/src/lib/mcp-fake-server.js';
import { startHost, type RunningHost } from '../src/server.js';
import { createCtxMcp } from '../src/mcp-client.js';
import { childOf, inboundTraceContext, parseTraceparent } from '../src/trace-context.js';
import type { RunRow } from '../src/store.js';

const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const H = 'a'.repeat(32);
const tp = (trace: string) => `00-${trace}-00f067aa0ba902b7-01`;
const noHeader = () => null;

describe('trace-context: parsing and the receiver rule', () => {
  it('parses version 00 and refuses malformed values', () => {
    expect(parseTraceparent(tp(T))?.traceId).toBe(T);
    for (const bad of ['garbage', tp('0'.repeat(32)), `ff-${T}-00f067aa0ba902b7-01`, `${tp(T)}-x`, tp(T).toUpperCase(), 7]) expect(parseTraceparent(bad)).toBeNull();
  });
  it('the in-message value wins over the header; a malformed one falls back, never throws', () => {
    const header = (n: string) => (n === 'traceparent' ? tp(H) : null);
    expect(inboundTraceContext({ traceparent: tp(T) }, header)?.traceparent).toBe(tp(T));
    expect(inboundTraceContext({ traceparent: 'garbage' }, header)?.traceparent).toBe(tp(H));
    expect(inboundTraceContext({ traceparent: 'garbage' }, noHeader)).toBeNull();
    expect(inboundTraceContext(null, header)?.traceparent).toBe(tp(H));
  });
  it('a child keeps the trace id and mints a new span id', () => {
    const c = childOf({ traceparent: tp(T), tracestate: 'v=1' });
    expect(parseTraceparent(c.traceparent)?.traceId).toBe(T);
    expect(c.traceparent).not.toBe(tp(T));
    expect(c.tracestate).toBe('v=1');
  });
});

describe('trace-context: ctx.mcp carries the run trace in _meta AND the header', () => {
  let running: RunningHost;
  let fake: McpFakeServer;
  beforeAll(async () => {
    fake = new McpFakeServer();
    await fake.start(0);
    running = await startHost({ port: 0, dbPath: ':memory:', apiKey: 'test-key-trace', devValidate: 'strict', rateLimitPerMinute: 100_000, webhookAllowPrivate: true, mcpServers: new Map([['conformance', fake.endpoint()]]) });
  });
  afterAll(async () => { await running.close(); await fake.stop(); });

  it('a run started under trace T calls tools/call with T in both carriers', async () => {
    const run = { run_id: 'openwop-reference-tenant/trace-test-run-0001', options_json: JSON.stringify({ traceContext: { traceparent: tp(T) } }) } as unknown as RunRow;
    await createCtxMcp(running.host, run).callTool({ serverId: 'conformance', name: 'echo', arguments: { text: 'trace' }, idempotencyKey: 'k' });
    const sent = fake.invocations().filter((i) => i.method === 'tools/call').at(-1);
    const meta = (sent?.params as { _meta?: Record<string, unknown> } | undefined)?._meta ?? {};
    expect(parseTraceparent(meta['traceparent'])?.traceId).toBe(T);
    expect(parseTraceparent(sent?.headers['traceparent'])?.traceId).toBe(T);
    expect(meta['traceparent']).toBe(sent?.headers['traceparent']);
  });

  it('a run with no trace context sends neither carrier', async () => {
    await createCtxMcp(running.host, null).callTool({ serverId: 'conformance', name: 'echo', arguments: { text: 'none' }, idempotencyKey: 'k2' });
    const sent = fake.invocations().filter((i) => i.method === 'tools/call').at(-1);
    expect((sent?.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.['traceparent']).toBeUndefined();
    expect(sent?.headers['traceparent']).toBeUndefined();
  });
});
