/**
 * interop.md — A2A and MCP are compositions over the wire, and negotiation is
 * a protocol: authenticated, floored, and audited on the host's own event log.
 *
 * This is the host's REAL client path for both protocols. The §22/§23 seams
 * (host-sample-test-seams.md) drive the same functions the production path
 * uses; nothing here hand-writes a version header for the seam's benefit.
 *
 *   A2A  — reads the peer's Agent Card (1.0 `supportedInterfaces[]` or the
 *          0.3 top-level `protocolVersion`), decides, then `SendMessage` over
 *          JSON-RPC with `A2A-Version: <negotiated>`.
 *   MCP  — `server/discover` under `MCP-Protocol-Version: <preferred>` (a
 *          -32022 answer carries the server's `supported[]`), decides, then
 *          `tools/call` with the negotiated revision in the header AND in
 *          `_meta`, looping MRTR `input_required` rounds up to `mrtr.maxRounds`.
 *
 * The decision (interop.md §Negotiation is a protocol):
 *   - the candidate is the requested version, else `preferredVersion`;
 *   - a version this host does not speak, or below the floor, is refused
 *     (`interop_version_unsupported`, reason below-floor | unsupported);
 *   - the highest version both sides speak is negotiated; landing below
 *     `preferredVersion` on an unauthenticated exchange is refused
 *     (reason unauthenticated);
 *   - every outcome emits `negotiation.decided` with the peer ORIGIN digested.
 */
import { createHash } from 'node:crypto';
import { err } from './errors.js';
import { guardedRequest } from './egress.js';
import { appendEvent } from './events.js';
import { nowIso, tenantBound } from './ids.js';
import { EVENT_LOG_SCHEMA_VERSION } from './config.js';
import type { Host, Subject } from './host.js';
import type { RunRow } from './store.js';

/** The date this host's advertised versions were last re-evaluated against the upstream registries (interop.md §The refresh SLA: ≤ 90 days). */
export const INTEROP_REFRESHED_AT = '2026-09-18';
export const A2A_FACET = { versions: ['1.0'], preferredVersion: '1.0', minimumVersion: '1.0', refreshedAt: INTEROP_REFRESHED_AT, streaming: false, pushNotifications: false, durableTasks: false } as const;
export const MCP_FACET = { revisions: ['2026-07-28'], preferredVersion: '2026-07-28', minimumRevision: '2026-07-28', refreshedAt: INTEROP_REFRESHED_AT, mrtr: { maxRounds: 4 } } as const;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPS = 'io.modelcontextprotocol/clientCapabilities';

type Protocol = 'a2a' | 'mcp';
type Decision = { outcome: 'accepted'; version: string } | { outcome: 'refused'; reason: 'below-floor' | 'unauthenticated' | 'unsupported' };

/** A2A `<major>.<minor>` and MCP `YYYY-MM-DD` both order lexically by numeric parts. */
function lt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number); const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] ?? 0; const y = pb[i] ?? 0; if (x !== y) return x < y; }
  return false;
}

export function decide(hostVersions: readonly string[], preferred: string, floor: string, peerOffers: readonly string[], requested: string | undefined, authenticated: boolean): Decision {
  const candidate = requested ?? preferred;
  if (lt(candidate, floor)) return { outcome: 'refused', reason: 'below-floor' };
  if (!hostVersions.includes(candidate)) return { outcome: 'refused', reason: 'unsupported' };
  const common = hostVersions.filter((v) => peerOffers.includes(v) && !lt(v, floor) && !lt(candidate, v)).sort((a, b) => (lt(a, b) ? 1 : -1));
  const chosen = common[0];
  if (chosen === undefined) return { outcome: 'refused', reason: peerOffers.every((v) => lt(v, floor)) ? 'below-floor' : 'unsupported' };
  if (lt(chosen, preferred) && !authenticated) return { outcome: 'refused', reason: 'unauthenticated' };
  return { outcome: 'accepted', version: chosen };
}

export const originDigest = (url: string): string => createHash('sha256').update(new URL(url).origin, 'utf8').digest('hex');

/** The audit log for an exchange: a completed run under the caller's tenant whose only rows are the decision(s) — addressable through `/runs/{id}/events/poll`. */
function auditRun(host: Host, tenant: string, subject: Subject | null): RunRow {
  const now = nowIso();
  const run: RunRow = {
    run_id: tenantBound(tenant), tenant, workflow_id: 'conformance-noop', status: 'completed', era: EVENT_LOG_SCHEMA_VERSION,
    owner_json: JSON.stringify({ tenant, subject: subject ?? { issuer: 'urn:openwop-v2-reference:host', subjectId: 'interop', tenant, lane: 'workload', kind: 'workload' } }),
    options_json: '{}', inputs_json: '{}', created_at: now, updated_at: now, started_at: now, completed_at: now, current_node_id: null, error_json: null,
    source_run_id: null, fork_mode: null, from_seq: null, compensation_json: null, pause_requested: 0, cancel_requested: 0, pin_checked: 1, scope_id: null,
  };
  host.store.insertRun(run);
  return run;
}

export function audit(host: Host, run: RunRow, protocol: Protocol, peerUrl: string, floor: string, d: Decision): void {
  appendEvent(host, run, 'negotiation.decided', { protocol, outcome: d.outcome, ...(d.outcome === 'accepted' ? { version: d.version, reason: 'ok' } : { reason: d.reason }), floor, peerDigest: originDigest(peerUrl), at: nowIso() });
}

async function post(host: Host, url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await guardedRequest(new URL(url), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate });
  let json: Record<string, unknown> | null = null;
  try { json = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null; } catch { json = null; }
  return { status: res.status, json };
}
async function get(host: Host, url: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await guardedRequest(new URL(url), { method: 'GET', headers: { Accept: 'application/json', ...headers }, timeoutMs: 5000, allowPrivate: host.config.webhookAllowPrivate });
  let json: Record<string, unknown> | null = null;
  try { json = res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null; } catch { json = null; }
  return { status: res.status, json };
}

function refuse(protocol: Protocol, requested: string, supported: readonly string[], runId: string, reason: string): never {
  throw err('interop_version_unsupported', `${protocol} negotiation refused: ${reason}`, { protocol, requested, supported: [...supported], runId, reason });
}

/** §22 — the A2A client path, once, against `peerUrl`. */
export async function a2aInvoke(host: Host, tenant: string, subject: Subject | null, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const peerUrl = typeof body['peerUrl'] === 'string' ? body['peerUrl'] : null;
  if (!peerUrl) throw err('validation_error', 'peerUrl is REQUIRED');
  const authenticated = body['authenticated'] !== false;
  const requested = typeof body['requestVersion'] === 'string' ? body['requestVersion'] : undefined;
  const run = auditRun(host, tenant, subject);
  // The Agent Card, asked for under the preferred version: a 1.0 card lists supportedInterfaces[]; a 0.3 card carries one protocolVersion.
  const card = await get(host, `${peerUrl.replace(/\/$/, '')}/.well-known/agent-card.json`, { 'A2A-Version': A2A_FACET.preferredVersion });
  let offers: string[] = [];
  let rpcUrl = `${peerUrl.replace(/\/$/, '')}/a2a/jsonrpc`;
  if (card.json) {
    const ifaces = Array.isArray(card.json['supportedInterfaces']) ? (card.json['supportedInterfaces'] as Array<Record<string, unknown>>) : [];
    offers = ifaces.map((i) => String(i['protocolVersion'] ?? '')).filter((v) => /^[0-9]+\.[0-9]+$/.test(v));
    if (offers.length === 0 && typeof card.json['protocolVersion'] === 'string') offers = [card.json['protocolVersion'].split('.').slice(0, 2).join('.')];
    const first = ifaces.find((i) => typeof i['url'] === 'string')?.['url'] ?? card.json['url'];
    if (typeof first === 'string') rpcUrl = first;
  }
  if (typeof body['peerOffersOnly'] === 'string') offers = offers.filter((v) => v === body['peerOffersOnly']);
  const d = decide(A2A_FACET.versions, A2A_FACET.preferredVersion, A2A_FACET.minimumVersion, offers, requested, authenticated);
  audit(host, run, 'a2a', peerUrl, A2A_FACET.minimumVersion, d);
  if (d.outcome === 'refused') refuse('a2a', requested ?? A2A_FACET.preferredVersion, A2A_FACET.versions, run.run_id, d.reason);
  const rpc = await post(host, rpcUrl, { 'A2A-Version': d.version }, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'user', parts: [{ text: 'ping' }] } } });
  const rpcError = rpc.json?.['error'];
  if (rpc.status >= 400 || rpcError) throw err('validation_error', `the peer refused SendMessage under A2A-Version ${d.version}`, { peerStatus: rpc.status, error: rpcError ?? null, runId: run.run_id });
  return { status: 200, body: { negotiatedVersion: d.version, protocol: 'a2a', runId: run.run_id, peerDigest: originDigest(peerUrl), result: rpc.json?.['result'] ?? null } };
}

/** §23 — the MCP client path, once, against `serverUrl`; MRTR rounds capped by the advertised ceiling. */
export async function mcpInvoke(host: Host, tenant: string, subject: Subject | null, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const serverUrl = typeof body['serverUrl'] === 'string' ? body['serverUrl'] : null;
  if (!serverUrl) throw err('validation_error', 'serverUrl is REQUIRED');
  const authenticated = body['authenticated'] !== false;
  const requested = typeof body['requestVersion'] === 'string' ? body['requestVersion'] : undefined;
  const tool = typeof body['tool'] === 'string' ? body['tool'] : 'echo';
  const args = body['arguments'] !== null && typeof body['arguments'] === 'object' ? (body['arguments'] as Record<string, unknown>) : { text: 'ping' };
  const clientCaps = body['clientCapabilities'] !== null && typeof body['clientCapabilities'] === 'object' ? (body['clientCapabilities'] as Record<string, unknown>) : {};
  const answer = body['elicitationAnswer'] !== null && typeof body['elicitationAnswer'] === 'object' ? (body['elicitationAnswer'] as Record<string, unknown>) : null;
  const run = auditRun(host, tenant, subject);
  // Discover under the preferred revision. A server that does not speak it answers -32022 with supported[]; that IS its offer.
  const disc = await post(host, serverUrl, { 'MCP-Protocol-Version': MCP_FACET.preferredVersion }, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  let offers: string[] = [];
  const result = disc.json?.['result'] as Record<string, unknown> | undefined;
  const error = disc.json?.['error'] as { data?: { supported?: unknown } } | undefined;
  if (result && Array.isArray(result['supportedVersions'])) offers = (result['supportedVersions'] as unknown[]).map(String);
  else if (error && Array.isArray(error.data?.supported)) offers = (error.data?.supported as unknown[]).map(String);
  const d = decide(MCP_FACET.revisions, MCP_FACET.preferredVersion, MCP_FACET.minimumRevision, offers, requested, authenticated);
  audit(host, run, 'mcp', serverUrl, MCP_FACET.minimumRevision, d);
  if (d.outcome === 'refused') refuse('mcp', requested ?? MCP_FACET.preferredVersion, MCP_FACET.revisions, run.run_id, d.reason);
  const headers = { 'MCP-Protocol-Version': d.version };
  const meta = { [META_VERSION]: d.version, [META_CLIENT_CAPS]: clientCaps };
  let rounds = 0; let inputRequiredSeen = false; let retried = false; let requestStateEchoed = false;
  let params: Record<string, unknown> = { name: tool, arguments: args, _meta: meta };
  for (;;) {
    const res = await post(host, serverUrl, headers, { jsonrpc: '2.0', id: 2 + rounds, method: 'tools/call', params });
    const r = res.json?.['result'] as Record<string, unknown> | undefined;
    const e = res.json?.['error'];
    if (!r || e) throw err('validation_error', `the MCP server refused tools/call under ${d.version}`, { serverStatus: res.status, error: e ?? null, runId: run.run_id });
    if (r['resultType'] !== 'input_required') {
      return { status: 200, body: { negotiatedVersion: d.version, protocol: 'mcp', runId: run.run_id, peerDigest: originDigest(serverUrl), result: r, ...(inputRequiredSeen ? { mrtr: { inputRequiredSeen, retried, requestStateEchoed, rounds, result: r } } : {}) } };
    }
    inputRequiredSeen = true;
    rounds += 1;
    // interop.md §The MCP round ceiling: an input_required round beyond maxRounds is refused, and the server never sees the retry.
    if (rounds > MCP_FACET.mrtr.maxRounds) throw err('mcp_mrtr_rounds_exceeded', `MRTR round ${rounds} exceeds mcp.mrtr.maxRounds ${MCP_FACET.mrtr.maxRounds}`, { rounds, maxRounds: MCP_FACET.mrtr.maxRounds, runId: run.run_id });
    const requests = (r['inputRequests'] ?? {}) as Record<string, unknown>;
    const inputResponses: Record<string, unknown> = {};
    for (const key of Object.keys(requests)) inputResponses[key] = answer ? { action: 'accept', content: answer } : { action: 'decline' };
    retried = true; requestStateEchoed = typeof r['requestState'] === 'string';
    params = { name: tool, arguments: args, inputResponses, requestState: r['requestState'], _meta: meta };
  }
}
