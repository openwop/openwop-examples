/**
 * The suite's fake A2A peer and MCP server, started as one process for the
 * host's route tests (the suite's own scenarios start them in-process).
 *   npx tsx scripts/fake-peers.ts [a2aVersions=1.0,0.3] [mcpRevisions=2026-07-28,2025-06-18]
 * Prints `fake peers a2a=<url> mcp=<url>` and exits when stdin ends.
 */
import { A2AFakePeer } from '@openwop/openwop-conformance/src/lib/a2a-fake-peer.js';
import { McpFakeServer } from '@openwop/openwop-conformance/src/lib/mcp-fake-server.js';
const a2aVersions = (process.argv[2] ?? '1.0,0.3').split(',') as never;
const mcpRevisions = (process.argv[3] ?? '2026-07-28,2025-06-18').split(',') as never;
const peer = new A2AFakePeer({ protocolVersions: a2aVersions });
const server = new McpFakeServer({ protocolVersions: mcpRevisions });
await peer.start(0); await server.start(0);
console.log(`fake peers a2a=${peer.endpoint()} mcp=${server.endpoint()}`);
if (!process.stdin.isTTY) { process.stdin.resume(); process.stdin.on('end', () => { void peer.stop(); void server.stop(); process.exit(0); }); }
