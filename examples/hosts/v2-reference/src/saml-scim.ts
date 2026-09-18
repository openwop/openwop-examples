/**
 * The `saml` and `scim` lanes and the subject-link record (RFC 0159 §A,
 * RFC 0163 §A/§B, identity.md §3 "The link is a record",
 * schemas/v2/subject-link.schema.json), driven through the RFC 0050 seams
 * (host-sample-test-seams.md: sample/auth/saml/validate,
 * sample/auth/scim/provision) plus sample/auth/subject-links.
 *
 * The SAML validator is the host's genuine ACS for the assertion format the
 * suite's synthetic IdP mints (conformance/src/lib/saml-idp.ts): RSA-SHA256
 * over the canonical signed element, the <ds:Reference> bound to the CONSUMED
 * assertion (anti-wrapping), the validity window, alg:none refused, and the
 * <saml:Issuer> inside the signed bytes so the trust root cannot be swapped.
 * Nothing here decides on the `variant` name.
 *
 * Trust roots (RFC 0163 §B): `idpUrl` names the IdP; its entityID and
 * certificate are read from `{idpUrl}/metadata`. A SCIM connection
 * (`scimUrl`) binds the entityID it is fed by at `create-user`; a link forms
 * only when the assertion's signed Issuer equals that entityID and the
 * persistent NameID equals the SCIM externalId (key class `opaque-idp`).
 * Deactivation sets `deniedAt` and the SAML decision fails closed after it
 * (RFC 0159 §A.3).
 */
import { createHash, createVerify } from 'node:crypto';
import { err } from './errors.js';
import { opaque } from './ids.js';
import { guardedRequest } from './egress.js';

export const SUBJECT_LINK_KEY = 'opaque-idp' as const;
export const SAML_LANE_ISSUER = 'urn:openwop:conformance:idp';

interface IdpMeta { entityID: string; certificatePem: string }
interface ScimConnection { scimUrl: string; entityID: string }
interface Principal { subjectId: string; externalId: string; userName: string; scimUrl: string; deactivatedAt: string | null }
export interface SubjectLink { a: { issuer: string; subjectId: string }; b: { issuer: string; subjectId: string }; keyClass: typeof SUBJECT_LINK_KEY; issuer: string; tenant: string; formedAt: string; deniedAt?: string }

const idps = new Map<string, IdpMeta>();
const connections = new Map<string, ScimConnection>();
const principals = new Map<string, Principal>(); // key `${tenant}|${externalId}`
const links = new Map<string, SubjectLink>();

async function fetchJson(url: string, allowPrivate: boolean): Promise<Record<string, unknown>> {
  const res = await guardedRequest(new URL(url), { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 5000, allowPrivate });
  if (res.status < 200 || res.status >= 300 || !res.body) throw err('validation_error', `the synthetic IdP at ${url} answered ${res.status}`, { url });
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function idpMeta(idpUrl: string, allowPrivate: boolean): Promise<IdpMeta> {
  const cached = idps.get(idpUrl);
  if (cached) return cached;
  const m = await fetchJson(`${idpUrl.replace(/\/$/, '')}/metadata`, allowPrivate);
  if (typeof m['entityID'] !== 'string' || typeof m['certificatePem'] !== 'string') throw err('validation_error', 'the IdP metadata MUST carry entityID and certificatePem', { idpUrl });
  const meta = { entityID: m['entityID'], certificatePem: m['certificatePem'] };
  idps.set(idpUrl, meta);
  return meta;
}

const SIG_ALG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SIG_ALG_NONE = 'http://www.w3.org/2000/09/xmldsig#none';
function canonicalAssertion(id: string, issuer: string, subject: string, notBefore: string, notOnOrAfter: string): string {
  return `<saml:Assertion ID="${id}" Version="2.0"><saml:Issuer>${issuer}</saml:Issuer><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"/><saml:Subject><saml:NameID>${subject}</saml:NameID></saml:Subject></saml:Assertion>`;
}
function parseConsumed(xml: string): { id: string; issuer: string; notBefore: string; notOnOrAfter: string; subject: string } | null {
  const m = /<saml:Assertion ID="([^"]+)"[^>]*>[\s\S]*?<saml:Issuer>([^<]*)<\/saml:Issuer>[\s\S]*?<saml:Conditions NotBefore="([^"]+)" NotOnOrAfter="([^"]+)"\/>[\s\S]*?<saml:NameID>([^<]*)<\/saml:NameID>/.exec(xml);
  if (m === null) return null;
  return { id: m[1] as string, issuer: m[2] as string, notBefore: m[3] as string, notOnOrAfter: m[4] as string, subject: m[5] as string };
}

/** RFC 0050 §A — the MUST list, applied to the consumed (first) assertion against the trust root's certificate. */
export function verifyAssertion(xml: string, certificatePem: string): { valid: true; issuer: string; nameId: string } | { valid: false; reason: string } {
  const consumed = parseConsumed(xml);
  if (consumed === null) return { valid: false, reason: 'malformed' };
  const sigAlg = /<ds:SignatureMethod Algorithm="([^"]+)"/.exec(xml)?.[1];
  const sigValue = /<ds:SignatureValue>([^<]*)<\/ds:SignatureValue>/.exec(xml)?.[1];
  const refId = /<ds:Reference URI="#([^"]+)"/.exec(xml)?.[1];
  const digestValue = /<ds:DigestValue>([^<]*)<\/ds:DigestValue>/.exec(xml)?.[1];
  if (sigValue === undefined || sigAlg === undefined) return { valid: false, reason: 'unsigned' };
  if (sigAlg === SIG_ALG_NONE) return { valid: false, reason: 'alg-none' };
  if (sigAlg !== SIG_ALG_RSA_SHA256) return { valid: false, reason: 'unsupported-algorithm' };
  if (refId !== consumed.id) return { valid: false, reason: 'signature-wrapping' };
  const canonical = canonicalAssertion(consumed.id, consumed.issuer, consumed.subject, consumed.notBefore, consumed.notOnOrAfter);
  if (digestValue !== undefined && digestValue !== createHash('sha256').update(canonical, 'utf8').digest('base64')) return { valid: false, reason: 'digest-mismatch' };
  let ok = false;
  try { ok = createVerify('RSA-SHA256').update(canonical, 'utf8').verify(certificatePem, sigValue, 'base64'); } catch { ok = false; }
  if (!ok) return { valid: false, reason: 'bad-signature' };
  const now = Date.now();
  if (now < Date.parse(consumed.notBefore)) return { valid: false, reason: 'not-yet-valid' };
  if (now >= Date.parse(consumed.notOnOrAfter)) return { valid: false, reason: 'expired' };
  return { valid: true, issuer: consumed.issuer, nameId: consumed.subject };
}

/** SCIM provisioning (RFC 0050 §B; RFC 0159 / 0163 extensions). The host IS the SCIM server; `scimUrl` names the connection. */
export async function scimProvision(tenant: string, body: Record<string, unknown>, allowPrivate: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const op = body['op'];
  const scimUrl = typeof body['scimUrl'] === 'string' ? body['scimUrl'] : 'default';
  if (op === 'create-user') {
    const externalId = typeof body['externalId'] === 'string' && body['externalId'].length > 0 ? body['externalId'] : `scim-${opaque()}`;
    const userName = typeof body['userName'] === 'string' ? body['userName'] : externalId;
    const idpUrl = typeof body['idpUrl'] === 'string' ? body['idpUrl'] : null;
    // RFC 0163 §B.1: the connection records the trust root that feeds it, once.
    if (!connections.has(scimUrl)) connections.set(scimUrl, { scimUrl, entityID: idpUrl ? (await idpMeta(idpUrl, allowPrivate)).entityID : SAML_LANE_ISSUER });
    const key = `${tenant}|${externalId}`;
    const existing = principals.get(key);
    const p: Principal = existing ? { ...existing, userName, deactivatedAt: null } : { subjectId: `scim-${opaque()}`, externalId, userName, scimUrl, deactivatedAt: null };
    principals.set(key, p);
    const link = links.get(key);
    return { status: existing ? 200 : 201, body: { principal: { subjectId: p.subjectId, externalId, userName, lane: 'scim', issuer: scimIssuer(scimUrl) }, ...(link ? { link } : {}) } };
  }
  if (op === 'assign-group') {
    const externalId = String(body['externalId'] ?? '');
    if (!principals.has(`${tenant}|${externalId}`)) throw err('not_found', 'no such SCIM user');
    return { status: 200, body: { assigned: true, group: String(body['group'] ?? 'default') } };
  }
  if (op === 'deactivate-user') {
    const externalId = typeof body['externalId'] === 'string' ? body['externalId'] : [...principals.values()].find((p) => p.userName === body['email'])?.externalId;
    if (!externalId) throw err('not_found', 'no such SCIM user');
    const key = `${tenant}|${externalId}`;
    const p = principals.get(key);
    if (!p) throw err('not_found', 'no such SCIM user');
    const at = new Date().toISOString();
    principals.set(key, { ...p, deactivatedAt: at });
    // RFC 0159 §A.3 / identity.md §3: the leaver deny is recorded ON the link.
    const link = links.get(key);
    if (link && link.deniedAt === undefined) links.set(key, { ...link, deniedAt: at });
    return { status: 200, body: { deactivated: true, ...(links.has(key) ? { link: links.get(key) } : {}) } };
  }
  throw err('validation_error', 'op MUST be create-user | assign-group | deactivate-user', { op });
}

function scimIssuer(scimUrl: string): string { return `urn:openwop:scim:${createHash('sha256').update(scimUrl).digest('hex').slice(0, 16)}`; }

/** The SAML ACS over the seam: resolve the variant from the IdP, validate genuinely, then apply the link contract. */
export async function samlValidate(tenant: string, body: Record<string, unknown>, allowPrivate: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const idpUrl = typeof body['idpUrl'] === 'string' ? body['idpUrl'] : null;
  const variant = typeof body['variant'] === 'string' ? body['variant'] : 'valid';
  if (idpUrl === null) throw err('validation_error', 'idpUrl is REQUIRED (the trust root)');
  const meta = await idpMeta(idpUrl, allowPrivate);
  const q = new URLSearchParams({ variant, ...(typeof body['nameId'] === 'string' ? { nameId: body['nameId'] } : {}) });
  const minted = await fetchJson(`${idpUrl.replace(/\/$/, '')}/assert?${q.toString()}`, allowPrivate);
  if (typeof minted['assertion'] !== 'string') throw err('validation_error', 'the IdP MUST answer { assertion }', { idpUrl });
  const v = verifyAssertion(minted['assertion'], meta.certificatePem);
  if (!v.valid) throw err('unauthenticated', `the SAML assertion was refused: ${v.reason}`, { reason: v.reason });
  // Link contract. The NameID is the opaque-idp key; the SCIM principal with that externalId is the other half.
  const key = `${tenant}|${v.nameId}`;
  const principal = principals.get(key);
  let link = links.get(key);
  if (!link && principal) {
    const conn = connections.get(principal.scimUrl);
    // RFC 0163 §B: same trust root or no link — the SIGNED Issuer against the connection's recorded entityID.
    if (conn && conn.entityID === v.issuer && v.issuer === meta.entityID) {
      link = { a: { issuer: v.issuer, subjectId: `saml-${createHash('sha256').update(`${v.issuer}|${v.nameId}`).digest('hex').slice(0, 24)}` }, b: { issuer: scimIssuer(principal.scimUrl), subjectId: principal.subjectId }, keyClass: SUBJECT_LINK_KEY, issuer: v.issuer, tenant, formedAt: new Date().toISOString(), ...(principal.deactivatedAt ? { deniedAt: principal.deactivatedAt } : {}) };
      links.set(key, link);
    }
  }
  if (link && link.deniedAt !== undefined) return { status: 200, body: { authenticated: false, linkedDenied: true, link } };
  return { status: 200, body: { authenticated: true, nameId: v.nameId, issuer: v.issuer, ...(link ? { link } : {}) } };
}

export function subjectLink(tenant: string, externalId: string): SubjectLink | null { return links.get(`${tenant}|${externalId}`) ?? null; }
