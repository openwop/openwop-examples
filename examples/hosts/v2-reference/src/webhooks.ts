/**
 * webhooks.md — register/unregister, the five OpenWOP-* delivery headers
 * (+ the X-openwop-* family dual-emitted through the overlap), HMAC-SHA256
 * over `${timestamp}.${rawBody}` (scheme v1), durable delivery (attempts
 * table, exponential backoff, dead-letter after maxAttempts, retention), the
 * egress guard at registration and delivery, and the inbound verifier the
 * host runs as a subscriber (the seam `receiveWebhookDelivery`).
 *
 * RFC 0201 — Standard Webhooks 1.0.0 as an opt-in COMPANION scheme
 * (`standard-webhooks-1`): a subscription that lists it at registration supplies
 * a `whsec_` secret, is endpoint-verified before its 201, and every delivery
 * adds `webhook-id` / `webhook-timestamp` / `webhook-signature` beside the
 * unchanged scheme-`v1` headers. Every other subscription is untouched.
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

export const STANDARD_WEBHOOKS = 'standard-webhooks-1';

/**
 * The algorithm ids this host applies — the facet advertises exactly this list.
 * `standard-webhooks-1` only when the INSTALLED contract defines RFC 0201 (its
 * error code is registered): the host implements the contract it ships, so on a
 * 2.35.x `@openwop/spec-artifacts` it neither advertises nor accepts the id.
 */
export function signatureAlgorithms(host: Host): string[] {
  return host.artifacts.errors.has('webhook_endpoint_unverified') ? ['v1', STANDARD_WEBHOOKS] : ['v1'];
}

/** RFC 0201 §E — the `webhooks.secretRotation` facet, or undefined when the companion scheme is not offered. */
export function secretRotation(host: Host): { overlapSeconds: number } | undefined {
  return signatureAlgorithms(host).includes(STANDARD_WEBHOOKS) ? { overlapSeconds: host.config.webhookRotationOverlapSeconds } : undefined;
}

/** The HMAC key of a Standard Webhooks secret: the base64 after `whsec_`, decoded, 24–64 bytes; else null. */
export function whsecKey(secret: unknown): Buffer | null {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) return null;
  const b64 = secret.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length >= 24 && key.length <= 64 ? key : null;
}

/** One `webhook-signature` entry: `v1,` + base64 HMAC-SHA256 over `{id}.{timestamp}.{rawBody}` keyed by the decoded secret (Standard Webhooks §"Signature scheme"). */
export function standardWebhooksSign(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = whsecKey(secret);
  if (key === null) throw new Error('standard-webhooks-1 subscription holds a secret that is not whsec_ form');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}

/** RFC 0201 §C.10 — a fresh message id; `.`-free, matches `^[A-Za-z0-9_-]{16,128}$`, never derived from the secret. */
export function mintMessageId(): string {
  return `msg_${randomBytes(18).toString('base64url')}`;
}

function optedIn(sub: WebhookRow): boolean {
  if (sub.signature_algorithms_json === null) return false;
  return (JSON.parse(sub.signature_algorithms_json) as string[]).includes(STANDARD_WEBHOOKS);
}

/**
 * RFC 0201 §D — the one verification request. Same egress path as a delivery
 * (re-resolve, validate every address, pinned connect, no redirects), 10 s, never
 * retried. Anything but a 2xx whose JSON `challenge` equals the one sent refuses
 * the registration, and the caller persists nothing.
 */
async function verifyEndpoint(host: Host, url: string, secret: string): Promise<void> {
  const challenge = randomBytes(24).toString('base64url');
  const body = JSON.stringify({ type: 'openwop.webhook.verification', challenge });
  const id = mintMessageId();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': standardWebhooksSign(secret, id, timestamp, body),
  };
  let result: { status: number; body: string; error?: string };
  try {
    result = await guardedRequest(new URL(url), { method: 'POST', headers, body, timeoutMs: 10_000, allowPrivate: host.config.webhookAllowPrivate });
  } catch (e) {
    result = { status: 0, body: '', error: (e as Error).message };
  }
  let echoed: unknown;
  try { echoed = (JSON.parse(result.body) as { challenge?: unknown } | null)?.challenge; } catch { echoed = undefined; }
  if (result.error !== undefined || result.status < 200 || result.status >= 300 || echoed !== challenge) {
    const why = result.error ?? (result.status < 200 || result.status >= 300 ? `HTTP ${result.status}` : 'the response did not echo the challenge');
    throw err('webhook_endpoint_unverified', `the endpoint did not consent to the subscription (RFC 0201 §D.14): ${why}`);
  }
}

export async function registerWebhook(host: Host, tenant: string, body: Record<string, unknown>, major: 1 | 2): Promise<{ webhookId: string; signatureAlgorithms?: string[] }> {
  const allowed = new Set(['url', 'events', 'secret', 'tags', 'signatureAlgorithms']);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw err('validation_error', `unknown key ${k} — the registration body is closed { url, events[], secret?, tags?, signatureAlgorithms? }`, { key: k });
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
  // RFC 0201 §B — the per-subscription opt-in. Absent ⇒ ["v1"], byte for byte today's behaviour.
  let algorithms: string[] | undefined;
  if (body['signatureAlgorithms'] !== undefined) {
    const raw = body['signatureAlgorithms'];
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((a) => typeof a === 'string')) throw err('validation_error', 'signatureAlgorithms MUST be a non-empty string array', { field: 'signatureAlgorithms' });
    const offered = signatureAlgorithms(host);
    if (!raw.includes('v1')) throw err('validation_error', 'signatureAlgorithms MUST contain "v1" (RFC 0201 §B.5)', { field: 'signatureAlgorithms' });
    if (new Set(raw).size !== raw.length) throw err('validation_error', 'signatureAlgorithms MUST NOT repeat a value (RFC 0201 §B.5)', { field: 'signatureAlgorithms' });
    const unknown = (raw as string[]).find((a) => !offered.includes(a));
    if (unknown !== undefined) throw err('validation_error', `${unknown} is not in this host's webhooks.signatureAlgorithms`, { field: 'signatureAlgorithms' });
    algorithms = raw as string[];
  }
  const wantsStandard = algorithms?.includes(STANDARD_WEBHOOKS) === true;
  if (wantsStandard && whsecKey(body['secret']) === null) throw err('validation_error', 'an opt-in to standard-webhooks-1 MUST carry secret as whsec_<base64 of 24–64 bytes> (RFC 0201 §B.6)', { field: 'secret' });
  // §D — verify BEFORE anything is persisted; a refusal throws and no row is written.
  if (wantsStandard) await verifyEndpoint(host, body['url'], body['secret'] as string);
  const row: WebhookRow = {
    webhook_id: tenantBound(tenant),
    tenant,
    url: body['url'],
    events_json: JSON.stringify(stored),
    secret: typeof body['secret'] === 'string' ? body['secret'] : randomBytes(24).toString('base64url'),
    tags_json: Array.isArray(body['tags']) ? JSON.stringify(body['tags']) : null,
    contract_major: major,
    created_at: nowIso(),
    signature_algorithms_json: algorithms === undefined ? null : JSON.stringify(algorithms),
    prev_secret: null,
    prev_secret_expires_at: null,
  };
  host.store.insertWebhook(row);
  // §B.7 — echo the applied list whenever the request carried one; never the secret (§B.6).
  return algorithms === undefined ? { webhookId: row.webhook_id } : { webhookId: row.webhook_id, signatureAlgorithms: algorithms };
}

/**
 * RFC 0201 §E — `rotateWebhookSecret`. 404 when the facet is not advertised;
 * tenant checks exactly as `unregisterWebhook` (the tenant segment before the
 * lookup); 400 for a subscription that did not opt in. The previous secret keeps
 * signing for `overlapSeconds`; a second rotation inside an overlap retires the
 * oldest immediately, because only one previous secret is ever kept.
 */
export function rotateWebhookSecret(host: Host, tenant: string, webhookId: string, body: Record<string, unknown>): { rotatedAt: string; previousSecretExpiresAt: string } {
  const facet = secretRotation(host);
  if (facet === undefined) throw err('not_found', 'webhooks.secretRotation is not advertised');
  checkTenantBound(webhookId, tenant, 'webhookId');
  const row = host.store.getWebhook(webhookId);
  if (!row) throw err('not_found', 'no such webhook');
  if (row.tenant !== tenant) throw err('forbidden', 'the subscription belongs to another tenant');
  for (const k of Object.keys(body)) if (k !== 'secret') throw err('validation_error', `unknown key ${k} — the rotation body is closed { secret }`, { key: k });
  if (whsecKey(body['secret']) === null) throw err('validation_error', 'secret MUST be whsec_<base64 of 24–64 bytes> (RFC 0201 §B.6)', { field: 'secret' });
  if (!optedIn(row)) throw err('validation_error', 'the subscription did not opt into standard-webhooks-1; its single v1 signature cannot overlap (RFC 0201 §E.18)');
  const now = Date.now();
  const expires = now + facet.overlapSeconds * 1000;
  host.store.rotateWebhookSecret(webhookId, body['secret'] as string, row.secret, expires);
  return { rotatedAt: new Date(now).toISOString(), previousSecretExpiresAt: new Date(expires).toISOString() };
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

/**
 * RFC 0188 §A — the dead-letter read.
 *
 * This replaces a VENDOR-SHAPED projection that shared the path. The old body
 * was `{webhookId, retentionDays, deadLetters[]}` with per-record `sequence`
 * and `lastError`; the canonical page is closed over `{deliveries, nextCursor}`
 * and the record closed over nine required fields, so three of the old keys are
 * now schema violations rather than extras.
 *
 * `lastError` is the one that mattered. It carried the subscriber's response
 * text, and §B.1 makes the record content-free BY CONSTRUCTION — a dead-letter
 * queue is every event the subscriber failed to receive, so a record that
 * carries any of the exchange turns one read scope into a replay of exactly
 * that traffic for the whole retention window.
 */
const DEAD_LETTER_CURSOR_KEY = randomBytes(32);

/** The cursor binds the subscription: §A.3 refuses one minted for another. */
function mintDeadLetterCursor(webhookId: string, row: DeliveryRow): string {
  const payload = `${webhookId}|${row.updated_at}|${row.delivery_id}`;
  const mac = createHmac('sha256', DEAD_LETTER_CURSOR_KEY).update(payload).digest('base64url');
  return Buffer.from(`${payload}|${mac}`).toString('base64url');
}

function readDeadLetterCursor(raw: string, webhookId: string): { updatedAt: string; deliveryId: string } {
  let decoded = '';
  try { decoded = Buffer.from(raw, 'base64url').toString('utf8'); } catch { /* fall through to the shape check */ }
  const parts = decoded.split('|');
  if (parts.length !== 4) throw err('validation_error', 'cursor is not one this host minted', { field: 'cursor' });
  const [boundWebhook, updatedAt, deliveryId, mac] = parts as [string, string, string, string];
  const expect = createHmac('sha256', DEAD_LETTER_CURSOR_KEY).update(`${boundWebhook}|${updatedAt}|${deliveryId}`).digest('base64url');
  if (mac.length !== expect.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) {
    throw err('validation_error', 'cursor is not one this host minted', { field: 'cursor' });
  }
  // §A.3: a cursor minted by one subscription MUST NOT be accepted on another.
  // Checked AFTER the mac so a forged binding cannot be used to probe.
  if (boundWebhook !== webhookId) throw err('validation_error', 'cursor was minted for another subscription', { field: 'cursor' });
  return { updatedAt, deliveryId };
}

/** `eventId` lives in the stored delivery body; §B.1 forbids returning the body, not reading one field out of it. */
function eventIdOf(row: DeliveryRow): string {
  try {
    const parsed = JSON.parse(row.body) as { event?: { eventId?: unknown } };
    const id = parsed.event?.eventId;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch { /* a body that will not parse cannot yield an id */ }
  // Deterministic and unique per delivery, so the field is never absent on a
  // record the schema requires it on.
  return `evt_${row.delivery_id}`;
}

export function deadLetterProjection(
  host: Host,
  tenant: string,
  webhookId: string,
  query?: URLSearchParams,
): Record<string, unknown> {
  // §A.2 — the tenant segment is checked BEFORE the lookup, so a foreign-tenant
  // id that happens not to exist answers 403 and not 404. Checking after made
  // the refusal depend on existence, which is the disclosure the rule forbids.
  checkTenantBound(webhookId, tenant, 'webhookId');
  const row = host.store.getWebhook(webhookId);
  if (!row) throw err('not_found', 'no such webhook');
  if (row.tenant !== tenant) throw err('forbidden', 'the subscription belongs to another tenant');

  const max = host.config.webhookDeadLetterMaxPageSize;
  let limit = max;
  const limitRaw = query?.get('limit') ?? null;
  if (limitRaw !== null) {
    if (!/^[1-9]\d*$/.test(limitRaw)) throw err('validation_error', 'limit MUST be an integer >= 1', { field: 'limit' });
    limit = Math.min(Number(limitRaw), max);
  }
  const cursorRaw = query?.get('cursor') ?? null;
  const after = cursorRaw !== null ? readDeadLetterCursor(cursorRaw, webhookId) : undefined;

  // One extra row tells us whether a next page exists without a second query.
  const rows = host.store.deadLetters(webhookId, { limit: limit + 1, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit);
  const retentionMs = host.config.webhookRetentionDays * 86_400_000;

  const body: Record<string, unknown> = {
    deliveries: page.map((d) => ({
      deliveryId: d.delivery_id,
      webhookId: d.webhook_id,
      runId: d.run_id,
      eventId: eventIdOf(d),
      eventType: d.event_type,
      attempts: d.attempts,
      deadLetteredAt: d.updated_at,
      // §A.4: `expiresAt` is what turns `retentionDays` from an advertisement
      // into an observable — it is derived from the SAME config the purge timer
      // uses, so a reader checking `expiresAt - deadLetteredAt` against the
      // advertised facet is checking the mechanism, not a restated number.
      expiresAt: new Date(Date.parse(d.updated_at) + retentionMs).toISOString(),
      // This host exhausts retries; it has no payload-projection failure path,
      // so claiming `payload_unprojectable` anywhere would be a reason it never
      // actually has.
      reason: 'retries_exhausted',
      ...(d.last_status !== null ? { lastStatus: d.last_status } : {}),
    })),
  };
  if (rows.length > limit && page.length > 0) {
    body['nextCursor'] = mintDeadLetterCursor(webhookId, page[page.length - 1] as DeliveryRow);
  }
  return body;
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
      // RFC 0201 §C.10: the message id is minted ONCE, with the delivery row, so every attempt —
      // and every attempt after a restart, which re-reads this row — carries the same id.
      host.store.insertDelivery({ delivery_id: tenantBound(e.run.tenant), webhook_id: sub.webhook_id, tenant: e.run.tenant, run_id: e.run.runId, sequence: e.doc.sequence, event_type: e.doc.type, body, attempts: 0, next_at: Date.now(), state: 'pending', last_status: null, last_error: null, created_at: nowIso(), updated_at: nowIso(), message_id: optedIn(sub) ? mintMessageId() : null });
    }
  });
}

async function attempt(host: Host, d: DeliveryRow): Promise<void> {
  const sub = host.store.getWebhook(d.webhook_id);
  if (!sub) { host.store.updateDelivery(d.delivery_id, { state: 'dead-lettered', last_error: 'subscription removed' }); return; }
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  // RFC 0201 §E.20 — during a rotation overlap the v1 signature stays on the PREVIOUS secret.
  const overlap = sub.prev_secret !== null && sub.prev_secret_expires_at !== null && now < sub.prev_secret_expires_at ? sub.prev_secret : null;
  const signature = `sha256=${sign(overlap ?? sub.secret, timestamp, d.body)}`;
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
  // RFC 0201 §C.9 — the Standard Webhooks headers, only on an opted-in subscription, beside
  // (never instead of) the ones above. OpenWOP-Signature-Algorithm stays `v1`.
  if (optedIn(sub)) {
    const id = d.message_id ?? mintMessageId();
    if (d.message_id === null) host.store.updateDelivery(d.delivery_id, { message_id: id });
    const entries = [standardWebhooksSign(sub.secret, id, timestamp, d.body)];
    if (overlap !== null) entries.push(standardWebhooksSign(overlap, id, timestamp, d.body));
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = timestamp;
    headers['webhook-signature'] = entries.join(' ');
  }
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
