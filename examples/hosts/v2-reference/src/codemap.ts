/**
 * persistence.md §The reader rule — the storage-boundary adapter. Every reader
 * (poll, SSE, fork, snapshot fold) calls `readEvents()`; an era-2 run (row `era`
 * NULL ⇒ 2, the absent-⇒-2 rule) has each row translated through
 * spec/v2/event-codemap.json here and nowhere else:
 *
 *   - `type` is mapped; a type the codemap does not name and that carries no
 *     vendor org fails the read with 500 event_type_unmapped;
 *   - `sequence` (including 0), `eventId`, `timestamp`, `causationId` pass through;
 *   - the payload is projected: a `run.started` without `owner` reads with the
 *     run's legacy Subject (identity.md §1.2), stamped once, never rewritten.
 *
 * Nothing here writes: an era-2 row is never rewritten in place.
 */
import { loadArtifacts } from './artifacts.js';
import { EVENT_SCHEMA_VERSION, EXTENSION_ORG } from './config.js';
import { err } from './errors.js';
import type { EventRow, RunRow } from './store.js';

export interface RunEventDoc {
  eventId: string;
  runId: string;
  type: string;
  payload: unknown;
  timestamp: string;
  sequence: number;
  schemaVersion: number;
  nodeId?: string;
  engineVersion?: number;
  causationId?: string;
}

export function eraOf(run: RunRow): number {
  return run.era ?? 2;
}

/** Orgs whose vendor events read under their own name (events.md §Types). */
const VENDOR_ORGS = new Set<string>([EXTENSION_ORG]);

export function translateType(v1Type: string): string {
  const art = loadArtifacts();
  const mapped = art.codemap.get(v1Type);
  if (mapped !== undefined) return mapped;
  if (art.v2EventTypes.has(v1Type)) return v1Type;
  const org = v1Type.split('.')[0] ?? '';
  if (art.vendorEventPattern.test(v1Type) && VENDOR_ORGS.has(org)) return v1Type;
  throw err('event_type_unmapped', `event type ${v1Type} is not named by spec/v2/event-codemap.json and carries no registered vendor org — the era-2 log cannot be translated`, { type: v1Type });
}

export function rowToDoc(row: EventRow, run: RunRow, owner: Record<string, unknown> | null): RunEventDoc {
  let payload: unknown = JSON.parse(row.payload_json);
  let type = row.type;
  if (eraOf(run) < 3) {
    type = translateType(row.type);
    if (type === 'run.started' && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      if (p['owner'] === undefined && owner !== null) payload = { ...p, owner };
      if (typeof p['engineVersion'] === 'string' && /^(0|[1-9][0-9]*)$/.test(p['engineVersion'])) {
        // versioning.md §2.1 — a legacy-stamped string engineVersion is normalised on read.
        payload = { ...(payload as Record<string, unknown>), engineVersion: Number(p['engineVersion']) };
      }
    }
  }
  const doc: RunEventDoc = {
    eventId: row.event_id,
    runId: row.run_id,
    type,
    payload,
    timestamp: row.timestamp,
    sequence: row.sequence,
    schemaVersion: row.schema_version || EVENT_SCHEMA_VERSION,
  };
  if (row.node_id !== null) doc.nodeId = row.node_id;
  if (row.engine_version !== null) doc.engineVersion = row.engine_version;
  if (row.causation_id !== null) doc.causationId = row.causation_id;
  return doc;
}
