/**
 * Host-internal test for the RFC 0093 §A.3 webhook tenant scoping in
 * `src/webhooks.ts` (registration-time tenant column + tenant-scoped
 * unregister + tenant-filtered fan-out source query).
 *
 * The HTTP-level membership gate (403 `tenant_membership_required` on a
 * foreign tenantId) is covered black-box by the conformance suite's
 * `webhook-tenant-isolation.test.ts`; this test pins the storage-layer
 * invariants the handler relies on:
 *
 *   1. A registered subscription carries its tenant scope.
 *   2. Unregister scoped to a foreign tenant removes nothing (no
 *      cross-tenant delete, no existence leak via row count).
 *   3. Unregister scoped to the owning tenant removes the row.
 *   4. The pre-RFC-0093 table shape (no tenant_id column) migrates in
 *      place via setupWebhookSchema.
 *
 * Run with: tsx test/webhook-tenant-gate.test.ts (or `npm test`).
 *
 * @see spec/v1/webhooks.md §Endpoints
 * @see RFCS/0093-protocol-hardening-webhooks-tokens-idempotency.md §A.3
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Registration uses a public-shaped https URL so the SSRF guard passes
// without the OPENWOP_WEBHOOK_ALLOW_PRIVATE bypass.
const SAFE_URL = 'https://example.com/openwop-host-tests/webhook-tenant-gate';

const {
  setupWebhookSchema,
  registerWebhook,
  unregisterWebhook,
  DEFAULT_TENANT_ID,
} = await import('../src/webhooks.js');

// ── 1–3. Tenant-scoped register + unregister ────────────────────────────
{
  const db = new Database(':memory:');
  setupWebhookSchema(db);

  const sub = registerWebhook(db, {
    url: SAFE_URL,
    eventTypes: ['run.completed'],
    tenantId: DEFAULT_TENANT_ID,
  });
  assert.equal(sub.tenantId, DEFAULT_TENANT_ID, 'registration MUST persist the tenant scope');
  const row = db
    .prepare('SELECT tenant_id FROM webhook_subscriptions WHERE subscription_id = ?')
    .get(sub.subscriptionId) as { tenant_id: string };
  assert.equal(row.tenant_id, DEFAULT_TENANT_ID, 'tenant_id column MUST carry the scope');
  console.log('  ✓ registration persists the tenant scope');

  const foreignRemoved = unregisterWebhook(db, sub.subscriptionId, 'tenant:someone-else');
  assert.equal(foreignRemoved, false, 'a foreign tenant scope MUST NOT remove the subscription');
  const stillThere = db
    .prepare('SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE subscription_id = ?')
    .get(sub.subscriptionId) as { n: number };
  assert.equal(stillThere.n, 1, 'the subscription MUST survive a foreign-scope delete');
  console.log('  ✓ foreign-tenant unregister removes nothing');

  const ownRemoved = unregisterWebhook(db, sub.subscriptionId, DEFAULT_TENANT_ID);
  assert.equal(ownRemoved, true, 'the owning tenant scope MUST remove the subscription');
  console.log('  ✓ owning-tenant unregister removes the row');
  db.close();
}

// ── 4. Migration of the pre-RFC-0093 table shape ───────────────────────
{
  const db = new Database(':memory:');
  // Old shape: no tenant_id column.
  db.exec(`
    CREATE TABLE webhook_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      event_types TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO webhook_subscriptions (subscription_id, url, secret, event_types, created_at)
     VALUES ('wh-legacy', ?, 's3cret', '[]', '2026-01-01T00:00:00.000Z')`,
  ).run(SAFE_URL);

  setupWebhookSchema(db); // MUST add tenant_id in place

  const migrated = db
    .prepare('SELECT tenant_id FROM webhook_subscriptions WHERE subscription_id = ?')
    .get('wh-legacy') as { tenant_id: string };
  assert.equal(
    migrated.tenant_id,
    DEFAULT_TENANT_ID,
    'legacy rows MUST default into the host tenant scope',
  );
  console.log('  ✓ pre-RFC-0093 table migrates in place (legacy rows scoped to the host tenant)');
  db.close();
}

console.log('sqlite-host webhook-tenant-gate test: PASS');
