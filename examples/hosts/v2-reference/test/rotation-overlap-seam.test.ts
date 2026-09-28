/**
 * shortenRotationOverlap (host-sample-test-seams.md §29) — RFC 0201 §E.20
 * post-overlap witness. The seam moves the stored expiry `rotateWebhookSecret`
 * wrote; the delivery signer reads that same column, so after the shortened
 * expiry only the new secret signs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { startHost, type RunningHost } from '../src/server.js';
import { tenantBound } from '../src/ids.js';

let running: RunningHost;
let B = '';
const K = 'test-key-rotation-overlap-seam';
const H = { Authorization: `Bearer ${K}`, 'OpenWOP-Version': '2.0', 'Content-Type': 'application/json' };
const SEAM = '/conformance/seams/sample/webhooks/rotation-overlap';

async function call(method: string, path: string, body?: unknown): Promise<{ s: number; b: any }> {
  const r = await fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let b: unknown;
  try { b = JSON.parse(t); } catch { b = t; }
  return { s: r.status, b };
}

const whsec = (): string => `whsec_${randomBytes(32).toString('base64')}`;

// Rows go in through the store: an opted-in registration verifies its endpoint first (RFC 0201 §D), which is not what this file tests.
function register(opted: boolean): string {
  const tenant = running.host.config.tenant;
  const id = tenantBound(tenant);
  running.host.store.insertWebhook({ webhook_id: id, tenant, url: 'http://127.0.0.1:9/hook', events_json: JSON.stringify(['run.completed']), secret: whsec(), tags_json: null, contract_major: 2, created_at: new Date().toISOString(), signature_algorithms_json: opted ? JSON.stringify(['v1', 'standard-webhooks-1']) : null, prev_secret: null, prev_secret_expires_at: null });
  return id;
}

beforeAll(async () => {
  running = await startHost({ port: 0, dbPath: ':memory:', apiKey: K, devValidate: 'strict', webhookAllowPrivate: true, rateLimitPerMinute: 100_000, webhookRotationOverlapSeconds: 3600 });
  B = `http://127.0.0.1:${running.port}`;
});
afterAll(async () => { await running.close(); });

describe('shortenRotationOverlap (§29)', () => {
  it('moves the one stored expiry the signer reads, and reports it', async () => {
    const id = register(true);
    const rot = await call('POST', `/webhooks/${encodeURIComponent(id)}/rotate-secret`, { secret: whsec() });
    expect(rot.s).toBe(200);
    const before = Date.now();
    const cut = await call('POST', SEAM, { webhookId: id, overlapSeconds: 3 });
    expect(cut.s).toBe(200);
    expect(cut.b.webhookId).toBe(id);
    const at = Date.parse(cut.b.previousSecretExpiresAt);
    expect(Math.abs(at - (before + 3000))).toBeLessThan(1000);
    expect(running.host.store.getWebhook(id)?.prev_secret_expires_at).toBe(at);
  });

  it('refuses a foreign-tenant id before the lookup, and never lengthens', async () => {
    const foreign = await call('POST', SEAM, { webhookId: `openwop-conformance-foreign/${'a'.repeat(22)}`, overlapSeconds: 3 });
    expect(foreign.s).toBe(403);
    expect(foreign.b.error).toBe('id_tenant_mismatch');
    const id = register(true);
    expect((await call('POST', SEAM, { webhookId: id, overlapSeconds: 3 })).s).toBe(400);
    expect((await call('POST', `/webhooks/${encodeURIComponent(id)}/rotate-secret`, { secret: whsec() })).s).toBe(200);
    expect((await call('POST', SEAM, { webhookId: id, overlapSeconds: 3 })).s).toBe(200);
    expect((await call('POST', SEAM, { webhookId: id, overlapSeconds: 30 })).s).toBe(400);
    expect((await call('POST', SEAM, { webhookId: id, overlapSeconds: 61 })).s).toBe(400);
  });

  it('refuses a subscription that did not opt in', async () => {
    const id = register(false);
    expect((await call('POST', SEAM, { webhookId: id, overlapSeconds: 3 })).s).toBe(400);
  });
});
