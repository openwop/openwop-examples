/**
 * `spec/v2/core/tool-catalog.md` (RFC 0204 homes `toolCatalog`; RFC 0078).
 *
 * `GET /tools` (a `ToolDescriptor[]`) and `GET /tools/{toolId}`, read-only and
 * authenticated. Two sources:
 *
 *   node-pack  the node types this executor runs, each CLASSIFIED HERE by hand
 *              (safetyTier / replayPolicy / egress are host-assigned metadata,
 *              never inferred);
 *   mcp        the tools of every bound MCP server (`OPENWOP_MCP_SERVERS`),
 *              read through the same `ctx.mcp.listTools` a pack gets, every
 *              page followed. This host classifies NO MCP tool, so every one
 *              is `safetyTier: "write"` (§The descriptor) — whatever the
 *              server's `annotations` claim. The server's annotations are not
 *              copied anywhere.
 *
 * `annotations` (when the installed contract defines them) are computed from
 * the descriptor's own three fields by the table in §The descriptor, never
 * from MCP defaults. `tools` is sorted by `toolId` (the SHOULD), so an
 * unchanged catalog reads identically.
 *
 * The catalog is tenant-independent: every tool here is invocable by every
 * authenticated caller, so every caller's list is the same.
 */
import { err } from './errors.js';
import { createCtxMcp, mcpClientAdvertised } from './mcp-client.js';
import type { Host } from './host.js';

type Tier = 'pure' | 'read' | 'write' | 'exec';
type Replay = 'deterministic' | 'idempotent' | 'non-deterministic';
type Egress = 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned';
export interface ToolDescriptor {
  toolId: string;
  source: 'node-pack' | 'mcp';
  safetyTier: Tier;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  egress?: Egress;
  replayPolicy?: Replay;
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export const TOOL_SOURCES = ['node-pack', 'mcp'] as const;

/** The table (tool-catalog.md §The descriptor). A function of host-assigned fields only. */
export function annotationsOf(d: Pick<ToolDescriptor, 'safetyTier' | 'replayPolicy' | 'egress'>): NonNullable<ToolDescriptor['annotations']> {
  return {
    readOnlyHint: d.safetyTier === 'pure' || d.safetyTier === 'read',
    destructiveHint: d.safetyTier === 'write' || d.safetyTier === 'exec',
    idempotentHint: d.replayPolicy === 'deterministic' || d.replayPolicy === 'idempotent',
    openWorldHint: d.egress !== 'none',
  };
}

/** The executor's node types, classified by the host (this table IS the classification). */
function nodeTools(host: Host): ToolDescriptor[] {
  const rows: Array<[string, string, Tier, Replay, Egress]> = [
    ['core.noop', 'No-op', 'pure', 'deterministic', 'none'],
    ['core.delay', 'Delay', 'pure', 'deterministic', 'none'],
    ['core.fail', 'Fail', 'pure', 'deterministic', 'none'],
    // Sends an outbound request that may mutate; replay-safe under the Layer-2 key; guarded egress.
    ['core.httpFetch', 'HTTP fetch', 'write', 'idempotent', 'safe-fetch'],
  ];
  if (mcpClientAdvertised(host)) rows.push(['core.conformance.mcp-client', 'ctx.mcp call (conformance)', 'write', 'non-deterministic', 'host-mediated']);
  return rows.map(([typeId, title, safetyTier, replayPolicy, egress]) => ({ toolId: `openwop:${typeId}`, source: 'node-pack', title, safetyTier, replayPolicy, egress }));
}

/** Every page of every bound server's tools/list. An unreachable server contributes nothing. */
async function mcpTools(host: Host): Promise<ToolDescriptor[]> {
  if (!mcpClientAdvertised(host)) return [];
  const mcp = createCtxMcp(host, null);
  const out: ToolDescriptor[] = [];
  for (const serverId of host.config.mcpServers.keys()) {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      let result: Record<string, unknown>;
      try { result = await mcp.listTools({ serverId, ...(cursor !== undefined ? { cursor } : {}) }); } catch { break; }
      for (const t of Array.isArray(result['tools']) ? (result['tools'] as Array<Record<string, unknown>>) : []) {
        if (typeof t['name'] !== 'string') continue;
        const d: ToolDescriptor = {
          toolId: `mcp:${serverId}.${t['name']}`,
          source: 'mcp',
          title: typeof t['title'] === 'string' ? t['title'] : t['name'],
          // UNCLASSIFIED: §The descriptor makes it `write`. t.annotations is never read.
          safetyTier: 'write',
          replayPolicy: 'non-deterministic',
          egress: 'host-mediated',
        };
        if (typeof t['description'] === 'string') d.description = t['description'];
        if (t['inputSchema'] && typeof t['inputSchema'] === 'object') d.inputSchema = t['inputSchema'] as Record<string, unknown>;
        if (t['outputSchema'] && typeof t['outputSchema'] === 'object') d.outputSchema = t['outputSchema'] as Record<string, unknown>;
        out.push(d);
      }
      cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined;
      if (cursor === undefined) break;
    }
  }
  return out;
}

export async function listTools(host: Host): Promise<ToolDescriptor[]> {
  const all = [...nodeTools(host), ...(await mcpTools(host))];
  const withAnnotations = host.artifacts.toolAnnotations ? all.map((d) => ({ ...d, annotations: annotationsOf(d) })) : all;
  return withAnnotations.sort((a, b) => (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
}

export async function getTool(host: Host, toolId: string): Promise<ToolDescriptor> {
  const hit = (await listTools(host)).find((d) => d.toolId === toolId);
  if (!hit) throw err('not_found', `no tool ${JSON.stringify(toolId)} in this caller's catalog`);
  return hit;
}
