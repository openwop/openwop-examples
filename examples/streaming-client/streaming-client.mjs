// Streaming-client example — consume a run's v2 event stream over SSE.
//
// 1. POST /runs                    — create a run
// 2. GET  /runs/{runId}/events     — connect to the SSE stream
// 3. Print each event until the terminal one arrives
//
// Every request carries `OpenWOP-Version: 2` (versioning.md §1.3). The host
// replays the backlog on connect and closes the stream after the run's
// terminal event (`run.completed`, `run.failed`, `run.cancelled`; events.md
// §SSE), so no separate polling loop is needed. Each frame's `id:` is the
// event's sequence; reconnecting with `Last-Event-ID: <id>` resumes after it.
// Run ids are tenant-bound and travel in a path projected (`tenant~2Fopaque`,
// identity.md §5).
//
// Configuration via env vars:
//   OPENWOP_BASE_URL   default http://127.0.0.1:3838  (the v2 reference host)
//   OPENWOP_API_KEY    default openwop-v2-dev-key
//   OPENWOP_WORKFLOW   default conformance-noop
//
// Zero external dependencies — Node 20+ fetch and a small SSE parser.

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.OPENWOP_BASE_URL ?? 'http://127.0.0.1:3838';
const API_KEY = process.env.OPENWOP_API_KEY ?? 'openwop-v2-dev-key';
const WORKFLOW = process.env.OPENWOP_WORKFLOW ?? 'conformance-noop';
const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const V2 = { 'OpenWOP-Version': '2' };

/** identity.md §5: every byte outside [A-Za-z0-9._-] becomes ~ plus two uppercase hex digits. */
function projectId(id) {
  return [...Buffer.from(id, 'utf8')]
    .map((b) => (/[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
}

async function createRun(workflowId) {
  const res = await fetch(`${BASE_URL}/runs`, {
    method: 'POST',
    headers: {
      ...V2,
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `streaming-client-${randomUUID()}`,
    },
    body: JSON.stringify({ workflowId }),
  });
  if (res.status !== 201) throw new Error(`Run create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Minimal SSE frame parser. A frame is a run of `field: value` lines ended by a
// blank line; this reads `event`, `id` and `data`, and skips `:` keep-alive comments.
function parseSseFrames(text, carry) {
  const buffer = (carry + text).replace(/\r\n/g, '\n');
  const frames = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const blankLine = buffer.indexOf('\n\n', cursor);
    if (blankLine < 0) break;
    const frame = buffer.slice(cursor, blankLine);
    cursor = blankLine + 2;
    const fields = {};
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).replace(/^ /, '');
      fields[name] = name === 'data' && fields.data !== undefined ? `${fields.data}\n${value}` : value;
    }
    if (fields.event || fields.data) frames.push({ event: fields.event ?? 'message', data: fields.data ?? '', id: fields.id });
  }
  return { frames, carry: buffer.slice(cursor) };
}

async function streamEvents(runId, onEvent) {
  const res = await fetch(`${BASE_URL}/runs/${projectId(runId)}/events`, {
    headers: { ...V2, Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' },
  });
  if (!res.ok) throw new Error(`Stream connect failed: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error('Response body is not streamable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const { frames, carry: rest } = parseSseFrames(decoder.decode(value, { stream: true }), carry);
    carry = rest;
    for (const frame of frames) {
      let event;
      try { event = JSON.parse(frame.data); } catch { event = { raw: frame.data }; }
      if ((await onEvent(frame, event)) === 'stop') return;
    }
  }
}

async function main() {
  console.log(`→ POST /runs { workflowId: "${WORKFLOW}" }`);
  const created = await createRun(WORKFLOW);
  console.log(`  runId: ${created.runId}`);

  console.log(`→ Streaming /runs/${projectId(created.runId)}/events`);
  let count = 0;
  let terminal = null;
  await streamEvents(created.runId, async (frame, event) => {
    count++;
    const type = event.type ?? frame.event;
    const node = event.nodeId ? ` node=${event.nodeId}` : '';
    console.log(`  [${frame.id ?? event.sequence ?? '?'}] ${type}${node}`);
    if (TERMINAL_TYPES.has(type)) { terminal = type; return 'stop'; }
  });
  if (terminal === null) {
    console.error(`✗ The stream closed after ${count} events without a terminal event`);
    process.exit(1);
  }
  console.log(`✓ Stream ended with ${terminal} after ${count} events`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
