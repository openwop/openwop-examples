/**
 * RFC 0241 — the normative host-event trigger (`POST /host/events/test`).
 * The suite's v2-host-event-delivery scenario witnesses it; this file pins the
 * host's half on whatever contract is installed: with the seams profile off the
 * reserved `host-test.*` types are listed, the trigger emits one to the caller's
 * own stream with an empty payload, and an unknown class is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';
import { TEST_TYPES } from '../src/host-events.js';

let running: RunningHost;
let B = '';
const K = 'test-key-0241';
const H = { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2.0' };

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', rateLimitPerMinute: 100_000, seamsProfile: false });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('RFC 0241 — the host-event trigger', () => {
  it('lists the reserved types without seams, and emits a test event to the caller’s own stream', async () => {
    if (!running.host.artifacts.hostEventTrigger) {
      // The installed contract predates RFC 0241: nothing is listed and nothing is served.
      expect((await fetch(`${B}/host/events/test`, { method: 'POST', headers: H, body: JSON.stringify({ delivery: 'durable' }) })).status).toBe(404);
      return;
    }
    const d = (await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json()) as any;
    expect(d.hostEvents.types).toEqual(expect.arrayContaining([{ type: TEST_TYPES.durable, delivery: 'durable' }, { type: TEST_TYPES.ephemeral, delivery: 'ephemeral' }]));
    expect(d.conformance).toBeUndefined();

    const ac = new AbortController();
    const stream = await fetch(`${B}/host/events`, { headers: H, signal: ac.signal });
    const reader = stream.body!.getReader();
    const r = await fetch(`${B}/host/events/test`, { method: 'POST', headers: H, body: JSON.stringify({ delivery: 'durable' }) });
    expect(r.status).toBe(202);
    const { eventId, type } = (await r.json()) as { eventId: string; type: string };
    expect(type).toBe(TEST_TYPES.durable);
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes(eventId) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ac.abort();
    const frame = text.split('\n\n').find((f) => f.includes(eventId))!;
    expect(frame).toContain(`event: ${TEST_TYPES.durable}`);
    expect(frame).toContain(`id: ${eventId}`);
    expect(JSON.parse(frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6)).payload).toEqual({});
  });

  it('refuses a class outside the enum, and a workspace of another tenant', async () => {
    if (!running.host.artifacts.hostEventTrigger) return;
    const bad = await fetch(`${B}/host/events/test`, { method: 'POST', headers: H, body: JSON.stringify({ delivery: 'loud' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe('validation_error');
    const foreign = await fetch(`${B}/host/events/test`, { method: 'POST', headers: H, body: JSON.stringify({ delivery: 'durable', workspaceId: 'someone-else/ws-1' }) });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as any).error).toBe('id_tenant_mismatch');
  });
});
