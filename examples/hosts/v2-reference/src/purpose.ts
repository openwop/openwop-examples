/**
 * security-defaults.md §Onward hops — purpose labels (RFC 0128), on the one
 * onward hop this host makes for inbound data: the conformance relay.
 *
 * A label enters on an inbound A2A message (`metadata.openwop.permittedPurposes`);
 * `SendMessage` keeps the message's text parts and label in the run's options
 * (never surfaced on a snapshot). The reserved node `core.conformance.a2a-invoke`
 * with `config.forward: "inbound-message"` sends those parts to the A2A peer the
 * operator configured (`OPENWOP_A2A_RELAY_PEER_URL`), re-emitting the label
 * unchanged. `[]` means no onward use: the node fails before any request.
 *
 * `purposePropagation` is advertised only when the relay can run: the fixture is
 * loaded and a peer is configured. No other path carries a label onward.
 */
import type { Host } from './host.js';
import type { RunRow } from './store.js';
import { err } from './errors.js';
import { post, get } from './interop.js';

export const RELAY_WORKFLOW_ID = 'conformance-purpose-relay';
export const RELAY_AGENT_ID = 'core.conformance.agent-pack.relay';

/** What the relay forwards: the inbound message's text parts and, when sent, its label. */
export interface Inbound { parts: Array<{ text: string }>; permittedPurposes?: string[] }

export const relayAvailable = (host: Host): boolean => host.workflows.has(RELAY_WORKFLOW_ID) && host.config.a2aRelayPeerUrl !== null;

/** The label an inbound message carries: absent, or an array of strings (anything else is refused). */
export function inboundLabel(metadata: Record<string, unknown> | undefined): string[] | undefined | 'invalid' {
  const openwop = metadata?.['openwop'];
  const label = openwop !== null && typeof openwop === 'object' ? (openwop as Record<string, unknown>)['permittedPurposes'] : undefined;
  if (label === undefined) return undefined;
  if (!Array.isArray(label) || label.some((p) => typeof p !== 'string')) return 'invalid';
  return label as string[];
}

export function inboundOf(parts: unknown[], label: string[] | undefined): Inbound {
  const text = parts.flatMap((p) => (typeof (p as { text?: unknown })?.text === 'string' ? [{ text: (p as { text: string }).text }] : []));
  return { parts: text, ...(label !== undefined ? { permittedPurposes: label } : {}) };
}

/** Run the relay node: send the inbound text on, carrying the label. Throws a HostError on refusal. */
export async function relay(host: Host, run: RunRow): Promise<Record<string, unknown>> {
  const inbound = (JSON.parse(run.options_json) as { a2aInbound?: Inbound }).a2aInbound;
  if (inbound === undefined) throw err('validation_error', 'the relay forwards an inbound A2A message, and this run was not started by one');
  // RFC 0128: [] permits no onward use, so nothing is sent.
  if (inbound.permittedPurposes !== undefined && inbound.permittedPurposes.length === 0) {
    throw err('forbidden', 'the inbound data is labelled permittedPurposes: [] — no onward use is permitted');
  }
  const peerUrl = host.config.a2aRelayPeerUrl;
  if (peerUrl === null) throw err('validation_error', 'no relay peer is configured (OPENWOP_A2A_RELAY_PEER_URL)');
  const base = peerUrl.replace(/\/$/, '');
  const card = await get(host, `${base}/.well-known/agent-card.json`, { 'A2A-Version': '1.0' });
  const ifaces = Array.isArray(card.json?.['supportedInterfaces']) ? (card.json!['supportedInterfaces'] as Array<Record<string, unknown>>) : [];
  const rpcUrl = ifaces.find((i) => i['protocolBinding'] === 'JSONRPC' && typeof i['url'] === 'string')?.['url'] as string | undefined ?? `${base}/a2a/jsonrpc`;
  const message: Record<string, unknown> = {
    messageId: `relay-${run.run_id.split('/')[1] ?? run.run_id}`,
    role: 'ROLE_USER',
    parts: inbound.parts,
    // §Onward hops: re-emit the received label; this host never widens or narrows it.
    ...(inbound.permittedPurposes !== undefined ? { metadata: { openwop: { permittedPurposes: [...inbound.permittedPurposes] } } } : {}),
  };
  const r = await post(host, rpcUrl, { 'A2A-Version': '1.0' }, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } });
  if (r.status === 0 || r.status >= 400 || r.json?.['error'] !== undefined) {
    throw err('validation_error', `the relay peer refused SendMessage (${r.status}${r.transportError ? `: ${r.transportError}` : ''})`, { peerStatus: r.status });
  }
  return { relayed: inbound.parts.length };
}
