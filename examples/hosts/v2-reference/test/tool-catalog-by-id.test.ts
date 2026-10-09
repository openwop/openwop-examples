/**
 * tool-catalog.md §B — a tool the caller's list returned is served by id, even when
 * the MCP server behind it fails the next `tools/list` (a tunnelled cut, 2026-10-08:
 * the by-id read of a listed `mcp:` tool answered 404).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpFakeServer } from '@openwop/openwop-conformance/src/lib/mcp-fake-server.js';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let fake: McpFakeServer;
let B = '';
const K = 'test-key-tool-by-id';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0' };

beforeAll(async () => {
  fake = new McpFakeServer();
  await fake.start(0);
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000, webhookAllowPrivate: true, mcpServers: new Map([['conformance', fake.endpoint()]]) });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('tool catalog by id', () => {
  it('serves a just-listed MCP tool by id while its server is unreachable', async () => {
    const list = (await (await fetch(`${B}/tools`, { headers: H })).json()) as Array<{ toolId: string }>;
    const mcpTool = list.find((t) => t.toolId.startsWith('mcp:'));
    if (mcpTool === undefined) return; // mcp.client not advertised on this contract
    await fake.stop();
    const one = await fetch(`${B}/tools/${encodeURIComponent(mcpTool.toolId)}`, { headers: H });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { toolId: string }).toolId).toBe(mcpTool.toolId);
    expect((await fetch(`${B}/tools/${encodeURIComponent('mcp:conformance.never-listed')}`, { headers: H })).status).toBe(404);
  });
});
