/**
 * RFC 0209 — `ui.a2ui-surface` at per-kind schema version 2 (A2UI v0.9
 * messages in the OpenWOP profile of the basic catalog), spec/v2/ext/a2uiSurface/README.md.
 *
 * This is the host's ONE envelope-admission path for the kind. The v2
 * emit-surface seam (`emitA2uiSurface`, api/seams-v2.yaml) only supplies the
 * envelope; everything below is what production admission does:
 *
 *   1. the AI envelope shape (schemas/v2/ai-envelope.schema.json);
 *   2. the envelope-kind catalog, read in order (events.md §"The envelope-kind
 *      catalog"): `supportedEnvelopes.kinds` → `schemaVersions.kinds` floor →
 *      `envelopeStrictness.mode` below the floor;
 *   3. validation against the ONE branch the version selects — never the anyOf union;
 *   4. the two cross-field rules the schema cannot express (§A.2);
 *   5. the surface-fold guard (§C.9), read from the run's own recorded log;
 *   6. E2 re-emission (same correlationId ⇒ the cached outcome);
 *   7. recording, with the envelope's trust carried on the row (§C.12).
 *
 * A recorded surface is an event of the host-extension type
 * `openwop-v2-reference.a2ui-surface-recorded` whose payload carries the envelope
 * verbatim: v2 registers no event type for an admitted envelope, and a reader
 * returns recorded envelopes as recorded (§C.11) — nothing here re-validates on read.
 *
 * The approval gate reads the same log: an `approval` interrupt at node N does
 * not advance while any surface bound to N (envelope `nodeId`) has an untrusted
 * envelope anywhere in its fold (§C.12, invariant a2ui-untrusted-blocks-approval).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { err } from './errors.js';
import { appendEvent, readEvents } from './events.js';
import { EXTENSION_ORG } from './config.js';
import { TERMINAL, type Host } from './host.js';
import type { RunRow } from './store.js';

export const A2UI_KIND = 'ui.a2ui-surface';
/** schemaVersions.kinds["ui.a2ui-surface"] — this host admits schema version 2. */
export const A2UI_FLOOR = 2;
export const RECORDED_TYPE = `${EXTENSION_ORG}.a2ui-surface-recorded`;

type Json = Record<string, unknown>;
type Check = (doc: unknown) => { ok: boolean; errors: string };

export interface A2uiAdmission {
  readonly strictness: 'warn' | 'strict';
  envelope: Check;
  branch(version: 1 | 2): Check;
}

interface AjvLike {
  addSchema(schema: object): unknown;
  compile(schema: object): ((d: unknown) => boolean) & { errors?: unknown };
  errorsText(errors: unknown, opts: { separator: string }): string;
}

/**
 * Compile the validators once at boot. Returns null when Ajv is not installed:
 * the host then has no way to enforce the closed profile, so it does not
 * advertise the kind and does not mount the seam (discovery.ts, seams.ts).
 */
export async function createA2uiAdmission(schemasDir: string, strictness: 'warn' | 'strict'): Promise<A2uiAdmission | null> {
  let ajv: AjvLike;
  try {
    const mod = (await import('ajv/dist/2020.js')) as unknown as { Ajv2020?: new (o: object) => AjvLike; default?: { Ajv2020?: new (o: object) => AjvLike } | (new (o: object) => AjvLike) };
    const Ctor = mod.Ajv2020 ?? (mod.default as { Ajv2020?: new (o: object) => AjvLike } | undefined)?.Ajv2020 ?? (mod.default as new (o: object) => AjvLike);
    ajv = new Ctor({ allErrors: true, strict: false });
    try { ((await import('ajv-formats')) as unknown as { default: (a: AjvLike) => void }).default(ajv); } catch { /* formats optional */ }
  } catch {
    return null;
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.schema.json') ? [p] : []; });
  for (const p of walk(schemasDir)) { try { ajv.addSchema(JSON.parse(readFileSync(p, 'utf8')) as object); } catch { /* duplicate $id */ } }
  const kind = JSON.parse(readFileSync(join(schemasDir, 'envelopes', `${A2UI_KIND}.schema.json`), 'utf8')) as { $defs?: Json };
  // A corpus without RFC 0209's payloadV2 branch cannot be admitted against — do not advertise version 2 over it.
  if (kind.$defs?.['payloadV2'] === undefined) return null;
  const check = (schema: object): Check => { const v = ajv.compile(schema); return (doc) => ({ ok: v(doc), errors: ajv.errorsText(v.errors, { separator: '; ' }).slice(0, 800) }); };
  const branchOf = (def: 'payloadV1' | 'payloadV2'): Check => check({ $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: `#/$defs/${def}`, $defs: kind.$defs });
  const v1 = branchOf('payloadV1');
  const v2 = branchOf('payloadV2');
  const envelope = check({ $ref: 'https://openwop.dev/spec/v2/ai-envelope.schema.json' });
  return { strictness, envelope, branch: (version) => (version >= 2 ? v2 : v1) };
}

interface Recorded { sequence: number; nodeId?: string; correlationId: string; type: string; surfaceId: string | null; trust: string; version: number; messages: Json[] }

function recorded(host: Host, run: RunRow): Recorded[] {
  return readEvents(host, run).filter((e) => e.type === RECORDED_TYPE).map((e) => {
    const p = e.payload as { envelope: Json; trust: string; version: number };
    const payload = p.envelope['payload'] as Json;
    return {
      sequence: e.sequence,
      ...(typeof p.envelope['nodeId'] === 'string' ? { nodeId: p.envelope['nodeId'] as string } : {}),
      correlationId: String(p.envelope['correlationId']),
      type: String(p.envelope['type']),
      surfaceId: typeof payload?.['surfaceId'] === 'string' ? (payload['surfaceId'] as string) : null,
      trust: p.trust,
      version: p.version,
      messages: Array.isArray(payload?.['messages']) ? (payload['messages'] as Json[]) : [],
    };
  });
}

const messageKind = (m: Json): string => Object.keys(m).find((k) => k !== 'version') ?? '';

/** §C.9: apply `messages` to the fold of `surfaceId` as recorded so far; the first violation, or null. */
function foldViolation(prior: Recorded[], surfaceId: string, messages: Json[]): string | null {
  let state: 'absent' | 'live' | 'deleted' = 'absent';
  const step = (kind: string): string | null => {
    if (kind === 'createSurface') {
      if (state === 'live') return `createSurface for the live surface ${surfaceId}`;
      state = 'live';
      return null;
    }
    if (state === 'absent') return `the first envelope for surface ${surfaceId} does not begin with createSurface (got ${kind})`;
    if (state === 'deleted') return `${kind} follows deleteSurface for ${surfaceId} without a new createSurface`;
    if (kind === 'deleteSurface') state = 'deleted';
    return null;
  };
  for (const r of prior) if (r.version >= 2 && r.surfaceId === surfaceId) for (const m of r.messages) step(messageKind(m));
  for (const m of messages) { const v = step(messageKind(m)); if (v !== null) return v; }
  return null;
}

/** Admit one `ui.a2ui-surface` envelope into `run`; returns the recording event's sequence. */
export function admitSurface(host: Host, adm: A2uiAdmission, run: RunRow, envelope: unknown): { sequence: number } {
  if (TERMINAL.has(run.status)) throw err('run_terminal', `the run is ${run.status}; nothing more is recorded in its log`);
  const shape = adm.envelope(envelope);
  if (!shape.ok) throw err('validation_error', `the envelope fails schemas/v2/ai-envelope.schema.json: ${shape.errors}`);
  const env = envelope as Json;
  const type = String(env['type']);
  // Catalog: this host lists exactly one non-universal kind, and the seam only carries surfaces.
  if (type !== A2UI_KIND) throw err('unknown_envelope_kind', `${type} is not in supportedEnvelopes.kinds`, { type, kinds: [A2UI_KIND] });
  // E2: a re-emission returns the cached outcome and records nothing.
  const prior = recorded(host, run);
  const correlationId = String(env['correlationId']);
  const again = prior.find((r) => r.correlationId === correlationId);
  if (again !== undefined) {
    if (again.type !== type) throw err('envelope_correlation_conflict', `correlationId ${correlationId} was recorded with type ${again.type}`);
    return { sequence: again.sequence };
  }
  // Floor, then strictness below it (events.md §"The envelope-kind catalog").
  const emitted = typeof env['schemaVersion'] === 'number' ? (env['schemaVersion'] as number) : 0;
  if (emitted > A2UI_FLOOR) throw err('unknown_schema_version', `schemaVersion ${emitted} is above the advertised floor ${A2UI_FLOOR} for ${A2UI_KIND}`, { kind: A2UI_KIND, schemaVersion: emitted, floor: A2UI_FLOOR });
  let version: 1 | 2 = emitted >= 2 ? 2 : 1;
  if (emitted < A2UI_FLOOR) {
    if (adm.strictness === 'strict') throw err('unknown_schema_version', `schemaVersion ${emitted} is below the advertised floor ${A2UI_FLOOR} and envelopeStrictness is strict`, { kind: A2UI_KIND, schemaVersion: emitted, floor: A2UI_FLOOR });
    // warn: validate against the ADVERTISED version and log the drift.
    version = 2;
    process.stderr.write(`[envelope] envelope_schema_version_drift ${A2UI_KIND} run=${run.run_id} emitted=${emitted} floor=${A2UI_FLOOR}\n`);
  }
  // One branch — the one the version selects. Never the union.
  const payload = env['payload'];
  const branch = adm.branch(version)(payload);
  if (!branch.ok) throw err('envelope_invalid', `the payload fails $defs/payloadV${version} of ${A2UI_KIND}: ${branch.errors}`, { rule: 'branch', schemaVersion: version });
  const p = payload as Json;
  const surfaceId = String(p['surfaceId']);
  const messages = p['messages'] as Json[];
  for (const [i, m] of messages.entries()) {
    const body = m[messageKind(m)] as Json;
    if (body['surfaceId'] !== surfaceId) throw err('envelope_invalid', `messages[${i}].surfaceId differs from the payload surfaceId (RFC 0209 §A.2)`, { rule: 'surface-id-equality', index: i });
    if (messageKind(m) === 'createSurface' && body['catalogId'] !== p['catalogId']) throw err('envelope_invalid', `messages[${i}].createSurface.catalogId differs from the payload catalogId (RFC 0209 §A.2)`, { rule: 'catalog-equality', index: i });
  }
  const violation = foldViolation(prior, surfaceId, messages);
  if (violation !== null) throw err('envelope_invalid', `${violation} (RFC 0209 §C.9)`, { rule: 'fold', surfaceId });
  const meta = env['meta'] as Json;
  const trust = meta['contentTrust'] === 'untrusted' ? 'untrusted' : 'trusted';
  const doc = appendEvent(host, run, RECORDED_TYPE, { envelope: env, version, trust }, {
    ...(typeof env['nodeId'] === 'string' ? { nodeId: env['nodeId'] as string } : {}),
    causationId: correlationId,
  });
  return { sequence: doc.sequence };
}

/**
 * §C.12: the surfaces bound to `nodeId` whose fold holds an untrusted envelope.
 * Sticky by construction — every recorded envelope of the surface is read, so a
 * later trusted update does not launder an earlier untrusted one.
 */
export function taintedSurfaces(host: Host, run: RunRow, nodeId: string): string[] {
  const all = recorded(host, run);
  const bound = new Set(all.filter((r) => r.nodeId === nodeId && r.surfaceId !== null).map((r) => r.surfaceId as string));
  const tainted = new Set<string>();
  // Any envelope for a bound surface counts, whichever node emitted it: one untrusted update taints a surface a trusted node created.
  for (const r of all) if (r.surfaceId !== null && bound.has(r.surfaceId) && r.trust === 'untrusted') tainted.add(r.surfaceId);
  return [...tainted].sort();
}
