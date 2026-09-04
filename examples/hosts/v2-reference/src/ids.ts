/**
 * identity.md §5 — identifier grammars (schemas/v2/ids.schema.json). Host-minted
 * opaque segments are `^[A-Za-z0-9._~-]{16,128}$`; tenant-bound kinds are
 * `<tenantId>/<opaque>` and a host MUST reject a tenant segment that is not
 * the caller's with 403 id_tenant_mismatch (without disclosing existence).
 */
import { randomBytes } from 'node:crypto';
import { err } from './errors.js';

export const OPAQUE = /^[A-Za-z0-9._~-]{16,128}$/;
export const TENANT_BOUND = /^[A-Za-z0-9._~-]{1,128}\/[A-Za-z0-9._~-]{16,128}$/;
export const TENANT_ID = /^[A-Za-z0-9._~-]{1,128}$/;
export const NODE_ID = /^[A-Za-z0-9._~:-]{1,128}$/;
export const WORKFLOW_ID = NODE_ID;
export const KEY_ID = /^[A-Za-z0-9._~-]{1,128}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{22,128}$/;
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** 24 base64url characters (144 bits) — inside the opaque grammar, no `/`, no `@`. */
export function opaque(): string {
  return randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9._~-]/g, 'x');
}

export function tenantBound(tenant: string): string {
  return `${tenant}/${opaque()}`;
}

/** Split a tenant-bound id; throws 403 id_tenant_mismatch when the segment is not the caller's. */
export function checkTenantBound(id: string, tenant: string, kind: string): { tenant: string; opaque: string } {
  const slash = id.indexOf('/');
  if (slash <= 0) throw err('not_found', `${kind} ${id} is not a tenant-bound id`);
  const t = id.slice(0, slash);
  const o = id.slice(slash + 1);
  if (!TENANT_ID.test(t) || !OPAQUE.test(o)) throw err('not_found', `${kind} not found`);
  if (t !== tenant) throw err('id_tenant_mismatch', `the ${kind}'s tenant segment is not the caller's`);
  return { tenant: t, opaque: o };
}

export function nowIso(): string {
  return new Date().toISOString();
}
