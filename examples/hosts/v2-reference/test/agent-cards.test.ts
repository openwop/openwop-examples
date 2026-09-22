/**
 * RFC 0202 — the tenant-scoped agent inventory and the per-agent A2A cards.
 * Route-level regression net under the `v2-a2a-agent-cards` conformance
 * scenario. Runs only on a contract that defines `a2a.agentCards` (2.36.0+,
 * or `OPENWOP_SPEC_ARTIFACTS_DIR` pointing at a corpus tree that does); on an
 * older contract it asserts that nothing is advertised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-agent-cards';
const KB = 'test-key-agent-cards-tenant-b';

interface RpcErr { code: number; message: string }
interface Rpc { status: number; body: Record<string, unknown>; result?: any; error?: RpcErr | undefined }

async function a2a(method: string, params: unknown, key: string | null = K): Promise<Rpc> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
  if (key !== null) headers['Authorization'] = `Bearer ${key}`;
  const r = await fetch(`${B}/a2a/jsonrpc`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }) });
  const body = await r.json() as Record<string, unknown>;
  return { status: r.status, body, result: body['result'], error: body['error'] as RpcErr | undefined };
}
async function rest(path: string, key = K): Promise<{ status: number; json: any }> {
  const r = await fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${key}`, 'OpenWOP-Version': '2.0' } });
  return { status: r.status, json: await r.json().catch(() => undefined) };
}
const msg = (): Record<string, unknown> => ({ messageId: `m-${Math.random().toString(36).slice(2)}`, role: 'ROLE_USER', parts: [{ text: 'hi' }] });
const sansId = (r: Rpc): string => { const { id: _id, ...rest } = r.body; void _id; return JSON.stringify([r.status, rest]); };

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, tenantBApiKey: KB, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('RFC 0202 on an older contract', () => {
  it('advertises neither agents nor a2a.agentCards, and serves no inventory', async () => {
    if (running.host.artifacts.agentCardsFacet) return;
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as any;
    expect(d.agents).toBeUndefined();
    expect(d.a2a.agentCards).toBeUndefined();
    expect((await rest('/agents')).status).toBe(404);
  });
});

describe('RFC 0202 per-agent cards', () => {
  it('advertises agents.manifestRuntime (tenant scope) and a2a.agentCards', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as any;
    expect(d.a2a.agentCards).toBe(true);
    expect(d.agents.manifestRuntime).toEqual({ installScope: 'tenant', handoffValidation: false });
  });
  it('GET /agents is the caller\'s tenant only; another tenant\'s agent 404s as a missing one', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const a = await rest('/agents');
    const b = await rest('/agents', KB);
    expect(a.json.agents.map((e: { agentId: string }) => e.agentId)).toEqual(['core.conformance.agent-pack.resolver']);
    expect(b.json.agents.map((e: { agentId: string }) => e.agentId)).toEqual(['core.conformance.agent-pack.escalator']);
    const foreign = await rest('/agents/core.conformance.agent-pack.escalator');
    const missing = await rest('/agents/core.conformance.agent-pack.nobody');
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(missing.json);
    expect(JSON.stringify(a.json)).not.toContain('CANARY');
  });
  it('a2aTenant is opaque and stable; the card is the entry\'s, on the host interfaces with tenant R', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const e = (await rest('/agents')).json.agents[0];
    expect(e.a2aTenant).toMatch(/^ag-[A-Za-z0-9_-]{22}$/);
    expect((await rest('/agents')).json.agents[0].a2aTenant).toBe(e.a2aTenant);
    const card = (await a2a('GetExtendedAgentCard', { tenant: e.a2aTenant })).result;
    expect(card.name).toBe(e.persona);
    expect(card.version).toBe(e.packVersion);
    expect(card.description).toBe(e.description);
    expect(card.supportedInterfaces).toEqual([{ url: `${B}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: e.a2aTenant }]);
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(['conformance-approval']);
    expect(JSON.stringify(card)).not.toContain('CANARY');
    const pub = await (await fetch(`${B}/.well-known/agent-card.json`)).text();
    expect(pub).not.toContain(e.a2aTenant);
    expect(JSON.parse(pub).capabilities.extendedAgentCard).toBe(true);
  });
  it('another tenant\'s R and a never-minted R are the identical refusal on every operation', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const theirs = (await rest('/agents', KB)).json.agents[0].a2aTenant as string;
    for (const [m, p] of [['GetExtendedAgentCard', {}], ['SendMessage', { message: msg() }], ['ListTasks', {}]] as const) {
      const f = await a2a(m, { ...p, tenant: theirs });
      const n = await a2a(m, { ...p, tenant: 'ag-never-minted-000000' });
      expect(f.error?.code).toBe(-32602);
      expect(sansId(f)).toBe(sansId(n));
    }
    const anonReal = await a2a('GetExtendedAgentCard', { tenant: theirs }, null);
    const anonNever = await a2a('GetExtendedAgentCard', { tenant: 'ag-never-minted-000000' }, null);
    expect(anonReal.status).toBe(401);
    expect(sansId(anonReal)).toBe(sansId(anonNever));
  });
  it('SendMessage through R is a run in the caller\'s tenant carrying the agent; invisible to tenant B', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const e = (await rest('/agents')).json.agents[0];
    const task = (await a2a('SendMessage', { tenant: e.a2aTenant, message: msg() })).result.task;
    expect(task.id.startsWith('openwop-reference-tenant/')).toBe(true);
    const snap = await rest(`/runs/${encodeURIComponent(task.id)}`);
    expect(snap.status).toBe(200);
    expect(snap.json.agent).toEqual({ agentId: e.agentId, name: e.persona, modelClass: 'chat' });
    expect((await rest(`/runs/${encodeURIComponent(task.id)}`, KB)).status).not.toBe(200);
    const listed = (await a2a('ListTasks', { tenant: e.a2aTenant })).result.tasks.map((t: { id: string }) => t.id);
    expect(listed).toContain(task.id);
    await a2a('CancelTask', { tenant: e.a2aTenant, id: task.id });
  });
});
