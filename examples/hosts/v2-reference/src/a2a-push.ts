/**
 * RFC 0214 — A2A push notifications, served only when `a2a.pushNotifications`
 * is advertised (`OPENWOP_A2A_PUSH=1`). interop.md §"A2A push delivery" and
 * the interop-map `a2a.operations` push rows:
 *
 *   - registration: `url` passes the webhooks.md egress guard (scheme and
 *     address arms), exactly as a webhook subscription's does;
 *   - the config's `token` and `authentication.credentials` are a DESTINATION
 *     credential (security-defaults.md §"Onward hops"): held in this process's
 *     memory only — never in the event log, the store, GetTask or a debug
 *     bundle — returned by no read, sent only to the registered origin on a
 *     push, never after a redirect (guardedRequest refuses every 3xx), and
 *     dropped on Delete and when the task reaches a terminal state;
 *   - delivery: each task-state transition after registration is POSTed as an
 *     A2A 1.0 `StreamResponse { statusUpdate }` with content type
 *     `application/a2a+json`, `Authorization: {scheme} {credentials}` (else
 *     `Bearer <token>`), no OpenWOP signature; the egress guard binds again at
 *     delivery (re-resolve, validate every address, pin, no redirects);
 *     retries follow the webhook retryPolicy (maxAttempts, exponential);
 *   - a config is keyed on the task's OWN run, so no fork inherits it and a
 *     replay fork's re-emitted history (never on the `event` bus, events.ts
 *     fixedHistory) delivers nothing;
 *   - a read or delete naming a task the caller cannot read, or a configId that
 *     is not that task's, answers exactly as an unknown id; a configId is
 *     opaque random and encodes no tenant; delete is idempotent.
 *
 * Configs are process-memory state: a restart forgets them (and their
 * credentials) — the conservative reading of "held by reference".
 */
import { randomBytes } from 'node:crypto';
import { guardedRequest, validateEgressUrl } from './egress.js';
import { TERMINAL, type AppendedEvent, type Host } from './host.js';
import type { RunRow } from './store.js';

export interface PushConfig {
  readonly id: string;
  readonly taskId: string;
  readonly url: string;
  readonly token?: string;
  readonly authentication?: { readonly scheme: string; readonly credentials?: string };
  /** The last A2A task state pushed (or current at registration): a push is sent on a CHANGE. */
  lastState: string;
}

/** `invalid` → -32602; `not-found` → the unknown-id answer. */
export class PushError extends Error {
  constructor(readonly kind: 'invalid' | 'not-found', message: string) { super(message); }
}

const REGISTRIES = new WeakMap<Host, Map<string, PushConfig>>();
function registry(host: Host): Map<string, PushConfig> {
  let r = REGISTRIES.get(host);
  if (!r) { r = new Map(); REGISTRIES.set(host, r); }
  return r;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What a read returns: never `token`, never `authentication.credentials`. */
export function publicView(c: PushConfig): Record<string, unknown> {
  const v: Record<string, unknown> = { id: c.id, taskId: c.taskId, url: c.url };
  if (c.authentication !== undefined) v['authentication'] = { scheme: c.authentication.scheme };
  return v;
}

/** CreateTaskPushNotificationConfig on a task the caller can read (the caller resolved `run`). */
export function createPushConfig(host: Host, run: RunRow, raw: Record<string, unknown>, currentState: string): Record<string, unknown> {
  const url = raw['url'];
  if (typeof url !== 'string' || url.length === 0) throw new PushError('invalid', 'url is REQUIRED');
  try { validateEgressUrl(url, host.config.webhookAllowPrivate); } catch (e) { throw new PushError('invalid', (e as Error).message); }
  const token = raw['token'];
  if (token !== undefined && typeof token !== 'string') throw new PushError('invalid', 'token MUST be a string');
  const auth = raw['authentication'];
  let authentication: PushConfig['authentication'];
  if (auth !== undefined) {
    if (!isObject(auth) || typeof auth['scheme'] !== 'string' || auth['scheme'].trim() === '') throw new PushError('invalid', 'authentication.scheme is REQUIRED');
    if (auth['credentials'] !== undefined && typeof auth['credentials'] !== 'string') throw new PushError('invalid', 'authentication.credentials MUST be a string');
    authentication = { scheme: auth['scheme'].trim(), ...(typeof auth['credentials'] === 'string' ? { credentials: auth['credentials'] } : {}) };
  }
  // Server-assigned, opaque, random: it encodes no tenant, workspace or principal.
  const c: PushConfig = { id: `pnc-${randomBytes(16).toString('base64url')}`, taskId: run.run_id, url, ...(typeof token === 'string' ? { token } : {}), ...(authentication !== undefined ? { authentication } : {}), lastState: currentState };
  registry(host).set(c.id, c);
  return publicView(c);
}

/** `run` is null when the caller cannot read the task: answered exactly as an unknown id. */
export function getPushConfig(host: Host, run: RunRow | null, id: unknown): Record<string, unknown> {
  const c = typeof id === 'string' ? registry(host).get(id) : undefined;
  if (run === null || c === undefined || c.taskId !== run.run_id) throw new PushError('not-found', 'push notification config not found');
  return publicView(c);
}

export function listPushConfigs(host: Host, run: RunRow, pageSize: unknown, pageToken: unknown): Record<string, unknown> {
  let size = 50;
  if (pageSize !== undefined && pageSize !== 0) {
    if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new PushError('invalid', 'pageSize MUST be an integer 1-100');
    size = pageSize;
  }
  let offset = 0;
  if (pageToken !== undefined && pageToken !== '') {
    const decoded = typeof pageToken === 'string' ? Buffer.from(pageToken, 'base64url').toString('utf8') : '';
    if (!/^p:(0|[1-9][0-9]*)$/.test(decoded)) throw new PushError('invalid', 'pageToken is not one this host minted');
    offset = Number(decoded.slice(2));
  }
  const all = [...registry(host).values()].filter((c) => c.taskId === run.run_id).sort((a, b) => (a.id < b.id ? -1 : 1));
  const page = all.slice(offset, offset + size);
  const next = offset + size < all.length ? Buffer.from(`p:${offset + size}`).toString('base64url') : '';
  return { configs: page.map(publicView), nextPageToken: next };
}

/** Idempotent: an unknown id, another task's id and an unreadable task all answer `{}` and change nothing. */
export function deletePushConfig(host: Host, run: RunRow | null, id: unknown): Record<string, unknown> {
  const reg = registry(host);
  const c = typeof id === 'string' ? reg.get(id) : undefined;
  if (run !== null && c !== undefined && c.taskId === run.run_id) reg.delete(c.id); // the credential goes with it
  return {};
}

/** Test/introspection only: how many configs (and so credentials) the host still holds for a task. */
export function heldConfigCount(host: Host, taskId: string): number {
  return [...registry(host).values()].filter((c) => c.taskId === taskId).length;
}

export interface StatusProjection { state: string; update: Record<string, unknown> }

function authorizationOf(c: PushConfig): string | undefined {
  if (c.authentication !== undefined) return c.authentication.credentials !== undefined ? `${c.authentication.scheme} ${c.authentication.credentials}` : c.authentication.scheme;
  if (c.token !== undefined) return `Bearer ${c.token}`;
  return undefined;
}

async function deliver(host: Host, url: string, authorization: string | undefined, body: string): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' };
  if (authorization !== undefined) headers['Authorization'] = authorization;
  for (let attempt = 1; attempt <= Math.max(1, host.config.webhookMaxAttempts); attempt++) {
    let ok = false;
    try {
      const r = await guardedRequest(new URL(url), { method: 'POST', headers, body, timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate });
      ok = r.status >= 200 && r.status < 300 && r.error === undefined;
    } catch { ok = false; }
    if (ok) return;
    if (attempt < host.config.webhookMaxAttempts) await new Promise((res) => setTimeout(res, host.config.webhookBackoffBaseMs * 2 ** (attempt - 1)));
  }
  // Exhausted: push dead-letters are not visible to A2A clients; a client recovers with GetTask.
}

/**
 * Subscribe to the host's live event bus. `project` renders the run's current
 * A2A status (a2a-server.ts taskOf) — injected to keep this module free of the
 * server's import graph.
 */
export function subscribePush(host: Host, project: (run: RunRow) => StatusProjection): void {
  host.bus.on('event', (e: AppendedEvent) => {
    // A replay fork's events are never pushed; and a fork never holds a config (configs are keyed on their own task).
    if (e.run.forkMode === 'replay') return;
    const reg = registry(host);
    const mine = [...reg.values()].filter((c) => c.taskId === e.run.runId);
    if (mine.length === 0) return;
    // The executor appends an event, then sets the run's status: read the settled row.
    setImmediate(() => {
      const run = host.store.getRun(e.run.runId);
      if (!run) return;
      const { state, update } = project(run);
      const body = JSON.stringify({ statusUpdate: update });
      const terminal = TERMINAL.has(run.status);
      for (const c of mine) {
        if (!reg.has(c.id)) continue;
        if (c.lastState !== state) {
          c.lastState = state;
          void deliver(host, c.url, authorizationOf(c), body);
        }
        if (terminal) reg.delete(c.id); // the destination credential is dropped with the task's life
      }
    });
  });
}
