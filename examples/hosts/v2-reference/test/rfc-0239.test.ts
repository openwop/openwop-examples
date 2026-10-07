/**
 * RFC 0239 — the council roster (conversation.md §multiPartyConversation).
 * The suite's v2-multi-party-council scenario witnesses it; this file pins the
 * host's half on whatever contract is installed: the roster carried on
 * `conversation.opened`, a non-member's turn refused and left unconsumed, a
 * member's turn accepted, and the oversized roster refused at creation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { MAX_PARTICIPANTS } from '../src/council.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0239';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };
const COUNCIL = 'conformance-multi-party-council';

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

async function run(runId: string): Promise<any> {
  return (await fetch(`${B}/runs/${encodeURIComponent(runId)}`, { headers: H })).json();
}
async function events(runId: string): Promise<any[]> {
  return ((await (await fetch(`${B}/runs/${encodeURIComponent(runId)}/events/poll`, { headers: H })).json()) as any).events;
}
async function settle(runId: string, until: (s: string) => boolean): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const s = (await run(runId)).status as string;
    if (until(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await run(runId)).status as string;
}
const turn = (runId: string, speakerId: string) =>
  fetch(`${B}/runs/${encodeURIComponent(runId)}/interrupts/convo`, { method: 'POST', headers: H, body: JSON.stringify({ resumeValue: { role: 'agent', speakerId, content: 'a turn' } }) });

describe('RFC 0239 — the council roster', () => {
  it('advertises multiPartyConversation with a ceiling below the 64-member fixture', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    if (!d.fixtures.includes(COUNCIL)) return; // the installed suite ships no council fixture
    expect(d.multiPartyConversation).toMatchObject({ witness: 'witnessable-gated', maxParticipants: MAX_PARTICIPANTS });
    expect(MAX_PARTICIPANTS).toBeLessThan(64);
  });

  it('carries the roster, refuses a non-member unconsumed, then accepts a member', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    if (!d.fixtures.includes(COUNCIL)) return;
    const c = await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: COUNCIL }) });
    expect(c.status).toBe(201);
    const runId = ((await c.json()) as any).runId as string;
    expect(await settle(runId, (s) => s === 'waiting-input')).toBe('waiting-input');
    const opened = (await events(runId)).find((e) => e.type === 'conversation.opened');
    expect(opened.payload.participants.map((p: any) => p.agentId)).toEqual(['host:conformance-council-a', 'host:conformance-council-b', 'host:conformance-council-c']);

    const refused = await turn(runId, 'host:conformance-intruder');
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as any;
    expect(body.error).toBe('conversation_speaker_not_participant');
    expect(body.details.speakerId).toBe('host:conformance-intruder');
    expect((await run(runId)).status).toBe('waiting-input');
    expect((await events(runId)).some((e) => e.type === 'conversation.exchanged')).toBe(false);

    expect((await turn(runId, 'host:conformance-council-a')).status).toBe(200);
    expect(await settle(runId, (s) => s === 'completed')).toBe('completed');
    const types = (await events(runId)).map((e) => e.type).filter((t: string) => t.startsWith('conversation.'));
    expect(types).toEqual(['conversation.opened', 'conversation.exchanged', 'conversation.closed']);
  });

  it('refuses the oversized roster at creation, never truncating it', async () => {
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    if (!d.fixtures.includes(`${COUNCIL}-oversize`)) return;
    const c = await fetch(`${B}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: `${COUNCIL}-oversize` }) });
    expect(c.status).toBe(422);
    const body = (await c.json()) as any;
    expect(body.error).toBe('conversation_roster_exceeded');
    expect(body.details.maxParticipants).toBe(MAX_PARTICIPANTS);
  });
});
