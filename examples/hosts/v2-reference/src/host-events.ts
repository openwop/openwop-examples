/**
 * RFC 0236 — host events: events that belong to no run (`events.md` §Host events).
 *
 * A host event's envelope has no `runId` and no `sequence`; it rides
 * `/host/events` beside the heartbeat messages. This host emits no host event
 * of its own, so it advertises only the two `example.*` types the conformance
 * seam (§G) drives — one durable, one ephemeral — and only when the seams
 * profile is mounted and the installed contract defines the family.
 *
 * - Tenant scope (§D): a frame reaches only subscribers of the event's tenant.
 * - Ephemeral (§C): never stored, framed without `id:`, never replayed on
 *   reconnect, never fanned out to webhooks.
 * - Durable (§C, §E): framed with `id:` = `eventId`, kept in a bounded per-host
 *   ring so `Last-Event-ID` resumes, and delivered to webhook subscriptions that
 *   name the type.
 */

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Host } from './host.js';
import { nowIso } from './ids.js';
import { fanOutHostEvent } from './webhooks.js';

export const EXAMPLE_DURABLE = 'example.thing-happened';
export const EXAMPLE_EPHEMERAL = 'example.thing-noticed';
const RETAINED = 500;

export interface HostEventType { readonly type: string; readonly delivery: 'durable' | 'ephemeral' }
export interface HostEvent {
  readonly eventId: string;
  readonly type: string;
  readonly timestamp: string;
  readonly delivery: 'durable' | 'ephemeral';
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

/** The advertised `hostEvents.types[]`; empty means the family is not advertised. */
export function hostEventTypes(host: Host): HostEventType[] {
  if (!host.artifacts.hostEventsFamily || !host.config.seamsProfile) return [];
  return [{ type: EXAMPLE_DURABLE, delivery: 'durable' }, { type: EXAMPLE_EPHEMERAL, delivery: 'ephemeral' }];
}

interface Subscriber { readonly tenant: string; readonly res: ServerResponse }
const subscribers = new Set<Subscriber>();
const retained: Array<{ tenant: string; event: HostEvent }> = [];

const frame = (e: HostEvent): string => `event: ${e.type}\n${e.delivery === 'durable' ? `id: ${e.eventId}\n` : ''}data: ${JSON.stringify(e)}\n\n`;

/**
 * Attach a `/host/events` subscriber. With a `Last-Event-ID` naming a retained
 * durable event of the caller's tenant, the durable events after it are written
 * first; an ephemeral event is never among them, because it was never retained.
 */
export function attachHostEventSubscriber(tenant: string, res: ServerResponse, lastEventId: string | null): () => void {
  if (lastEventId !== null) {
    const at = retained.findIndex((r) => r.event.eventId === lastEventId && r.tenant === tenant);
    if (at >= 0) for (const r of retained.slice(at + 1)) if (r.tenant === tenant) res.write(frame(r.event));
  }
  const sub: Subscriber = { tenant, res };
  subscribers.add(sub);
  return () => { subscribers.delete(sub); };
}

/** Produce one host event of an advertised type under `tenant` (the §G seam's production path). */
export function publishHostEvent(host: Host, tenant: string, type: string, workspaceId: string | undefined): HostEvent {
  const advertised = hostEventTypes(host).find((t) => t.type === type);
  if (advertised === undefined) throw new Error(`unadvertised host-event type ${type}`);
  const event: HostEvent = {
    eventId: `hev-${randomBytes(12).toString('hex')}`,
    type,
    timestamp: nowIso(),
    delivery: advertised.delivery,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    payload: { emittedBy: 'conformance-seam' },
  };
  host.validate('host-event', event, `host event ${type}`);
  for (const s of subscribers) if (s.tenant === tenant) s.res.write(frame(event));
  if (event.delivery === 'durable') {
    retained.push({ tenant, event });
    if (retained.length > RETAINED) retained.splice(0, retained.length - RETAINED);
    fanOutHostEvent(host, tenant, event);
  }
  return event;
}
