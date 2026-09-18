/**
 * webhooks.md — register/unregister, the five OpenWOP-* delivery headers
 * (+ the X-openwop-* family dual-emitted through the overlap), HMAC-SHA256
 * over `${timestamp}.${rawBody}` (scheme v1), durable delivery (attempts
 * table, exponential backoff, dead-letter after maxAttempts, retention), the
 * egress guard at registration and delivery, and the inbound verifier the
 * host runs as a subscriber (the seam `receiveWebhookDelivery`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { guardedRequest, validateEgressUrl } from './egress.js';
import { err } from './errors.js';
import { checkTenantBound, nowIso, tenantBound } from './ids.js';
import type { AppendedEvent, Host } from './host.js';
import type { DeliveryRow, WebhookRow } from './store.js';
import { docForMajor, v1TypeOf } from './codemap.js';

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function registerWebhook(host: Host, tenant: string, body: Record<string, unknown>, major: 1 | 2): { webhookId: string } {
  const allowed = new Set(['url', 'events', 'secret', 'tags']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw err('validation_error', `unknown key ${k} — the registration body is closed { url, events[], secret?, tags? }`, { key: k });
  if (typeof body['url'] !== 'string') throw err('validation_error', 'url is REQUIRED');
  validateEgressUrl(body['url'], host.config.webhookAllowPrivate);
  const events = body['events'];
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => typeof e === 'string' && e.length > 0)) throw err('validation_error', 'events[] MUST be a non-empty array of v2 event type names');
  // A subscription registered under the 1.x contract names its types in v1
  // spelling (persistence.md §The v1 wire of an era-3 log); stored as the v2
  // name the codemap maps it to, so the fan-out matches one vocabulary.
  const isVendor = (e: string): boolean => host.artifacts.vendorEventPattern.test(e);
  const stored: string[] = (events as string[]).map((e) => {
    if (major === 1) {
      // The v1 wire knows v1 spellings only: a v2-only name (`run.resume-started`) is not a v1 event type.
      const mapped = host.artifacts.codemap.get(e);
      if (mapped === undefined && !isVendor(e)) throw err('validation_error', `${e} is not a registered v1 event type`, { type: e });
      return mapped ?? e;
    }
    if (!host.artifacts.v2EventTypes.has(e) && !isVendor(e)) throw err('validation_error', `${e} is not a registered v2 event type`, { type: e });
    return e;
  });
  if (body['secret'] !== undefined && (typeof body['secret'] !== 'string' || body['secret'].length === 0)) throw err('validation_error', 'secret MUST be a non-empty string');
  if (body['tags'] !== undefined && (!Array.isArray(body['tags']) || !body['tags'].every((t) => typeof t === 'string'))) throw err('validation_error', 'tags MUST be a string array');
  const row: WebhookRow = {
    webhook_id: tenantBound(tenant),
    tenant,
    url: body['url'],
    events_json: JSON.stringify(stored),
    secret: typeof body['secret'] === 'string' ? body['secret'] : randomBytes(24).toString('base64url'),
    tags_json: Array.isArray(body['tags']) ? JSON.stringify(body['tags']) : null,
    contract_major: major,
    created_at: nowIso(),
  };
  host.store.insertWebhook(row);
  return { webhookId: row.webhook_id };
}

export function unregisterWebhook(host: Host, tenant: string, webhookId: string): void {
  // identity.md §5: the tenant segment is checked BEFORE the lookup. Checking it
  // after means a foreign-tenant id that happens not to exist answers `404`, which
  // is the wrong refusal AND discloses nothing only by accident — the grammar
  // check is what makes the `403` independent of existence. RFC 0187 §A.1 binds
  // `webhookId` to the kind, so the check has something to read.
  checkTenantBound(webhookId, tenant, 'webhookId');
  const row = host.store.getWebhook(webhookId);
  if (!row) throw err('not_found', 'no such webhook');
  if (row.tenant !== tenant) throw err('forbidden', 'the subscription belongs to another tenant');
  host.store.deleteWebhook(webhookId);
}

export function deadLetterProjection(host: Host, tenant: string, webhookId: string): Record<string, unknown> {
  const row = host.store.getWebhook(webhookId);
  if (!row) throw err('not_found', 'no such webhook');
  if (row.tenant !== tenant) throw err('forbidden', 'the subscription belongs to another tenant');
  return {
    webhookId,
    retentionDays: host.config.webhookRetentionDays,
    deadLetters: host.store.deadLetters(webhookId).map((d) => ({ deliveryId: d.delivery_id, runId: d.run_id, sequence: d.sequence, eventType: d.event_type, attempts: d.attempts, lastStatus: d.last_status, lastError: d.last_error, deadLetteredAt: d.updated_at })),
  };
}

function tagsOverlap(subscription: WebhookRow, runTags: readonly string[]): boolean {
  if (subscription.tags_json === null) return true;
  const wanted = JSON.parse(subscription.tags_json) as string[];
  return wanted.length === 0 || wanted.some((t) => runTags.includes(t));
}

/** Fan-out: a subscription receives only its tenant's runs; replay forks never fan out; a branch delivers only >= fromSeq. */
export function subscribeFanout(host: Host): void {
  host.bus.on('event', (e: AppendedEvent) => {
    if (e.run.forkMode === 'replay') return;
    if (e.run.forkMode === 'branch' && e.run.fromSeq !== null && e.doc.sequence < e.run.fromSeq) return;
    const runRow = host.store.getRun(e.run.runId);
    const runTags = runRow ? ((JSON.parse(runRow.options_json) as { tags?: string[] }).tags ?? []) : [];
    for (const sub of host.store.webhooksForTenant(e.run.tenant)) {
      const types = JSON.parse(sub.events_json) as string[];
      if (!types.includes(e.doc.type) || !tagsOverlap(sub, runTags)) continue;
      // webhooks.md §Delivery: `event` is the verbatim run event AS THE SUBSCRIBER'S CONTRACT RENDERS IT —
      // the same projection poll and SSE apply (versioning.md §1.2); a major-1 subscription keeps the
      // bare run id and the v1 owner echo it has always received.
      const major = sub.contract_major === 2 ? 2 : 1;
      const runId = major === 1 ? e.run.runId.slice(e.run.runId.indexOf('/') + 1) : e.run.runId;
      const body = JSON.stringify({ runId, workspaceId: runRow?.owner_json ? ((JSON.parse(runRow.owner_json) as { workspace?: string }).workspace ?? 'default') : 'default', event: docForMajor(e.doc, major) });
      host.store.insertDelivery({ delivery_id: tenantBound(e.run.tenant), webhook_id: sub.webhook_id, tenant: e.run.tenant, run_id: e.run.runId, sequence: e.doc.sequence, event_type: e.doc.type, body, attempts: 0, next_at: Date.now(), state: 'pending', last_status: null, last_error: null, created_at: nowIso(), updated_at: nowIso() });
    }
  });
}

async function attempt(host: Host, d: DeliveryRow): Promise<void> {
  const sub = host.store.getWebhook(d.webhook_id);
  if (!sub) { host.store.updateDelivery(d.delivery_id, { state: 'dead-lettered', last_error: 'subscription removed' }); return; }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${sign(sub.secret, timestamp, d.body)}`;
  // The type header is rendered in the subscriber's contract, like the body (persistence.md §The v1 wire of an era-3 log).
  const wireType = sub.contract_major === 2 ? d.event_type : v1TypeOf(d.event_type);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'OpenWOP-Webhook-Id': sub.webhook_id,
    'OpenWOP-Event-Type': wireType,
    'OpenWOP-Timestamp': timestamp,
    'OpenWOP-Signature': signature,
    'OpenWOP-Signature-Algorithm': 'v1',
    // Dual emission through the overlap (RFC 0176 §D.2), identical values.
    'X-openwop-Webhook-Id': sub.webhook_id,
    'X-openwop-Event-Type': wireType,
    'X-openwop-Timestamp': timestamp,
    'X-openwop-Signature': signature,
    'X-openwop-Signature-Algorithm': 'v1',
  };
  let result: { status: number; error?: string };
  try {
    result = await guardedRequest(new URL(sub.url), { method: 'POST', headers, body: d.body, timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate });
  } catch (e) {
    result = { status: 0, error: (e as Error).message };
  }
  const attempts = d.attempts + 1;
  if (result.status >= 200 && result.status < 300 && result.error === undefined) {
    host.store.updateDelivery(d.delivery_id, { state: 'delivered', attempts, last_status: result.status, last_error: null });
    return;
  }
  if (attempts >= host.config.webhookMaxAttempts) {
    host.store.updateDelivery(d.delivery_id, { state: 'dead-lettered', attempts, last_status: result.status, last_error: result.error ?? `HTTP ${result.status}` });
    return;
  }
  const delay = host.config.webhookBackoffBaseMs * 2 ** (attempts - 1);
  host.store.updateDelivery(d.delivery_id, { attempts, next_at: Date.now() + delay, last_status: result.status, last_error: result.error ?? `HTTP ${result.status}` });
}

export function startDeliveryWorker(host: Host): () => void {
  const inFlight = new Set<string>();
  const tick = (): void => {
    for (const d of host.store.dueDeliveries(Date.now())) {
      if (inFlight.has(d.delivery_id)) continue;
      inFlight.add(d.delivery_id);
      attempt(host, d).catch(() => undefined).finally(() => inFlight.delete(d.delivery_id));
    }
  };
  const timer = setInterval(tick, 100);
  timer.unref();
  const purge = setInterval(() => host.store.purgeDeadLetters(new Date(Date.now() - host.config.webhookRetentionDays * 86_400_000).toISOString()), 60_000);
  purge.unref();
  return () => { clearInterval(timer); clearInterval(purge); };
}

/** The host as a subscriber (webhooks.md §Verification): either header family, scheme v1, ±5 min, constant-time compare. */
export function verifyInbound(secret: string, headers: Record<string, string>, rawBody: string): { accepted: boolean; reason?: string } {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (name: string): string | undefined => lower.get(`openwop-${name}`) ?? lower.get(`x-openwop-${name}`);
  const algorithm = pick('signature-algorithm');
  if (algorithm !== 'v1') return { accepted: false, reason: `unrecognized OpenWOP-Signature-Algorithm ${String(algorithm)}` };
  const timestamp = pick('timestamp');
  if (timestamp === undefined || !/^\d+$/.test(timestamp)) return { accepted: false, reason: 'missing or malformed timestamp' };
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return { accepted: false, reason: 'timestamp outside ±5 minutes' };
  const given = pick('signature');
  if (given === undefined || !given.startsWith('sha256=')) return { accepted: false, reason: 'missing signature' };
  if (pick('webhook-id') === undefined || pick('event-type') === undefined) return { accepted: false, reason: 'missing webhook-id / event-type header' };
  const expected = sign(secret, timestamp, rawBody);
  const a = Buffer.from(given.slice('sha256='.length), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { accepted: false, reason: 'signature mismatch' };
  return { accepted: true };
}
