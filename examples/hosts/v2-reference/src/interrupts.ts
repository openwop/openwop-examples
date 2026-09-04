/**
 * interrupt.md + identity.md §4 — one payload shape, one pair of events, one
 * resolve contract, one token scheme.
 *
 *   token = ow2.<alg>.<kid>.<payload>.<mac>   alg ∈ tokenAlgs (hs256), kid selects the secret
 *   a v1 two-segment `<payload>.<mac>` token resolves under kid `legacy` until expiresAt
 *
 * One code per state: 401 interrupt_token_invalid (alg/kid/MAC), 410
 * interrupt_expired, 409 interrupt_already_resolved (resolved, cancelled or
 * completed), 400 validation_error (resume value / action), 403 forbidden
 * (a resolver outside approversList).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { err } from './errors.js';
import { nowIso, tenantBound } from './ids.js';
import { TERMINAL, type Host, type Subject } from './host.js';
import type { InterruptRow, RunRow } from './store.js';
import { principalRef } from './identity.js';

export interface InterruptPayload {
  kind: string;
  key: string;
  data: Record<string, unknown>;
  resumeSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

interface TokenClaims { i: string; r: string; n: string; e: string; t: 'resolve' | 'inspect' }

const B64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function mac(secret: string, material: string): string {
  return createHmac('sha256', secret).update(material).digest('hex');
}

export function mintToken(host: Host, claims: TokenClaims): string {
  const kid = host.config.interruptKid;
  const payload = B64(JSON.stringify(claims));
  return `ow2.hs256.${kid}.${payload}.${mac(host.config.interruptSecret, `hs256.${kid}.${payload}`)}`;
}

/** Parse + verify a token; every refusal is one registered code (identity.md §4, interrupt.md §Tokens). */
export function verifyToken(host: Host, token: string): TokenClaims {
  const parts = token.split('.');
  let kid: string;
  let payload: string;
  let given: string;
  let material: string;
  if (parts.length === 5 && parts[0] === 'ow2') {
    const alg = parts[1] as string;
    kid = parts[2] as string;
    payload = parts[3] as string;
    given = parts[4] as string;
    if (alg !== 'hs256') throw err('interrupt_token_invalid', `alg ${alg} is not advertised in interrupt.tokenAlgs`);
    if (kid !== host.config.interruptKid && kid !== 'legacy') throw err('interrupt_token_invalid', `kid ${kid} is not held by this host`);
    material = `hs256.${kid}.${payload}`;
  } else if (parts.length === 2) {
    // A v1 two-segment token: base64url(payload).hmac — resolvable under kid `legacy`.
    kid = 'legacy';
    payload = parts[0] as string;
    given = parts[1] as string;
    material = payload;
  } else {
    throw err('interrupt_token_invalid', 'the token is outside the ow2.<alg>.<kid>.<payload>.<mac> grammar');
  }
  const secret = kid === 'legacy' ? host.config.legacyInterruptSecret : host.config.interruptSecret;
  const expected = mac(secret, material);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw err('interrupt_token_invalid', 'the token MAC does not verify');
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw err('interrupt_token_invalid', 'the token payload is not readable');
  }
  if (typeof claims.i !== 'string' || typeof claims.r !== 'string') throw err('interrupt_token_invalid', 'the token payload names no interrupt');
  if (typeof claims.e === 'string' && Date.parse(claims.e) < Date.now()) throw err('interrupt_expired', 'the token is past its expiresAt');
  return claims;
}

/** Persist the interrupt (deterministic re-entry key K at most once per run) and mint its token. */
export function mintInterrupt(host: Host, run: RunRow, nodeId: string, payload: InterruptPayload): { row: InterruptRow; token: string } {
  const existing = host.store.interruptByKey(run.run_id, payload.key);
  if (existing !== undefined) {
    return { row: existing, token: mintToken(host, { i: existing.interrupt_id, r: run.run_id, n: nodeId, e: existing.expires_at, t: 'resolve' }) };
  }
  const ttl = payload.timeoutMs !== undefined ? Math.min(payload.timeoutMs, 30 * 60_000) : 30 * 60_000;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const row: InterruptRow = {
    interrupt_id: tenantBound(run.tenant),
    run_id: run.run_id,
    node_id: nodeId,
    key: payload.key,
    kind: payload.kind,
    payload_json: JSON.stringify(payload),
    expires_at: expiresAt,
    resolved_at: null,
    resume_json: null,
    created_at: nowIso(),
  };
  host.store.insertInterrupt(row);
  return { row, token: mintToken(host, { i: row.interrupt_id, r: run.run_id, n: nodeId, e: expiresAt, t: 'resolve' }) };
}

export function payloadOf(row: InterruptRow): InterruptPayload {
  return JSON.parse(row.payload_json) as InterruptPayload;
}

function listed(list: unknown[], subject: Subject): boolean {
  const ids = new Set([subject.subjectId, principalRef(subject), `${subject.issuer}:${subject.subjectId}`]);
  return list.some((entry) => ids.has(String(entry)));
}

/**
 * The resolve contract shared by both surfaces: state checks, approver
 * enforcement (an obligation of the fields — security-defaults.md), the
 * action vocabulary and resumeSchema validation. Returns the claim outcome.
 */
export function validateResolve(host: Host, run: RunRow, row: InterruptRow, resumeValue: unknown, subject: Subject | null): { payload: InterruptPayload; decision?: string; exitsSuspend: boolean } {
  if (TERMINAL.has(run.status)) throw err('interrupt_already_resolved', `the run is ${run.status}; its interrupts are invalidated`);
  if (row.resolved_at !== null) throw err('interrupt_already_resolved', 'the interrupt was already resolved');
  const payload = payloadOf(row);
  const data = payload.data ?? {};
  if (payload.kind === 'approval') {
    const rv = resumeValue as { action?: unknown } | null;
    const action = rv !== null && typeof rv === 'object' ? String(rv.action ?? '') : '';
    const actions = Array.isArray(data['actions']) ? (data['actions'] as unknown[]).map(String) : ['accept', 'reject'];
    if (!actions.includes(action)) throw err('validation_error', `resumeValue.action MUST be one of ${actions.join(' | ')}`, { actions });
    const approvers = Array.isArray(data['approversList']) ? (data['approversList'] as unknown[]) : [];
    if (approvers.length > 0 && subject !== null && !listed(approvers, subject)) {
      throw err('forbidden', 'the resolver is not in approversList (interrupt.md §Approver enforcement)');
    }
    if (action === 'refine' && (rv as { refineFeedback?: unknown })?.refineFeedback === undefined) throw err('validation_error', 'refine requires refineFeedback');
    if (action === 'edit-accept' && (rv as { editedArtifactData?: unknown })?.editedArtifactData === undefined) throw err('validation_error', 'edit-accept requires editedArtifactData');
    return { payload, decision: action === 'reject' ? 'rejected' : 'granted', exitsSuspend: action !== 'ask' };
  }
  const schema = payload.resumeSchema;
  if (schema !== undefined) {
    const type = schema['type'];
    if (type === 'object' && (resumeValue === null || typeof resumeValue !== 'object' || Array.isArray(resumeValue))) throw err('validation_error', 'resumeValue fails resumeSchema (object expected)');
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const k of required) if ((resumeValue as Record<string, unknown>)[k] === undefined) throw err('validation_error', `resumeValue fails resumeSchema (missing ${k})`, { missing: k });
    if (type === 'string' && typeof resumeValue !== 'string') throw err('validation_error', 'resumeValue fails resumeSchema (string expected)');
  }
  if (payload.kind === 'clarification') {
    const questions = Array.isArray(data['questions']) ? (data['questions'] as Array<{ id?: string }>) : [];
    if (resumeValue === null || typeof resumeValue !== 'object') throw err('validation_error', 'a clarification resumeValue is an object keyed by question id');
    for (const q of questions) if (q.id !== undefined && (resumeValue as Record<string, unknown>)[q.id] === undefined) throw err('validation_error', `answer ${q.id} is missing`, { questionId: q.id });
  }
  return { payload, exitsSuspend: true };
}
