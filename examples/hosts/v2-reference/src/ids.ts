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

/**
 * identity.md §5 / RFC 0184 — on the wire a tenant-bound id is ONE path
 * segment: every UTF-8 byte outside `[A-Za-z0-9._-]` becomes `~` + two
 * uppercase hex digits (`acme/r-9f3c…` → `acme~2Fr-9f3c…`). `~` is the escape
 * because RFC 3986 §2.3 makes it unreserved, so no intermediary rewrites it —
 * which is exactly what `%2F` cannot promise. The codec is deliberately NOT
 * idempotent (the marker escapes itself), so a host MUST project exactly once,
 * where the id leaves it, and MUST NOT re-encode its own output.
 */
const PROJECTION_PASSTHROUGH = /^[A-Za-z0-9._-]$/;
export function projectBoundId(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && PROJECTION_PASSTHROUGH.test(ch) ? ch : `~${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The accept side. A `~` not introducing two hex digits is malformed input —
 * 400 validation_error, not 404: the request never named a run. Applied once,
 * before the grammar is matched, so a double-projected segment decodes to an id
 * that still carries `~2F` (no slash), resolves under the caller's tenant as a
 * bare id, and is not found — the codec's non-idempotence made visible.
 */
export function unprojectBoundId(segment: string): string {
  if (!segment.includes('~')) return segment;
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] !== '~') continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))) {
      throw err('validation_error', `bound-id projection: '~' at index ${i} is not followed by two hex digits (identity.md §5)`, { segment });
    }
    i += 2;
  }
  const bytes: number[] = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === '~') { bytes.push(parseInt(segment.slice(i + 1, i + 3), 16)); i += 3; }
    else { bytes.push(...new TextEncoder().encode(segment[i] as string)); i += 1; }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw err('validation_error', 'bound-id projection: the escaped bytes are not valid UTF-8 (identity.md §5)', { segment });
  }
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
