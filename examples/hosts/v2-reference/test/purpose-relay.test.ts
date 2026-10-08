/**
 * security-defaults.md §Onward hops through the conformance relay
 * (fixtures.md §conformance-purpose-relay). The suite's v2-purpose-propagation-onward
 * scenario witnesses it; this file pins the host's half: with the fixture loaded and
 * a relay peer configured, `purposePropagation` is advertised, one agent's card
 * routes only the relay, a labelled inbound message reaches the peer with its label
 * unchanged, and `[]` sends nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, type RunningHost } from '../src/server.js';
import { RELAY_WORKFLOW_ID } from '../src/purpose.js';

const FIXTURE = {
  id: RELAY_WORKFLOW_ID, name: 'Conformance: Purpose Relay', version: '1.0', description: 'test copy',
  nodes: [{ id: 'relay', typeId: 'core.conformance.a2a-invoke', name: 'Relay', position: { x: 0, y: 0 }, config: { skill: 'echo', forward: 'inbound-message' }, inputs: {} }],
  edges: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }], variables: [], metadata: { tags: ['conformance'] }, settings: { timeout: 30000 },
};
const LABEL = ['analytics', 'support'];

let running: RunningHost;
let peer: Server;
let B = '';
const received: Array<Record<string, any>> = [];
const K = 'test-key-purpose';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };

beforeAll(async () => {
  peer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') { res.end(JSON.stringify({ supportedInterfaces: [] })); return; }
      const rpc = JSON.parse(body);
      received.push(rpc);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { message: { role: 'ROLE_AGENT', parts: [{ text: 'ok' }] } } }));
    });
  });
  await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'relay-fixture-'));
  writeFileSync(join(dir, `${RELAY_WORKFLOW_ID}.json`), JSON.stringify(FIXTURE));
  running = await startHost({
    port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000, fixturesDir: dir,
    a2aRelayPeerUrl: `http://127.0.0.1:${(peer.address() as { port: number }).port}`, webhookAllowPrivate: true,
  });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); peer.close(); });

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(`${B}/a2a/jsonrpc`, { method: 'POST', headers: { ...H, 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}

async function relayTenant(): Promise<string> {
  const inv = (await (await fetch(`${B}/agents`, { headers: H })).json()) as { agents: Array<{ a2aTenant?: string }> };
  for (const a of inv.agents) {
    if (a.a2aTenant === undefined) continue;
    const card = await rpc('GetExtendedAgentCard', { tenant: a.a2aTenant });
    const skills = (card.result?.skills ?? []) as Array<{ id: string }>;
    if (skills.length === 1 && skills[0]!.id === RELAY_WORKFLOW_ID) return a.a2aTenant;
  }
  throw new Error('no agent card routes only the relay');
}

describe('purpose labels on the relay hop', () => {
  it('advertises purposePropagation and the fixture only when the relay can run', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    expect(d.purposePropagation).toMatchObject({ propagatesOnward: true, witness: 'witnessable-gated' });
    expect(d.fixtures).toContain(RELAY_WORKFLOW_ID);
  });

  it('re-emits the inbound label on the onward message, with the inbound text', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const tenant = await relayTenant();
    const before = received.length;
    const r = await rpc('SendMessage', { tenant, message: { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'relay n-1' }], metadata: { openwop: { permittedPurposes: LABEL } } } });
    expect(r.error).toBeUndefined();
    const sent = received.slice(before).find((x) => x.method === 'SendMessage');
    expect(sent?.params.message.parts).toEqual([{ text: 'relay n-1' }]);
    expect(sent?.params.message.metadata.openwop.permittedPurposes).toEqual(LABEL);
  });

  it('sends nothing for [], while an unlabelled message goes through', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const tenant = await relayTenant();
    const before = received.length;
    await rpc('SendMessage', { tenant, message: { messageId: 'm-2', role: 'ROLE_USER', parts: [{ text: 'relay n-2' }] } });
    expect(received.length - before).toBe(1);
    const r = await rpc('SendMessage', { tenant, message: { messageId: 'm-3', role: 'ROLE_USER', parts: [{ text: 'relay n-3' }], metadata: { openwop: { permittedPurposes: [] } } } });
    expect(r.result?.task?.status?.state).toBe('TASK_STATE_FAILED');
    expect(received.length - before).toBe(1);
  });

  it('refuses a label that is not an array of strings', async () => {
    if (!running.host.artifacts.agentCardsFacet) return;
    const tenant = await relayTenant();
    const r = await rpc('SendMessage', { tenant, message: { messageId: 'm-4', role: 'ROLE_USER', parts: [{ text: 'x' }], metadata: { openwop: { permittedPurposes: 'analytics' } } } });
    expect(r.error?.code).toBe(-32602);
  });
});
