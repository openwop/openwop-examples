/**
 * RFC 0204 — ctx.mcp (mcp-client.ts) and the tool catalog (tool-catalog.ts).
 * Route-level regression net under v2-mcp-client-results and
 * v2-tool-catalog-annotations: the suite's own fake MCP server, the host
 * in-memory with strict dev validation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpFakeServer } from '@openwop/openwop-conformance/src/lib/mcp-fake-server.js';
import { startHost, type RunningHost } from '../src/server.js';
import { createCtxMcp, resetMcpProbes } from '../src/mcp-client.js';
import { annotationsOf } from '../src/tool-catalog.js';

let running: RunningHost;
let fake: McpFakeServer;
let B = '';
const K = 'test-key-mcp-client';

beforeAll(async () => {
  fake = new McpFakeServer();
  await fake.start(0);
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000, webhookAllowPrivate: true, mcpServers: new Map([['conformance', fake.endpoint()], ['conformance.down', 'http://127.0.0.1:9']]) });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); await fake.stop(); });

describe('ctx.mcp', () => {
  it('callTool resolves the server result unaltered, _meta included', async () => {
    const mcp = createCtxMcp(running.host, null);
    const r = await mcp.callTool({ serverId: 'conformance', name: 'echo', arguments: { text: 'hi' }, idempotencyKey: 'k1' });
    const sent = fake.invocations().filter((i) => i.method === 'tools/call').at(-1);
    expect(sent?.revision).toBe('2026-07-28');
    expect(r['content']).toEqual([{ type: 'text', text: 'hi' }]);
    expect((r['_meta'] as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toBeDefined();
  });

  it('an unknown serverId rejects not_found; an MCP error rejects mcp_error with the error unaltered', async () => {
    const mcp = createCtxMcp(running.host, null);
    await expect(mcp.callTool({ serverId: 'no-such', name: 'echo', idempotencyKey: 'k2' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mcp.callTool({ serverId: 'conformance', name: 'no-such-tool', idempotencyKey: 'k3' })).rejects.toMatchObject({ code: 'mcp_error', details: { error: { code: -32602 } } });
  });

  it('serverHealth is reachable / unreachable, never a session state', async () => {
    resetMcpProbes();
    const mcp = createCtxMcp(running.host, null);
    const up = await mcp.serverHealth({ serverId: 'conformance' });
    expect(up['state']).toBe('reachable');
    expect((up['discover'] as { supportedVersions: string[] }).supportedVersions).toContain('2026-07-28');
    expect(await mcp.serverHealth({ serverId: 'conformance.down' })).toEqual({ state: 'unreachable' });
    expect(JSON.stringify(up)).not.toMatch(/connected/);
  });
});

describe('GET /tools', () => {
  it('is authenticated, sorted by toolId, and never lowers an MCP tool below write', async () => {
    expect((await fetch(`${B}/tools`)).status).toBe(401);
    const tools = (await (await fetch(`${B}/tools`, { headers: { Authorization: `Bearer ${K}` } })).json()) as Array<{ toolId: string; source: string; safetyTier: string }>;
    const ids = tools.map((t) => t.toolId);
    expect(ids).toEqual([...ids].sort());
    for (const t of tools.filter((x) => x.source === 'mcp')) expect(t.safetyTier).toBe('write');
    const one = await fetch(`${B}/tools/${encodeURIComponent('openwop:core.noop')}`, { headers: { Authorization: `Bearer ${K}` } });
    expect(one.status).toBe(200);
    expect((await fetch(`${B}/tools/nope`, { headers: { Authorization: `Bearer ${K}` } })).status).toBe(404);
  });

  it('annotations are the table function of the host-assigned fields', () => {
    expect(annotationsOf({ safetyTier: 'pure', replayPolicy: 'deterministic', egress: 'none' })).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(annotationsOf({ safetyTier: 'write' })).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
