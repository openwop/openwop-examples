/**
 * RFC 0205 — getArtifact Accept negotiation and the conformance mock conversation.
 * The artifact read itself is witnessed by the suite's v2-artifact-a2a-shape
 * scenario (it needs the corpus 2.36.0 `conformance-artifact-emit` fixture);
 * this file pins the negotiation rule and the conversation gate on whatever
 * contract is installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { corpusHasParts, prefersA2a } from '../src/run-artifacts.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0205';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('RFC 0205 §A — Accept negotiation', () => {
  it('prefers the A2A shape only when Accept ranks it above application/json', () => {
    expect(prefersA2a('application/a2a+json')).toBe(true);
    expect(prefersA2a('application/a2a+json, application/json;q=0.5')).toBe(true);
    expect(prefersA2a('application/json, application/a2a+json;q=0.5')).toBe(false);
    expect(prefersA2a('application/json, application/a2a+json')).toBe(false); // a tie keeps today's answer
    expect(prefersA2a('application/json')).toBe(false);
    expect(prefersA2a('*/*')).toBe(false);
    expect(prefersA2a('application/a2a+json;q=0')).toBe(false);
    expect(prefersA2a(null)).toBe(false);
  });
});

describe('runs.md §Conversation — the conformance mock conversation', () => {
  it('v2 advertises conversationPrimitive and runs open → exchanged → closed; the v1 contract refuses the gate', async () => {
    const d2 = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as any;
    if (!d2.fixtures.includes('conformance-conversation-lifecycle')) return; // the installed suite ships no conversation fixture
    expect(d2.conversationPrimitive?.witness).toBe('claims-check');
    const d1 = await (await fetch(`${B}/.well-known/openwop`)).json() as any;
    expect(d1.fixtures).not.toContain('conformance-conversation-lifecycle');
    const v1 = await fetch(`${B}/v1/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: 'conformance-conversation-lifecycle' }) });
    expect(v1.status).toBe(422);
    expect(((await v1.json()) as any).details?.requiredCapability).toBe('conversationPrimitive');
    const c = await fetch(`${B}/runs`, { method: 'POST', headers: { ...H, 'OpenWOP-Version': '2.0' }, body: JSON.stringify({ workflowId: 'conformance-conversation-lifecycle' }) });
    expect(c.status).toBe(201);
    const runId = ((await c.json()) as any).runId as string;
    let events: any[] = [];
    for (let i = 0; i < 80; i++) {
      const p = await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: { ...H, 'OpenWOP-Version': '2.0' } })).json() as any;
      events = p.events; if (p.isTerminal) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const types = events.map((e) => e.type).filter((t: string) => t.startsWith('conversation.'));
    expect(types).toEqual(['conversation.opened', 'conversation.exchanged', 'conversation.closed']);
    const turn = events.find((e) => e.type === 'conversation.exchanged').payload.turn;
    if (corpusHasParts(running.host)) expect(turn.parts).toEqual([{ text: turn.content }]);
    else expect(turn.parts).toBeUndefined();
  });
});
