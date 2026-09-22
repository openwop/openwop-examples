/**
 * Route-level harness: boots the host on a random port with an in-memory
 * store and strict dev-mode schema validation, and smoke-tests every route
 * the host mounts. The conformance suite is the witness; this is the
 * regression net under it (`npm test`).
 */
import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../src/server.js';

let running: RunningHost;
let B = '';
const K = 'test-key-routes';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
const enc = encodeURIComponent;

interface Res { s: number; h: Headers; b: any }
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const init: RequestInit = { method, headers: { ...H, ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' || Buffer.isBuffer(body) ? (body as never) : JSON.stringify(body);
  const r = await fetch(`${B}${path}`, init);
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  return { s: r.status, h: r.headers, b };
}
async function waitStatus(runId: string, wanted: string[], timeoutMs = 8000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', `/runs/${enc(runId)}`);
    if (wanted.includes(r.b?.status) || Date.now() > deadline) return r.b;
    await new Promise((res) => setTimeout(res, 100));
  }
}

function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8'); h.write('0000644\0', 100, 8); h.write('0000000\0', 108, 8); h.write('0000000\0', 116, 8);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12); h.write('00000000000\0', 136, 12); h.write('        ', 148, 8); h.write('0', 156, 1); h.write('ustar\0', 257, 6); h.write('00', 263, 2);
  let sum = 0; for (const b of h) sum += b; h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
}
function pack(manifest: Record<string, unknown>): Buffer {
  return gzipSync(Buffer.concat([tarEntry('pack.json', Buffer.from(JSON.stringify(manifest))), tarEntry('index.mjs', Buffer.from('export default {};\n')), Buffer.alloc(1024, 0)]));
}

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: true, webhookBackoffBaseMs: 20, webhookMaxAttempts: 3, rateLimitPerMinute: 100_000 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('discovery + negotiation', () => {
  it('header-less is the preferred (v1) representation; OpenWOP-Version: 2 is the closed root; both carry protocolVersions and an ETag', async () => {
    const v1 = await fetch(`${B}/.well-known/openwop`);
    const v2 = await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } });
    expect(v1.headers.get('openwop-version')).toBe('1.11');
    expect(v2.headers.get('openwop-version')).toBe('2.0');
    const d1 = await v1.json() as any; const d2 = await v2.json() as any;
    expect(d1.protocolVersions).toEqual(['1.11', '2.0']);
    expect(d2.protocolVersions).toEqual(d1.protocolVersions);
    expect(d2.capabilities).toBeUndefined();
    expect(d2.profiles).toBeUndefined();
    expect(d2.conformance.seamsProfile).toBe('openwop-conformance-seams-v2');
    expect(d2.webhooks.retryPolicy).toEqual({ maxAttempts: 3, backoff: 'exponential' });
    const etag = v2.headers.get('etag') as string;
    const again = await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0', 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(v2.headers.get('capabilities-etag')).toBeNull();
  });
  it('406 for an unlisted major, 400 for a header on a /v1/ path, 426 below minClientVersion', async () => {
    const r406 = await call('GET', '/.well-known/openwop', undefined, { 'OpenWOP-Version': '9.0' });
    expect(r406.s).toBe(406); expect(r406.b.error).toBe('protocol_version_unsupported'); expect(r406.b.details.protocolVersions).toEqual(['1.11', '2.0']);
    const r400 = await call('GET', '/v1/openapi.json', undefined, { 'OpenWOP-Version': '2.0' });
    expect(r400.s).toBe(400); expect(r400.b.error).toBe('protocol_version_mismatch'); expect(r400.h.get('openwop-version')).toBe('1.11');
    const r426 = await call('GET', '/.well-known/openwop', undefined, { 'OpenWOP-Client-Version': '0.0.1' });
    expect(r426.s).toBe(426); expect(r426.b.error).toBe('client_version_unsupported');
  });
  it('serves /openapi.json under both majors and /.well-known/wop only under v1', async () => {
    expect((await call('GET', '/openapi.json')).s).toBe(200);
    expect((await call('GET', '/v1/openapi.json', undefined, { 'OpenWOP-Version': '1' })).s).toBe(200);
    expect((await call('GET', '/.well-known/wop')).s).toBe(404);
  });
});

describe('runs', () => {
  it('creates, runs to completion, snapshots with owner.subject and era 3, polls with the closed shape', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-noop', tags: ['t1'], metadata: { m: 1 } });
    expect(c.s).toBe(201);
    const snap = await waitStatus(c.b.runId, ['completed']);
    expect(snap.status).toBe('completed');
    expect(snap.eventLogSchemaVersion).toBe(3);
    expect(snap.owner.subject.lane).toBe('api-key');
    expect(snap.compensationStatus).toBe('none');
    const p = await call('GET', `/runs/${enc(c.b.runId)}/events/poll?timeout=1`);
    expect(Object.keys(p.b).sort()).toEqual(['events', 'isTerminal', 'lastSequence', 'runId', 'status']);
    expect(p.b.events.map((e: any) => e.type)).toEqual(['run.started', 'node.started', 'node.completed', 'run.completed']);
    expect(p.b.events[0].sequence).toBe(0);
    expect((await call('GET', `/runs/${enc(c.b.runId)}/events/poll?timeout=1&afterSequence=99`)).b.events).toEqual([]);
    const e = await call('GET', `/runs/${enc(c.b.runId)}/effects`); expect(e.s).toBe(200); expect(e.b.effects).toEqual([]);
    const comp = await call('GET', `/runs/${enc(c.b.runId)}/compensation`); expect(comp.b.status).toBe('none');
    const anc = await call('GET', `/runs/${enc(c.b.runId)}/ancestry`); expect(anc.b.parent).toBeNull();
    expect((await call('GET', '/runs/does-not-exist')).s).toBe(404);
  });
  it('refuses a closed-body violation, a dotted configurable key and a bad Idempotency-Key; replays an idempotent create', async () => {
    expect((await call('POST', '/runs', { workflowId: 'conformance-noop', bogus: 1 })).b.error).toBe('validation_error');
    // RFC 0196 §A.2: no callback delivery is advertised, so callbackUrl is refused, never accepted and ignored.
    const cb = await call('POST', '/runs', { workflowId: 'conformance-noop', callbackUrl: 'https://hooks.example.com/approve' });
    expect(cb.s).toBe(400);
    expect(cb.b.error).toBe('validation_error');
    expect(cb.b.details?.field).toBe('callbackUrl');
    expect((await call('POST', '/runs', { workflowId: 'conformance-noop', configurable: { version: 1, ai: { 'ai.provider': 'x' } } })).b.error).toBe('validation_error');
    expect((await call('POST', '/runs', { workflowId: 'conformance-noop' }, { 'Idempotency-Key': 'short' })).b.error).toBe('idempotency_key_invalid');
    const key = 'routes-harness-key-000001';
    const a = await call('POST', '/runs', { workflowId: 'conformance-noop' }, { 'Idempotency-Key': key });
    const b = await call('POST', '/runs', { workflowId: 'conformance-noop' }, { 'Idempotency-Key': key });
    expect(b.b.runId).toBe(a.b.runId); expect(b.h.get('openwop-idempotent-replay')).toBe('true');
    const c = await call('POST', '/runs', { workflowId: 'conformance-delay' }, { 'Idempotency-Key': key });
    expect(c.s).toBe(409); expect(c.b.error).toBe('idempotency_key_mismatch');
  });
  it('binds ids to the tenant', async () => {
    const r = await call('GET', `/runs/${enc('other-tenant/foreignopaque0123456789abcdef')}`);
    expect(r.s).toBe(403); expect(r.b.error).toBe('id_tenant_mismatch');
  });

  it('lists the caller\'s runs newest first, bound ids, keyset cursor, exact filters; refuses a foreign cursor (RFC 0182)', async () => {
    const a = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    const b = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    expect(a.s).toBe(201); expect(b.s).toBe(201);
    // page of 1: newest first, a cursor to the next page, every id bound
    const p1 = await call('GET', '/runs?limit=1');
    expect(p1.s).toBe(200); expect(p1.b.runs).toHaveLength(1); expect(typeof p1.b.nextCursor).toBe('string');
    expect(p1.b.runs[0].runId).toBe(b.b.runId);
    const p2 = await call('GET', `/runs?limit=1&cursor=${enc(p1.b.nextCursor)}`);
    expect(p2.s).toBe(200); expect(p2.b.runs[0].runId).toBe(a.b.runId);
    for (const r of [...p1.b.runs, ...p2.b.runs]) expect(r.runId.startsWith('openwop-reference-tenant/')).toBe(true);
    // the unfiltered walk contains both; the cap holds
    const all = await call('GET', '/runs?limit=100');
    expect(all.s).toBe(200); expect(all.b.runs.length).toBeLessThanOrEqual(100);
    const ids = all.b.runs.map((r: { runId: string }) => r.runId);
    expect(ids).toContain(a.b.runId); expect(ids).toContain(b.b.runId);
    // exact filters
    const wf = await call('GET', '/runs?workflowId=conformance-noop&limit=100');
    expect(wf.b.runs.every((r: { workflowId: string }) => r.workflowId === 'conformance-noop')).toBe(true);
    expect((await call('GET', '/runs?workflowId=no-such-workflow-xyz')).b.runs).toEqual([]);
    expect((await call('GET', '/runs?status=bogus')).s).toBe(400);
    // a cursor this host did not mint, and a tampered one, are refused — never interpreted
    const bad = await call('GET', '/runs?cursor=not-a-cursor');
    expect(bad.s).toBe(400); expect(bad.b.error).toBe('validation_error');
    const tampered = Buffer.from(Buffer.from(p1.b.nextCursor, 'base64url').toString('utf8').replace(/\|[^|]*$/, '|AAAA')).toString('base64url');
    expect((await call('GET', `/runs?cursor=${enc(tampered)}`)).s).toBe(400);
    // major 2 only: there was never a v1 list
    expect((await call('GET', '/v1/runs', undefined, { 'OpenWOP-Version': '1.0' })).s).toBe(404);
  });
  it('cancels a delay mid-flight and pauses/resumes', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-cancellable', inputs: { delayMs: 20000 } });
    await new Promise((r) => setTimeout(r, 150));
    // runs.md §Pause and resume: the default `drain-current-node` lets the 20 s
    // delay node finish first; `immediate` is the policy that pauses NOW.
    const p = await call('POST', `/runs/${enc(c.b.runId)}:pause`, { drainPolicy: 'immediate' }); expect(p.s).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    expect((await call('GET', `/runs/${enc(c.b.runId)}`)).b.status).toBe('paused');
    const pausedEv = (await call('GET', `/runs/${enc(c.b.runId)}/events/poll?timeout=1&streamMode=debug`)).b.events.find((e: any) => e.type === 'run.paused');
    expect(pausedEv?.payload?.drainPolicy).toBe('immediate');
    expect((await call('POST', `/runs/${enc(c.b.runId)}:pause`, {})).s).toBe(409);
    expect((await call('POST', `/runs/${enc(c.b.runId)}:resume`, {})).s).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    const x = await call('POST', `/runs/${enc(c.b.runId)}/cancel`, {}); expect([200]).toContain(x.s);
    const snap = await waitStatus(c.b.runId, ['cancelled']);
    expect(snap.status).toBe('cancelled');
    const bulk = await call('POST', '/runs:bulk-cancel', { runIds: [c.b.runId, 'other-tenant/foreignopaque0123456789abcdef'] });
    expect(bulk.b.results[1].ok).toBe(false);
  });
  it('fails a run on core.fail and records an annotation side-store', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-failure' });
    const snap = await waitStatus(c.b.runId, ['failed']);
    expect(snap.status).toBe('failed'); expect(snap.error.code).toBe('fixture_failure');
    const a = await call('POST', `/runs/${enc(c.b.runId)}/annotations`, { signal: { kind: 'label', label: 'x' }, note: 'sk-abcdefghijklmnop' });
    expect(a.s).toBe(201); expect(a.b.note).toBe('[redacted]');
    expect((await call('GET', `/runs/${enc(c.b.runId)}/annotations`)).b.annotations.length).toBe(1);
    const poll = await call('GET', `/runs/${enc(c.b.runId)}/events/poll?timeout=1`);
    expect(poll.b.events.some((e: any) => e.type === 'run.annotated')).toBe(false);
  });
});

describe('interrupts', () => {
  it('suspends on an approval gate, refuses a non-listed approver, resolves by run and by token', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-approval-approvers' });
    expect((await waitStatus(c.b.runId, ['waiting-approval'])).status).toBe('waiting-approval');
    const refused = await call('POST', `/runs/${enc(c.b.runId)}/interrupts/gate`, { resumeValue: { action: 'accept' } });
    expect(refused.s).toBe(403); expect(refused.b.error).toBe('forbidden');
    expect((await call('GET', `/runs/${enc(c.b.runId)}`)).b.status).toBe('waiting-approval');
    const c2 = await call('POST', '/runs', { workflowId: 'conformance-approval' });
    await waitStatus(c2.b.runId, ['waiting-approval']);
    const tok = (await call('GET', `/runs/${enc(c2.b.runId)}/interrupts/gate`)).b.token as string;
    expect(tok.startsWith('ow2.hs256.v2-reference-1.')).toBe(true);
    const inspect = await fetch(`${B}/interrupts/${enc(tok)}`, { headers: { 'OpenWOP-Version': '2.0' } });
    expect(inspect.status).toBe(200); expect(((await inspect.json()) as any).kind).toBe('approval');
    expect((await call('POST', `/runs/${enc(c2.b.runId)}/interrupts/gate`, { resumeValue: { action: 'bogus' } })).b.error).toBe('validation_error');
    const ok = await fetch(`${B}/interrupts/${enc(tok)}`, { method: 'POST', headers: { 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
    expect(ok.status).toBe(200);
    expect((await waitStatus(c2.b.runId, ['completed'])).status).toBe('completed');
    expect((await call('POST', `/runs/${enc(c2.b.runId)}/interrupts/gate`, { resumeValue: { action: 'accept' } })).b.error).toBe('interrupt_already_resolved');
    const again = await fetch(`${B}/interrupts/${enc(tok)}`, { headers: { 'OpenWOP-Version': '2.0' } });
    expect(again.status).toBe(409);
    const bad = await fetch(`${B}/interrupts/${enc('ow2.hs256.nokid.abc.def')}`, { headers: { 'OpenWOP-Version': '2.0' } });
    expect(bad.status).toBe(401); expect(((await bad.json()) as any).error).toBe('interrupt_token_invalid');
  });
  it('clarification and external-event interrupts resolve with the run-scoped surface', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-clarification' });
    expect((await waitStatus(c.b.runId, ['waiting-input'])).status).toBe('waiting-input');
    expect((await call('POST', `/runs/${enc(c.b.runId)}/interrupts/ask`, { resumeValue: { q1: 'blue' } })).s).toBe(200);
    expect((await waitStatus(c.b.runId, ['completed'])).status).toBe('completed');
    const e = await call('POST', '/runs', { workflowId: 'conformance-interrupt-external-event' });
    expect((await waitStatus(e.b.runId, ['waiting-external'])).status).toBe('waiting-external');
    expect((await call('POST', `/runs/${enc(e.b.runId)}/interrupts/wait-for-external`, { resumeValue: { ok: true } })).s).toBe(200);
    expect((await waitStatus(e.b.runId, ['completed'])).status).toBe('completed');
  });
});

describe('persistence + replay', () => {
  const t0 = Date.parse('2026-01-15T10:00:00.000Z');
  const ts = (i: number) => new Date(t0 + i * 1000).toISOString();
  const log = [
    { type: 'run.started', sequence: 0, payload: { workflowId: 'conformance-noop' }, timestamp: ts(0) },
    { type: 'agent.toolCalled', sequence: 1, payload: { agentId: 'a', toolName: 'echo', callId: 'c1' }, timestamp: ts(1) },
    { type: 'agent.toolReturned', sequence: 2, payload: { agentId: 'a', toolName: 'echo', callId: 'c1', status: 'ok' }, timestamp: ts(2) },
    { type: 'run.completed', sequence: 3, payload: { durationMs: 3000 }, timestamp: ts(3) },
  ];
  it('translates an era-2 log at the boundary (poll, SSE, fork) and legacy-stamps the owner', async () => {
    const s = await call('POST', '/conformance/seams/sample/event-log/seed', { eventLogSchemaVersion: 2, status: 'completed', events: log });
    expect(s.s).toBe(201);
    const snap = await call('GET', `/runs/${enc(s.b.runId)}`);
    expect(snap.b.eventLogSchemaVersion).toBe(2); expect(snap.b.owner.subject.issuer).toBe('urn:openwop:legacy');
    const p = await call('GET', `/runs/${enc(s.b.runId)}/events/poll?timeout=1`);
    expect(p.b.events.map((e: any) => e.type)).toEqual(['run.started', 'agent.tool-called', 'agent.tool-returned', 'run.completed']);
    expect(p.b.events[0].payload.owner.subject.issuer).toBe('urn:openwop:legacy');
    const sse = await fetch(`${B}/runs/${enc(s.b.runId)}/events?streamMode=debug`, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0' } });
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await sse.text()).split('\n').filter((l) => l.startsWith('event:'));
    expect(frames).toEqual(['event: run.started', 'event: agent.tool-called', 'event: agent.tool-returned', 'event: run.completed']);
    const f = await call('POST', `/runs/${enc(s.b.runId)}:fork`, { mode: 'replay', fromSeq: 3 });
    expect(f.s).toBe(201);
    await waitStatus(f.b.runId, ['completed', 'failed']);
    const fp = await call('GET', `/runs/${enc(f.b.runId)}/events/poll?timeout=1`);
    expect(fp.b.events.slice(0, 3).map((e: any) => [e.type, e.sequence])).toEqual([['run.started', 0], ['agent.tool-called', 1], ['agent.tool-returned', 2]]);
    expect(fp.b.events[0].payload.owner.subject.issuer).toBe('urn:openwop:legacy');
    expect((await call('GET', `/runs/${enc(f.b.runId)}`)).b.eventLogSchemaVersion).toBe(3);
  });
  it('the writer rule: an append to an open era-2 run is stored in v1 vocabulary and does not promote the era', async () => {
    const { toStorageVocabulary } = await import('../src/codemap.js');
    // The pure mapping, over the three shapes the codemap has.
    expect(toStorageVocabulary('agent.tool-called', 2)).toBe('agent.toolCalled');   // renamed
    expect(toStorageVocabulary('run.cancelled', 2)).toBe('run.cancelled');          // identity
    expect(toStorageVocabulary('agent.tool-called', 3)).toBe('agent.tool-called');  // era 3 stores v2
    expect(() => toStorageVocabulary('openwop.not-a-type', 2)).toThrow(/refusing to append/);

    // End to end: seed an OPEN era-2 run, let the host's own writer append.
    const s = await call('POST', '/conformance/seams/sample/event-log/seed', { eventLogSchemaVersion: 2, status: 'running', events: log.slice(0, 2) });
    expect(s.s).toBe(201);
    const runId = s.b.runId as string;
    const before = (await call('GET', `/runs/${enc(runId)}/events/poll?timeout=1`)).b.events.length;
    expect((await call('POST', `/runs/${enc(runId)}/cancel`, {})).s).toBe(200);
    const after = await call('GET', `/runs/${enc(runId)}/events/poll?timeout=1`);
    expect(after.s).toBe(200);
    expect(after.b.events.length).toBeGreaterThan(before);
    // The whole log still reads, in v2 names, with a contiguous sequence space.
    expect(after.b.events.map((e: any) => e.type)).toEqual(['run.started', 'agent.tool-called', 'run.cancelled']);
    expect(after.b.events.map((e: any) => e.sequence)).toEqual([0, 1, 2]);
    // The era key is fixed at creation: the append did not promote it to 3.
    expect((await call('GET', `/runs/${enc(runId)}`)).b.eventLogSchemaVersion).toBe(2);
  });

  it('refuses an unmapped type on every reader and cancels an unsupported pin', async () => {
    const s = await call('POST', '/conformance/seams/sample/event-log/seed', { eventLogSchemaVersion: 2, status: 'completed', events: [log[0], { type: 'foo.bar', sequence: 1, payload: {}, timestamp: ts(1) }] });
    const p = await call('GET', `/runs/${enc(s.b.runId)}/events/poll?timeout=1`);
    expect(p.s).toBe(500); expect(p.b.error).toBe('event_type_unmapped');
    expect((await call('POST', `/runs/${enc(s.b.runId)}:fork`, { mode: 'replay', fromSeq: 1 })).b.error).toBe('event_type_unmapped');
    const pinned = await call('POST', '/conformance/seams/sample/event-log/seed', { eventLogSchemaVersion: 2, status: 'running', events: [log[0], { type: 'version.pinned', sequence: 1, payload: { changeId: 'nope', version: 1 }, timestamp: ts(1) }] });
    const snap = await call('GET', `/runs/${enc(pinned.b.runId)}`);
    expect(snap.b.status).toBe('cancelled');
    const ev = (await call('GET', `/runs/${enc(pinned.b.runId)}/events/poll?timeout=1`)).b.events;
    expect(ev.find((e: any) => e.type === 'run.cancelled').payload).toMatchObject({ reason: 'v1_pin_unsupported', cancelledBy: 'v2-cutover' });
    expect(ev.find((e: any) => e.type === 'version.pinned').payload.changeId).toBe('nope');
  });
  it('replay-forks a real run from 0 with owner copied, refuses replay with an overlay, and branch requires fromSeq', async () => {
    const c = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    await waitStatus(c.b.runId, ['completed']);
    expect((await call('POST', `/runs/${enc(c.b.runId)}:fork`, { mode: 'replay', runOptionsOverlay: { tags: ['x'] } })).s).toBe(400);
    expect((await call('POST', `/runs/${enc(c.b.runId)}:fork`, { mode: 'branch' })).s).toBe(400);
    const f = await call('POST', `/runs/${enc(c.b.runId)}:fork`, { mode: 'replay' });
    expect(f.s).toBe(201); expect(f.b.fromSeq).toBe(0);
    const snap = await waitStatus(f.b.runId, ['completed']);
    expect(snap.owner).toEqual((await call('GET', `/runs/${enc(c.b.runId)}`)).b.owner);
    expect((await call('GET', `/runs/${enc(f.b.runId)}/ancestry`)).b.parent.runId).toBe(c.b.runId);
    const m = await call('GET', '/host/effect-seams');
    expect(m.b.seams.every((s: any) => s.guarded === true)).toBe(true);
    const bad = await call('POST', `/runs/${enc(c.b.runId)}:fork`, { mode: 'branch', fromSeq: 999 });
    expect(bad.s).toBe(422); expect(bad.b.error).toBe('fork_point_invalid');
  });

  it('fires a named effect seam inside a run and suppresses it on the replay fork', async () => {
    const fired = await call('POST', '/conformance/seams/sample/effect-seams/fire', { seam: 'http.fetch' });
    expect(fired.s).toBe(201);
    const parent = await call('GET', `/runs/${enc(fired.b.runId)}/effects`);
    expect(parent.s).toBe(200);
    expect(parent.b.effects.length).toBe(1);
    expect(parent.b.effects[0].keying).toBe('business-identity');
    expect(parent.b.effects[0].attempt).toBe(1);
    const forked = await call('POST', `/runs/${enc(fired.b.runId)}:fork`, { mode: 'replay' });
    expect(forked.s).toBe(201);
    await waitStatus(forked.b.runId, ['completed', 'failed']);
    const fork = await call('GET', `/runs/${enc(forked.b.runId)}/effects`);
    expect(fork.b.effects.length).toBeLessThanOrEqual(parent.b.effects.length);
    expect(fork.b.effects[0]?.effectId).toBe(parent.b.effects[0].effectId);
    expect((await call('POST', '/conformance/seams/sample/effect-seams/fire', { seam: 'nope.nope' })).s).toBe(404);
  });

  it('retries one effect at the transport layer under a single identity', async () => {
    const r = await call('POST', '/conformance/seams/sample/test/idempotency/effect-retry', { providerUrl: 'http://127.0.0.1:1/' });
    expect(r.s).toBe(201);
    expect(typeof r.b.effectId).toBe('string');
    const ledger = await call('GET', `/runs/${enc(r.b.runId)}/effects`);
    const attempts = ledger.b.effects.filter((e: any) => e.effectId === r.b.effectId);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((a: any) => a.providerKey)).size).toBe(1);
    expect(attempts.every((a: any) => a.keying === 'business-identity')).toBe(true);
    expect(attempts.map((a: any) => a.attempt).sort()).toEqual([1, 2]);
  });
});

describe('webhooks + identity + packs + workspace', () => {
  it('delivers with both header families, retries and dead-letters, and verifies inbound v1 deliveries', async () => {
    const { createServer } = await import('node:http');
    const hits: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    let fail = 2;
    const srv = createServer((req, res) => { let body = ''; req.on('data', (c: Buffer) => { body += c.toString(); }); req.on('end', () => { hits.push({ headers: req.headers as never, body }); res.writeHead(fail-- > 0 ? 500 : 204); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    const reg = await call('POST', '/webhooks', { url, events: ['run.completed'], secret: 's3cret' });
    expect(reg.s).toBe(201);
    const c = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    await waitStatus(c.b.runId, ['completed']);
    for (let i = 0; i < 60 && hits.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const last = hits[hits.length - 1] as { headers: Record<string, string>; body: string };
    expect(last.headers['openwop-signature-algorithm']).toBe('v1');
    expect(last.headers['x-openwop-signature']).toBe(last.headers['openwop-signature']);
    expect(last.headers['openwop-signature']).toBe(`sha256=${createHmac('sha256', 's3cret').update(`${last.headers['openwop-timestamp']}.${last.body}`).digest('hex')}`);
    expect(JSON.parse(last.body).event.type).toBe('run.completed');
    // dead-letter: a receiver that always fails
    fail = 1e9; hits.length = 0;
    const c2 = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    await waitStatus(c2.b.runId, ['completed']);
    for (let i = 0; i < 80 && hits.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(hits.length).toBe(3);
    const dl = await call('GET', `/webhooks/${enc(reg.b.webhookId)}/dead-letters`);
    // RFC 0188 §A.1 — the page is closed over { deliveries, nextCursor }. This
    // read used to return a vendor shape (`deadLetters`, plus `webhookId` and
    // `retentionDays` at the root) that the canonical schema forbids.
    expect(Object.keys(dl.b).sort()).toEqual(['deliveries']);
    expect(dl.b.deliveries.length).toBe(1);
    const rec = dl.b.deliveries[0] as Record<string, unknown>;
    // §A.4 — nine required fields, and §B.1 closes the record: the old shape
    // carried `sequence` and `lastError`, and `lastError` held the subscriber's
    // response text, which is exactly the exchange a dead-letter read must not
    // replay.
    for (const k of ['deliveryId', 'webhookId', 'runId', 'eventId', 'eventType', 'attempts', 'deadLetteredAt', 'expiresAt', 'reason']) {
      expect(rec[k], `record MUST carry ${k}`).toBeDefined();
    }
    expect(rec['lastError']).toBeUndefined();
    expect(rec['sequence']).toBeUndefined();
    expect(rec['reason']).toBe('retries_exhausted');
    // `expiresAt - deadLetteredAt` MUST equal the advertised retention: that is
    // what turns the facet from an advertisement into an observable.
    const advertised = (await call('GET', '/.well-known/openwop')).b.webhooks.deadLetter;
    expect(Date.parse(rec['expiresAt'] as string) - Date.parse(rec['deadLetteredAt'] as string))
      .toBe((advertised.retentionDays as number) * 86_400_000);
    // §A.3 — a cursor minted for another subscription is refused, not interpreted.
    expect((await call('GET', `/webhooks/${enc(reg.b.webhookId)}/dead-letters?cursor=bm90LWEtY3Vyc29y`)).s).toBe(400);
    // §A.2 — the tenant segment is checked BEFORE the lookup, so a foreign-tenant
    // id that does not exist answers 403 and not 404.
    const foreignId = `not-the-callers-tenant/${(reg.b.webhookId as string).slice((reg.b.webhookId as string).indexOf('/') + 1)}`;
    const foreignDl = await call('GET', `/webhooks/${enc(foreignId)}/dead-letters`);
    expect(foreignDl.s).toBe(403); expect(foreignDl.b.error).toBe('id_tenant_mismatch');
    expect((await call('DELETE', `/webhooks/${enc(reg.b.webhookId)}`)).s).toBe(204);
    srv.close();
    const body = JSON.stringify({ runId: 'r', workspaceId: 'w', event: { type: 'run.completed', sequence: 1, payload: {} } });
    const t = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'k').update(`${t}.${body}`).digest('hex');
    const headers = { 'X-openwop-Webhook-Id': 'w', 'X-openwop-Event-Type': 'run.completed', 'X-openwop-Timestamp': t, 'X-openwop-Signature': `sha256=${sig}`, 'X-openwop-Signature-Algorithm': 'v1' };
    expect((await call('POST', '/conformance/seams/sample/webhooks/receive', { secret: 'k', headers, body })).b.accepted).toBe(true);
    expect((await call('POST', '/conformance/seams/sample/webhooks/receive', { secret: 'k', headers: { ...headers, 'X-openwop-Signature': 'sha256=00' }, body })).b.accepted).toBe(false);
  });
  it('rejects a private receiver with the registered webhook_url_rejected when the egress guard is on', async () => {
    const guarded = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: false });
    const post = async (url: string): Promise<{ s: number; b: any }> => {
      const r = await fetch(`http://127.0.0.1:${guarded.port}/webhooks`, { method: 'POST', headers: H, body: JSON.stringify({ url, events: ['run.completed'] }) });
      return { s: r.status, b: await r.json() };
    };
    try {
      for (const url of ['http://127.0.0.1:9/', 'https://169.254.169.254/', 'https://localhost/hook', 'http://example.com/hook']) {
        const r = await post(url);
        expect(r.s, url).toBe(400);
        expect(r.b.error, url).toBe('webhook_url_rejected');
      }
      expect((await post('https://receiver.example.com/hook')).s).toBe(201);
    } finally {
      await guarded.close();
    }
  });
  it('mints and revokes a next-request credential; resolves workload identity with the key-bound floor', async () => {
    const m = await call('POST', '/conformance/seams/sample/auth/credential/mint', { lane: 'session' });
    expect(m.s).toBe(201);
    expect((await call('GET', '/runs/does-not-exist', undefined, { Authorization: `Bearer ${m.b.credential}` })).s).toBe(404);
    expect((await call('POST', '/conformance/seams/sample/auth/credential/revoke', { lane: 'session', credential: m.b.credential })).s).toBe(200);
    const after = await call('GET', '/runs/does-not-exist', undefined, { Authorization: `Bearer ${m.b.credential}` });
    expect(after.s).toBe(401); expect(after.b.error).toBe('credential_revoked');
    expect((await call('GET', '/runs/does-not-exist', undefined, { Authorization: 'Bearer nope' })).b.error).toBe('unauthenticated');
    const id = { scheme: 'spiffe', subject: 'spiffe://example/x', issuer: 'spiffe://example', audience: 'openwop-host' };
    expect((await call('POST', '/conformance/seams/sample/test/workload-identity/resolve', { identity: id, expectedAudience: 'openwop-host' })).b.error).toBe('sender_constraint_missing');
    expect((await call('POST', '/conformance/seams/sample/test/workload-identity/resolve', { identity: { ...id, audience: 'other', keyBinding: { method: 'mtls' } }, expectedAudience: 'openwop-host' })).b.error).toBe('audience_mismatch');
    expect((await call('POST', '/conformance/seams/sample/test/workload-identity/resolve', { identity: { ...id, keyBinding: { method: 'mtls' } }, expectedAudience: 'openwop-host' })).b.assurance).toBe('key-bound');
  });
  it('installs packs through the test seam with the engine ceiling and peer-dependency checks', async () => {
    const put = (name: string, m: Record<string, unknown>) => call('PUT', `/conformance/seams/packs-test/${enc(name)}/-/1.0.0.tgz`, pack({ name, version: '1.0.0', kind: 'node', runtime: { language: 'javascript', entry: 'index.mjs', format: 'esm' }, nodes: [], ...m }), { 'Content-Type': 'application/octet-stream' });
    expect((await put('core.openwop.t-unbounded', { engines: { openwop: '>=1.0.0' } })).b.error).toBe('pack_engine_unsupported');
    expect((await put('core.openwop.t-v1', { engines: { openwop: '>=1.0.0 <2.0.0' } })).b.error).toBe('pack_engine_unsupported');
    expect((await put('core.openwop.t-peer', { engines: { openwop: '>=2.0.0 <3.0.0' }, peerDependencies: { 'host.nonexistent': 'required' } })).b.error).toBe('pack_peer_dependency_undefined');
    const ok = await put('core.openwop.t-ok', { engines: { openwop: '>=2.0.0 <3.0.0' }, peerDependencies: { replay: 'required' }, agents: [{ agentId: 'a', persona: 'p', modelClass: 'general', 'x-vendor-note': 'ignored' }] });
    expect(ok.s).toBe(201);
    expect((await put('core.openwop.t-ok', { engines: { openwop: '>=2.0.0 <3.0.0' }, peerDependencies: { replay: 'required' }, agents: [{ agentId: 'a', persona: 'p', modelClass: 'general', 'x-vendor-note': 'ignored' }] })).s).toBe(200);
    expect((await call('GET', `/conformance/seams/packs-test/${enc('core.openwop.t-ok')}/-/1.0.0.tgz`)).s).toBe(200);
    expect((await call('GET', `/conformance/seams/packs-test/${enc('core.openwop.t-ok')}/-/1.0.0.sig`)).b.error).toBe('signature_not_available');
    expect((await call('GET', '/packs')).b.packs).toEqual([]);
    expect((await call('DELETE', `/conformance/seams/packs-test/${enc('core.openwop.t-ok')}/-/1.0.0`)).s).toBe(204);
  });
  it('serves the minimal workspace seam and the host events channel', async () => {
    const p = await call('PUT', '/conformance/seams/workspace/files/notes.md', { content: 'hello' });
    expect(p.s).toBe(200); expect(p.b.version).toBe(1);
    expect((await call('PUT', '/conformance/seams/workspace/files/notes.md', { content: 'again' }, { 'If-Match': '"stale"' })).b.error).toBe('workspace_conflict');
    expect((await call('GET', '/conformance/seams/workspace/files')).b.files.length).toBe(1);
    expect((await call('GET', '/conformance/seams/workspace/files/notes.md')).b.content).toBe('hello');
    expect((await call('DELETE', '/conformance/seams/workspace/files/notes.md')).s).toBe(204);
    const ev = await fetch(`${B}/host/events`, { headers: { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0' }, signal: AbortSignal.timeout(300) }).catch(() => null);
    expect(ev?.status).toBe(200);
  });
});

describe('identity.md §5 bound-id path projection (RFC 0184) + per-contract delivery rendering (webhooks.md §Delivery)', () => {
  const project = (id: string): string => Array.from(new TextEncoder().encode(id)).map((b) => (b < 0x80 && /^[A-Za-z0-9._-]$/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');

  it('a tenant-bound run id is readable at its ~-escaped segment, links carry that form, %2F still works, a double projection is 404 and a malformed escape is 400', async () => {
    const created = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    expect(created.s).toBe(201);
    const runId: string = created.b.runId;
    expect(runId).toMatch(/^[^/]+\/[^/]+$/);
    const projected = project(runId);
    expect(created.b.eventsUrl).toContain(`/runs/${projected}/events`);
    expect(created.b.statusUrl).toContain(`/runs/${projected}`);
    expect(created.b.eventsUrl).not.toMatch(/%2F/i);
    const read = await call('GET', `/runs/${projected}`);
    expect(read.s).toBe(200);
    expect(read.b.runId).toBe(runId);
    const percent = await call('GET', `/runs/${enc(runId)}`);
    expect(percent.s).toBe(200);
    const doubled = await call('GET', `/runs/${project(projected)}`);
    expect(doubled.s).toBe(404);
    const malformed = await call('GET', `/runs/${runId.split('/')[0]}~2`);
    expect(malformed.s).toBe(400);
    expect(malformed.b.error).toBe('validation_error');
  });

  it('a major-1 reader gets the v1 owner echo (principal, never subject); a major-2 reader gets subject, never principal', async () => {
    const created = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    const runId: string = created.b.runId;
    await waitStatus(runId, ['completed']);
    const v2 = await call('GET', `/runs/${enc(runId)}/events/poll`);
    const startedV2 = v2.b.events.find((e: { type: string }) => e.type === 'run.started');
    expect(Object.keys(startedV2.payload.owner).sort()).toEqual(['subject', 'tenant']);
    const bare = runId.slice(runId.indexOf('/') + 1);
    const v1 = await call('GET', `/v1/runs/${enc(bare)}/events/poll`, undefined, { 'OpenWOP-Version': '1.0' });
    expect(v1.s).toBe(200);
    expect(v1.b.runId).toBe(bare);
    const startedV1 = v1.b.events.find((e: { type: string }) => e.type === 'run.started');
    expect('subject' in startedV1.payload.owner).toBe(false);
    expect(startedV1.payload.owner.principal).toMatch(/#/);
    expect(startedV1.payload.owner.principalKind).toBe('user');
    const snapV1 = await call('GET', `/v1/runs/${enc(bare)}`, undefined, { 'OpenWOP-Version': '1.0' });
    expect('subject' in snapV1.b.owner).toBe(false);
    expect(typeof snapV1.b.owner.principal).toBe('string');
  });

  it('a webhook subscription is delivered in the contract it registered under', async () => {
    const { createServer } = await import('node:http');
    const hits: Array<{ body: string }> = [];
    const srv = createServer((req, res) => { let body = ''; req.on('data', (c: Buffer) => { body += c.toString(); }); req.on('end', () => { hits.push({ body }); res.writeHead(204); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/hook`;
    const regV2 = await call('POST', '/webhooks', { url, events: ['run.started'] });
    const regV1 = await call('POST', '/v1/webhooks', { url, events: ['run.started'] }, { 'OpenWOP-Version': '1.0' });
    expect(regV2.s).toBe(201); expect(regV1.s).toBe(201);
    const created = await call('POST', '/runs', { workflowId: 'conformance-noop' });
    const runId: string = created.b.runId;
    await waitStatus(runId, ['completed']);
    const deadline = Date.now() + 5000;
    while (hits.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(hits.length).toBe(2);
    const bodies = hits.map((h) => JSON.parse(h.body) as { runId: string; event: { payload: { owner: Record<string, unknown> } } });
    const v2 = bodies.find((b) => b.runId === runId);
    const v1 = bodies.find((b) => b.runId === runId.slice(runId.indexOf('/') + 1));
    if (!v2 || !v1) throw new Error(`expected one delivery per contract; got runIds ${bodies.map((b) => b.runId).join(', ')}`);
    expect(Object.keys(v2.event.payload.owner).sort()).toEqual(['subject', 'tenant']);
    expect('subject' in v1.event.payload.owner).toBe(false);
    expect(typeof v1.event.payload.owner.principal).toBe('string');
    await call('DELETE', `/webhooks/${enc(regV2.b.webhookId)}`); await call('DELETE', `/v1/webhooks/${enc(regV1.b.webhookId)}`, undefined, { 'OpenWOP-Version': '1.0' });
    srv.close();
  });
});

describe('persistence.md §The v1 wire of an era-3 log — a renamed type reads in v1 spelling on /v1/ and v2 spelling on the v2 surface', () => {
  it('a seeded log carrying run.resuming reads as run.resume-started under major 2 and run.resuming under major 1, on poll, SSE and a 1.x webhook delivery', async () => {
    const { createServer } = await import('node:http');
    const hits: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const srv = createServer((req, res) => { let body = ''; req.on('data', (c: Buffer) => { body += c.toString(); }); req.on('end', () => { hits.push({ headers: req.headers as never, body }); res.writeHead(204); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/hook`;
    // A 1.x registration names the type in v1 spelling.
    const regV1 = await call('POST', '/v1/webhooks', { url, events: ['run.resuming'] }, { 'OpenWOP-Version': '1.0' });
    expect(regV1.s).toBe(201);
    const bad = await call('POST', '/v1/webhooks', { url, events: ['run.resume-started'] }, { 'OpenWOP-Version': '1.0' });
    expect(bad.s).toBe(400);
    const ts = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    // The seam is a v2 surface (SEAMS_PREFIX); it seeds an era-2 log in v1 vocabulary.
    const seeded = await call('POST', '/conformance/seams/sample/event-log/seed', { eventLogSchemaVersion: 2, status: 'completed', events: [
      { type: 'run.started', sequence: 0, payload: { workflowId: 'conformance-noop' }, timestamp: ts(0) },
      { type: 'run.resuming', sequence: 1, payload: {}, timestamp: ts(1) },
      { type: 'run.completed', sequence: 2, payload: { outputs: {} }, timestamp: ts(2) },
    ] });
    expect(seeded.s).toBe(201);
    const runId: string = seeded.b.runId;
    const bare = runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId;
    const v2 = await call('GET', `/runs/${enc(runId)}/events/poll`);
    expect(v2.b.events.map((e: { type: string }) => e.type)).toContain('run.resume-started');
    const v1 = await call('GET', `/v1/runs/${enc(bare)}/events/poll`, undefined, { 'OpenWOP-Version': '1.0' });
    expect(v1.s).toBe(200);
    expect(v1.b.events.map((e: { type: string }) => e.type)).toContain('run.resuming');
    expect(v1.b.events.map((e: { type: string }) => e.type)).not.toContain('run.resume-started');
    const sse = await fetch(`${B}/v1/runs/${enc(bare)}/events?streamMode=updates`, { headers: { ...H, 'OpenWOP-Version': '1.0' } });
    const text = await sse.text();
    expect(text).toContain('"type":"run.resuming"');
    expect(text).not.toContain('run.resume-started');
    await call('DELETE', `/v1/webhooks/${enc(regV1.b.webhookId)}`, undefined, { 'OpenWOP-Version': '1.0' });
    srv.close();
  });
});

describe('security-defaults.md §Sandbox isolation — the §8 seam runs real escape attempts in a permission-model child', () => {
  const invoke = (typeId: string, extra: Record<string, unknown> = {}) => call('POST', '/conformance/seams/sample/test/sandbox-invoke', { typeId, ...extra });
  it('advertises sandbox with isolationModel process and the caps the child enforces', async () => {
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { sandbox?: { isolationModel?: string; wallClockLimitMs?: number } };
    expect(d.sandbox?.isolationModel).toBe('process');
    expect(typeof d.sandbox?.wallClockLimitMs).toBe('number');
  });
  it('refuses the five escapes with the canonical escapeKind', async () => {
    for (const [typeId, kind] of [['misbehave.fs-escape-read', 'host-fs-escape'], ['misbehave.fs-escape-write', 'host-fs-escape'], ['misbehave.env-leak', 'host-env-leak'], ['misbehave.network-escape', 'network-escape'], ['misbehave.process-escape', 'host-process-escape']] as const) {
      const r = await invoke(typeId);
      expect(r.s).toBe(200);
      expect(r.b.error?.code, typeId).toBe('sandbox_escape_attempt');
      expect(r.b.error?.details?.escapeKind, typeId).toBe(kind);
    }
  });
  it('kills a wall-clock overrun and reports a heap overrun', async () => {
    expect((await invoke('misbehave.timeout')).b.error?.code).toBe('sandbox_timeout');
    expect((await invoke('misbehave.memory-bomb')).b.error?.code).toBe('sandbox_memory_exceeded');
  }, 30_000);
  it('a fresh context per invocation, the capability gate, and the two well-behaved baselines', async () => {
    for (let i = 0; i < 3; i++) expect((await invoke('misbehave.cross-pack-mutate')).b.result?.shared).toBe(1);
    const denied = await invoke('misbehave.capability-gate-violation');
    expect(denied.b.error?.code).toBe('sandbox_capability_denied'); expect(denied.b.error?.details?.requestedCapability).toBe('fetch');
    expect((await invoke('well-behaved.echo', { args: { input: 'hi' } })).b.result?.echoed).toBe('hi');
    expect((await invoke('well-behaved.host-fetch', { allowedHostCalls: ['fetch'] })).b.result?.status).toBe(200);
    expect((await call('POST', '/conformance/seams/sample/test/sandbox-load', { packId: 'misbehave' })).s).toBe(200);
  }, 30_000);
});

describe('RFC 0159 / RFC 0163 — the saml + scim lanes form a link record on one trust root, and a leaver is denied', () => {
  const V = '/conformance/seams/sample/auth/saml/validate';
  const P = '/conformance/seams/sample/auth/scim/provision';
  it('valid assertion accepted, every negative refused 401, link formed only on the bound trust root, deactivation sets deniedAt and denies', async () => {
    // The IdP is the operator's process (scripts/synthetic-idp.ts, built on the suite's minter); it is not part of the host's compile unit.
    const { spawn } = await import('node:child_process');
    const startIdp = (port: number, entityID?: string): Promise<{ url: string; entityID: string; close: () => void }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/synthetic-idp.ts', String(port), ...(entityID ? [entityID] : []), '--exit-with-parent'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString(); const m = /synthetic IdP (\S+) at (http:\/\/\S+)/.exec(out); if (m) resolve({ entityID: m[1] as string, url: m[2] as string, close: () => { child.stdin.end(); child.kill(); } }); });
      child.on('exit', (code) => reject(new Error(`synthetic IdP exited ${code}`)));
    });
    const idp = await startIdp(0);
    const other = await startIdp(0, 'urn:openwop:conformance:idp-B');
    const scimUrl = 'urn:openwop:conformance:scim';
    try {
      for (const variant of ['alg-none', 'bad-signature', 'unsigned', 'expired', 'not-yet-valid', 'signature-wrapping']) {
        const r = await call('POST', V, { idpUrl: idp.url, variant });
        expect(r.s, variant).toBe(401); expect(r.b.error, variant).toBe('unauthenticated');
      }
      const externalId = `idp-op-${Date.now().toString(36)}`;
      const created = await call('POST', P, { scimUrl, op: 'create-user', externalId, userName: 'r.smith', idpUrl: idp.url });
      expect(created.s).toBe(201);
      const ok = await call('POST', V, { idpUrl: idp.url, variant: 'valid', nameId: externalId });
      expect(ok.s).toBe(200); expect(ok.b.authenticated).toBe(true);
      expect(ok.b.link?.keyClass).toBe('opaque-idp'); expect(ok.b.link?.issuer).toBe(idp.entityID); expect(ok.b.link?.deniedAt).toBeUndefined();
      const read = await call('GET', `/conformance/seams/sample/auth/subject-links?externalId=${encodeURIComponent(externalId)}`);
      expect(read.s).toBe(200); expect(read.b.link?.a?.subjectId).toBe(ok.b.link.a.subjectId);
      // RFC 0163 §B: a second trust root asserting the same NameID does not link and is not authenticated through the first's connection.
      const otherId = `idp-op-x-${Date.now().toString(36)}`;
      await call('POST', P, { scimUrl: 'urn:openwop:conformance:scim-2', op: 'create-user', externalId: otherId, idpUrl: idp.url });
      const cross = await call('POST', V, { idpUrl: other.url, variant: 'valid', nameId: otherId });
      expect(cross.s).toBe(200); expect(cross.b.link).toBeUndefined();
      // RFC 0159 §A.3: deactivation → deniedAt on the record → the SAML decision fails closed.
      const off = await call('POST', P, { scimUrl, op: 'deactivate-user', externalId });
      expect(off.s).toBe(200); expect(typeof off.b.link?.deniedAt).toBe('string');
      const after = await call('POST', V, { idpUrl: idp.url, variant: 'valid', nameId: externalId });
      expect(after.s).toBe(200); expect(after.b.authenticated).toBe(false); expect(after.b.linkedDenied).toBe(true);
    } finally { idp.close(); other.close(); }
  }, 30_000);
});

describe('interop.md — negotiation is authenticated, floored and audited (RFC 0175 §D)', () => {
  const startPeers = (a2a: string, mcp: string): Promise<{ a2a: string; mcp: string; close: () => void }> => new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/fake-peers.ts', a2a, mcp], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c: Buffer) => { out += c.toString(); const m = /fake peers a2a=(\S+) mcp=(\S+)/.exec(out); if (m) resolve({ a2a: m[1] as string, mcp: m[2] as string, close: () => { child.stdin.end(); child.kill(); } }); });
    child.on('exit', (code) => reject(new Error(`fake peers exited ${code}`)));
  });
  const decided = async (runId: string) => (await call('GET', `/runs/${enc(runId)}/events/poll?timeout=1`)).b.events.filter((e: { type: string }) => e.type === 'negotiation.decided');
  it('accepts a dual-era peer at the preferred version and leaves negotiation.decided on the host log; refuses a below-floor peer with interop_version_unsupported and audits that too', async () => {
    const peers = await startPeers('1.0,0.3', '2026-07-28,2025-06-18');
    try {
      const a = await call('POST', '/conformance/seams/sample/a2a/invoke', { peerUrl: peers.a2a });
      expect(a.s).toBe(200); expect(a.b.negotiatedVersion).toBe('1.0');
      const ev = await decided(a.b.runId); expect(ev.length).toBe(1); expect(ev[0].payload.outcome).toBe('accepted'); expect(ev[0].payload.peerDigest).toMatch(/^[0-9a-f]{64}$/);
      const m = await call('POST', '/conformance/seams/sample/mcp/invoke', { serverUrl: peers.mcp });
      expect(m.s).toBe(200); expect(m.b.negotiatedVersion).toBe('2026-07-28');
      const mrtr = await call('POST', '/conformance/seams/sample/mcp/invoke', { serverUrl: peers.mcp, tool: 'needs_input', clientCapabilities: { elicitation: {} }, elicitationAnswer: { name: 'Ada' } });
      expect(mrtr.s).toBe(200); expect(mrtr.b.mrtr?.inputRequiredSeen).toBe(true); expect(mrtr.b.mrtr?.requestStateEchoed).toBe(true);
      const low = await call('POST', '/conformance/seams/sample/mcp/invoke', { serverUrl: peers.mcp, requestVersion: '2025-06-18' });
      expect(low.s).toBe(400); expect(low.b.error).toBe('interop_version_unsupported'); expect(low.b.details.protocol).toBe('mcp');
      const lowEv = await decided(low.b.details.runId); expect(lowEv[0].payload.outcome).toBe('refused'); expect(lowEv[0].payload.reason).toBe('below-floor');
    } finally { peers.close(); }
  }, 30_000);
  it('a peer offering only a below-floor version is refused without the host speaking it on the wire; an unauthenticated exchange never lands below preferredVersion', async () => {
    const peers = await startPeers('0.3', '2025-06-18');
    try {
      const a = await call('POST', '/conformance/seams/sample/a2a/invoke', { peerUrl: peers.a2a, authenticated: true, peerOffersOnly: '0.3' });
      expect(a.s).toBe(400); expect(a.b.error).toBe('interop_version_unsupported'); expect((await decided(a.b.details.runId))[0].payload.reason).toBe('below-floor');
      const u = await call('POST', '/conformance/seams/sample/a2a/invoke', { peerUrl: peers.a2a, authenticated: false, peerOffersOnly: '0.3' });
      expect(u.s).toBe(400); expect(['below-floor', 'unauthenticated']).toContain((await decided(u.b.details.runId))[0].payload.reason);
      const m = await call('POST', '/conformance/seams/sample/mcp/invoke', { serverUrl: peers.mcp, authenticated: false });
      expect(m.s).toBe(400);
    } finally { peers.close(); }
  }, 30_000);
  it('the MRTR ceiling: a server that keeps asking is refused at maxRounds + 1 with mcp_mrtr_rounds_exceeded and sees no retry beyond it', async () => {
    const { createServer } = await import('node:http');
    let calls = 0;
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c: Buffer) => { b += c.toString(); }); req.on('end', () => {
      const rpc = JSON.parse(b) as { id: unknown; method: string };
      const reply = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); };
      if (rpc.method === 'server/discover') return reply({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {} });
      calls += 1; reply({ resultType: 'input_required', inputRequests: { who: { method: 'elicitation/create', params: {} } }, requestState: `loop:${calls}` });
    }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
      const r = await call('POST', '/conformance/seams/sample/mcp/invoke', { serverUrl: url, tool: 'needs_input_loop', arguments: { rounds: 9 }, clientCapabilities: { elicitation: {} }, elicitationAnswer: { name: 'Ada' } });
      expect(r.s).toBe(422); expect(r.b.error).toBe('mcp_mrtr_rounds_exceeded'); expect(calls).toBeLessThanOrEqual(5);
    } finally { srv.close(); }
  }, 30_000);
});

describe('identity.md §5 — a tenant-bound webhookId is tenant-checked before it is looked up (RFC 0187 §A.1)', () => {
  it('a foreign tenant segment is 403 id_tenant_mismatch whether or not the id exists, and the caller own id still deletes', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_q, r) => { r.writeHead(204); r.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/hook`;
      const reg = await call('POST', '/webhooks', { url, events: ['run.completed'] });
      expect(reg.s).toBe(201);
      const id: string = reg.b.webhookId;
      expect(id).toMatch(/^[^/]+\/[^/]+$/);
      const opaque = id.slice(id.indexOf('/') + 1);
      // exists, foreign tenant → 403 (not 404): the grammar check runs first
      const foreign = await call('DELETE', `/webhooks/${enc(`not-the-callers-tenant/${opaque}`)}`);
      expect(foreign.s).toBe(403); expect(foreign.b.error).toBe('id_tenant_mismatch');
      // does not exist, foreign tenant → the SAME 403, so the refusal discloses nothing
      const ghost = await call('DELETE', `/webhooks/${enc('not-the-callers-tenant/zzzzzzzzzzzzzzzzzz')}`);
      expect(ghost.s).toBe(403); expect(ghost.b.error).toBe('id_tenant_mismatch');
      expect((await call('DELETE', `/webhooks/${enc(id)}`)).s).toBe(204);
    } finally { srv.close(); }
  });
});

describe('workflow-chain-packs.md — pins, deterministic children, substitution and the depth guard', () => {
  const chainPack = (name: string, chains: unknown[]): Record<string, unknown> => ({ name, version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=2.0.0 <3.0.0' }, chains });
  const one = (chainId: string, typeId: string, extra: Record<string, unknown> = {}) => ({ chainId, version: '1.0.0', label: 'L', description: 'D', parameters: { type: 'object', properties: {} }, dag: { nodes: [{ id: 'n1', typeId }], edges: [] }, ...extra });
  const publish = (m: Record<string, unknown>) => call('PUT', `/conformance/seams/packs-test/${enc(m['name'] as string)}/-/1.0.0.tgz`, pack(m), { 'Content-Type': 'application/octet-stream' });
  const fresh = (slug: string) => `core.openwop.rt-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  it('refuses a ranged and a bare reference, accepts an exact pin', async () => {
    const range = await publish(chainPack(fresh('range'), [one('c.range', 'core.ai.callPrompt@^1')]));
    expect(range.s, JSON.stringify(range.b)).toBeGreaterThanOrEqual(400); expect(range.b.details?.reason).toBe('chain_reference_unpinned');
    const bare = await publish(chainPack(fresh('bare'), [one('c.bare', 'core.ai.callPrompt')]));
    expect(bare.s).toBeGreaterThanOrEqual(400); expect(bare.b.details?.reason).toBe('chain_reference_unpinned');
    const exact = await publish(chainPack(fresh('exact'), [one('c.exact', 'core.ai.callPrompt@1.0.0')]));
    expect([200, 201], JSON.stringify(exact.b)).toContain(exact.s);
  });

  it('an EXTERNAL reference carrying a range is refused — the schema admits `version` as a range, so only the host rule catches it', async () => {
    // The schema's SubChainRef external form types `version` as a semver RANGE,
    // and the node-reference pattern already refuses `@^1`. This is the case the
    // schema cannot catch and §Exact pins still forbids, so it is the honest
    // witness that the host rule exists at all.
    const ext = { ...one('c.ext', 'core.ai.callPrompt@1.0.0'), subChains: [{ ref: { packName: 'core.openwop.other', chainId: 'c.remote', version: '^1.0.0' } }] };
    const ranged = await publish(chainPack(fresh('ext-range'), [ext]));
    expect(ranged.s, JSON.stringify(ranged.b)).toBeGreaterThanOrEqual(400);
    expect(ranged.b.details?.reason).toBe('chain_reference_unpinned');
  });

  it('a {{params.*}} token is substituted at expansion, never persisted', async () => {
    const withParam = { ...one('c.param', 'core.ai.callPrompt@1.0.0'), parameters: { type: 'object', properties: { greeting: { default: 'hello' } } } };
    (withParam.dag.nodes[0] as Record<string, unknown>)['name'] = '{{params.greeting}}';
    const ok = await publish(chainPack(fresh('param'), [withParam]));
    expect([200, 201]).toContain(ok.s);
    const unbound = { ...one('c.unbound', 'core.ai.callPrompt@1.0.0'), parameters: { type: 'object', properties: {} } };
    (unbound.dag.nodes[0] as Record<string, unknown>)['name'] = '{{params.missing}}';
    const bad = await publish(chainPack(fresh('unbound'), [unbound]));
    expect(bad.s).toBeGreaterThanOrEqual(400); expect(bad.b.details?.reason).toBe('chain_parameter_unbound');
  });

  it('a chain that composes itself fails closed, and the advertised maxDepth is the enforced one', async () => {
    const selfRef = { ...one('c.self', 'core.ai.callPrompt@1.0.0'), subChains: [{ ref: 'c.self' }] };
    const cyclic = await publish(chainPack(fresh('cycle'), [selfRef]));
    expect(cyclic.s).toBeGreaterThanOrEqual(400); expect(cyclic.b.error).toBe('sub_chain_cycle');
    const d = await (await fetch(`${B}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2.0' } })).json() as { workflowChainPacks?: { subChains?: { maxDepth?: number } } };
    expect(d.workflowChainPacks?.subChains?.maxDepth).toBe(8);
  });

  it('two parents composing the same child share one registration, and the child outlives the first parent deleted', async () => {
    const child = one('c.shared', 'core.ai.callPrompt@1.0.0');
    const p1 = fresh('p1'); const p2 = fresh('p2');
    expect([200, 201]).toContain((await publish(chainPack(p1, [child, { ...one('c.p1', 'core.ai.callPrompt@1.0.0'), subChains: [{ ref: 'c.shared' }] }]))).s);
    expect([200, 201]).toContain((await publish(chainPack(p2, [child, { ...one('c.p2', 'core.ai.callPrompt@1.0.0'), subChains: [{ ref: 'c.shared' }] }]))).s);
    const del = await fetch(`${B}/conformance/seams/packs-test/${enc(p1)}/-/1.0.0`, { method: 'DELETE', headers: { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0' } });
    expect(del.status).toBe(204);
    // The child survives: its other parent still references it.
    const still = await publish(chainPack(fresh('probe'), [{ ...one('c.probe', 'core.ai.callPrompt@1.0.0'), subChains: [{ ref: 'c.shared' }] }, child]));
    expect([200, 201]).toContain(still.s);
  });
});
