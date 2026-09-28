// MCP-tool example — an OpenWOP v2 host seen through its MCP server mount.
//
// OpenWOP and MCP compose in both directions (spec/v2/core/interop.md): a host
// can be an MCP SERVER (its workflows are tools an MCP client calls) and an MCP
// CLIENT (pack code reaches MCP servers through `ctx.mcp`). The `mcp` family in
// discovery says which: `profiles[]` + `serverUrls[]` for the server mount,
// `client: true` for the client.
//
// What this example does:
//   1. GET /.well-known/openwop — read the `mcp` family; exit 0 when absent.
//   2. POST <serverUrls[0]> `tools/list` — the host's workflows as MCP tools.
//   3. POST <serverUrls[0]> `tools/call` — call one tool; the host starts a run.
//   4. GET /runs/{runId}/events/poll — observe that same run on the OpenWOP
//      wire: `run.started` records `transport: mcp`.
//
// The MCP mount is stateless at revision 2026-07-28: no `initialize`, no
// session id; every request carries its revision in both the
// `MCP-Protocol-Version` header and `_meta["io.modelcontextprotocol/protocolVersion"]`.
// The tool result is untrusted content (security-defaults.md): this example
// parses it only to find the runId, then reads the run through REST.
//
// Configuration via env vars:
//   OPENWOP_BASE_URL   default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY    default openwop-v2-dev-key
//   OPENWOP_MCP_TOOL   default conformance-noop — the tool (workflowId) to call
//
// @see spec/v2/core/interop.md
// @see spec/v2/interop-map.json (the `mcp.*` rows)

import { randomUUID } from 'node:crypto';

// Tiny ANSI helpers — colors when stdout is a TTY, no-op when piped/CI.
const _tty = process.stdout.isTTY;
const _c = _tty
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', reset: '' };
const skip = (msg) => console.log(`${_c.dim}${msg}${_c.reset}`);
const fail = (msg) => console.error(`${_c.red}${msg}${_c.reset}`);
const ok = (msg) => console.log(`${_c.green}${msg}${_c.reset}`);

const BASE_URL = process.env.OPENWOP_BASE_URL || 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY || 'openwop-v2-dev-key';
const TOOL = process.env.OPENWOP_MCP_TOOL || 'conformance-noop';
const V2 = { 'OpenWOP-Version': '2' };
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** identity.md §5: every byte outside [A-Za-z0-9._-] becomes ~ plus two uppercase hex digits. */
function projectId(id) {
  return [...Buffer.from(id, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

/** One stateless MCP JSON-RPC request against the server mount. */
async function mcp(url, revision, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': revision,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { ...params, _meta: { [META_VERSION]: revision } } }),
  });
  const body = await res.json().catch(() => null);
  if (body?.error) throw new Error(`${method} → ${body.error.code} ${body.error.message}`);
  if (!res.ok || !body?.result) throw new Error(`${method} → HTTP ${res.status}`);
  return body.result;
}

async function main() {
  console.log(`→ Discovery: ${BASE_URL}/.well-known/openwop (OpenWOP-Version: 2)`);
  const disco = await fetch(`${BASE_URL}/.well-known/openwop`, { headers: V2 });
  if (!disco.ok) throw new Error(`discovery failed: ${disco.status}`);
  if (!String(disco.headers.get('openwop-version') ?? '').startsWith('2')) {
    fail('✗ The host did not serve major 2. It may not implement v2 yet.');
    process.exit(1);
  }
  const doc = await disco.json();
  console.log(`  Host: ${doc.implementation?.name ?? 'unknown'}`);
  const family = doc.mcp;
  if (family == null) {
    skip('⊘ The `mcp` family is not advertised by this host.');
    process.exit(0);
  }
  console.log(`  ✓ mcp advertised (status: ${family.status})`);
  console.log(`    profiles:   [${(family.profiles ?? []).join(', ')}]`);
  console.log(`    revisions:  [${(family.revisions ?? []).join(', ')}]`);
  console.log(`    serverUrls: [${(family.serverUrls ?? []).join(', ')}]`);
  console.log(`    client:     ${family.client === true ? 'true (pack code gets ctx.mcp)' : 'not advertised'}`);

  const serverUrl = Array.isArray(family.serverUrls) ? family.serverUrls[0] : undefined;
  const revision = Array.isArray(family.revisions) ? family.revisions[0] : undefined;
  if (!serverUrl || !revision) {
    skip('⊘ No MCP server mount is advertised by this host (no `mcp.serverUrls[]`); nothing to call.');
    process.exit(0);
  }

  console.log(`→ tools/list  (${serverUrl}, MCP-Protocol-Version: ${revision})`);
  const list = await mcp(serverUrl, revision, 'tools/list');
  const tools = list.tools ?? [];
  console.log(`  ${tools.length} tool(s): ${tools.slice(0, 6).map((t) => t.name).join(', ')}${tools.length > 6 ? ', …' : ''}`);
  if (!tools.some((t) => t.name === TOOL)) {
    skip(`⊘ Tool "${TOOL}" is not listed by this host's mount. Set OPENWOP_MCP_TOOL to one of the names above.`);
    process.exit(0);
  }

  console.log(`→ tools/call { name: "${TOOL}" }`);
  const call = await mcp(serverUrl, revision, 'tools/call', { name: TOOL, arguments: {} });
  const text = (call.content ?? []).find((p) => p.type === 'text')?.text ?? '';
  let result;
  try { result = JSON.parse(text); } catch { result = {}; }
  console.log(`  isError: ${call.isError === true}`);
  console.log(`  runId:   ${result.runId ?? '<none>'}`);
  console.log(`  status:  ${result.status ?? '<none>'}`);
  if (call.isError === true || typeof result.runId !== 'string') {
    fail(`✗ Expected a completed run from tools/call, got ${text.slice(0, 200)}`);
    process.exit(1);
  }

  console.log(`→ GET /runs/${projectId(result.runId)}/events/poll  (the same run, over REST)`);
  const res = await fetch(`${BASE_URL}/runs/${projectId(result.runId)}/events/poll`, {
    headers: { ...V2, Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`events poll failed: ${res.status}`);
  const { events = [] } = await res.json();
  for (const e of events) console.log(`  [${e.sequence}] ${e.type}${e.nodeId ? ` node=${e.nodeId}` : ''}`);
  const started = events.find((e) => e.type === 'run.started');
  console.log(`  run.started transport: ${started?.payload?.transport ?? '<unrecorded>'}`);
  if (started?.payload?.transport !== 'mcp') {
    fail('✗ Expected run.started to record transport: mcp');
    process.exit(1);
  }

  console.log('');
  ok('✓ MCP tools/list + tools/call round-trip observed on the OpenWOP wire');
}

main().catch((err) => {
  fail(`✗ ${err.message}`);
  process.exit(1);
});
