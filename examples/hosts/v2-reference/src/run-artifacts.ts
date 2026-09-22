/**
 * RFC 0205 — run artifacts and conversation turns as A2A `Part`s.
 *
 * `getArtifact` (`GET /runs/{runId}/artifacts/{artifactId}`, runs.md) answers
 * `application/json` with this host's own object, or — when `Accept` prefers
 * `application/a2a+json` (RFC 9110 §12.5.1) — an A2A `Artifact`
 * (`schemas/v2/artifact.schema.json`) whose `artifactId` is the path segment,
 * with `Vary: Accept`. An artifact is resolved from the run's OWN log (the
 * `artifact.created` event names it) and the node that produced it, so a
 * fork reads the artifact its own log announced and nothing is stored twice.
 * The body carries one `data` Part (`mediaType: application/json`) and no
 * `url` Part, so there is no pre-signed URL to outlive the caller's
 * authorization (RFC 0205 §A.3).
 *
 * The conversation half (`turnParts`): a turn this host emits carries `parts`
 * only when the installed `@openwop/spec-artifacts` declares the property on
 * the closed v2 turn def (corpus 2.36.0+); on an older corpus the turn is the
 * pre-0205 shape, which strict validation would otherwise refuse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { err } from './errors.js';
import { readEvents } from './events.js';
import { loadRun } from './runs.js';
import { route, type Ctx, type Reply, type Route } from './router.js';
import type { Host } from './host.js';

export const A2A_MEDIA_TYPE = 'application/a2a+json';
/** The node type the `conformance-artifact-emit` fixture uses (RFC 0205 register G2). */
export const ARTIFACT_EMIT_TYPE = 'conformance.artifact.emit';

/** Does the installed contract carry RFC 0205? Both the A2A schema and the turn `parts` property. */
export function corpusHasParts(host: Host): boolean {
  const dir = host.artifacts.schemasDir;
  if (!existsSync(join(dir, 'artifact.schema.json')) || !existsSync(join(dir, 'part.schema.json'))) return false;
  try {
    const turn = JSON.parse(readFileSync(join(dir, 'conversation-turn.schema.json'), 'utf8')) as { properties?: Record<string, unknown> };
    return turn.properties?.['parts'] !== undefined;
  } catch { return false; }
}

/** RFC 9110 §12.5.1 — the q-value of `mediaType` in an Accept header (exact, `type/*` or `*\/*`, most specific wins). */
function qualityOf(accept: string, mediaType: string): number {
  const [type] = mediaType.split('/');
  let best = -1; let spec = -1;
  for (const raw of accept.split(',')) {
    const [range, ...params] = raw.trim().toLowerCase().split(';').map((s) => s.trim());
    if (!range) continue;
    const s = range === mediaType ? 2 : range === `${type}/*` ? 1 : range === '*/*' ? 0 : -1;
    if (s < 0 || s < spec) continue;
    const qp = params.find((p) => p.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (Number.isNaN(q)) continue;
    if (s > spec) { spec = s; best = q; } else best = Math.max(best, q);
  }
  return best < 0 ? 0 : best;
}

/** True when the request prefers the A2A shape over plain JSON. A tie keeps `application/json` (today's answer). */
export function prefersA2a(accept: string | null): boolean {
  if (!accept) return false;
  const a2a = qualityOf(accept, A2A_MEDIA_TYPE);
  return a2a > 0 && a2a > qualityOf(accept, 'application/json');
}

/** The artifact id a node mints — deterministic per run and node, so a replayed node names the same artifact. */
export function artifactIdFor(nodeId: string): string {
  return `art-${nodeId}`;
}

async function getArtifact(ctx: Ctx): Promise<Reply> {
  const run = loadRun(ctx, ctx.params['runId'] as string);
  const artifactId = ctx.params['artifactId'] as string;
  const created = readEvents(ctx.host, run).find((e) => e.type === 'artifact.created' && (e.payload as { artifactId?: unknown }).artifactId === artifactId);
  if (!created) throw err('not_found', 'artifact not found');
  const p = created.payload as { artifactId: string; artifactType: string; nodeId?: string; summary?: string };
  const def = ctx.host.workflows.get(run.workflow_id);
  const node = def?.nodes.find((n) => n.id === p.nodeId);
  const data = (node?.config['data'] ?? {}) as unknown;
  const name = typeof node?.config['name'] === 'string' ? node.config['name'] : undefined;
  const headers = { Vary: 'Accept' };
  if (ctx.major === 2 && prefersA2a(ctx.header('accept')) && corpusHasParts(ctx.host)) {
    const body: Record<string, unknown> = {
      artifactId,
      ...(name ? { name } : {}),
      ...(p.summary ? { description: p.summary } : {}),
      parts: [{ data, mediaType: 'application/json' }],
      metadata: { openwop: { artifactTypeId: p.artifactType, schemaVersion: 0 } },
    };
    ctx.host.validate('artifact', body, `artifact ${artifactId}`);
    return { status: 200, raw: JSON.stringify(body), contentType: A2A_MEDIA_TYPE, headers };
  }
  return { status: 200, body: { artifactId, artifactType: p.artifactType, nodeId: p.nodeId ?? null, data }, headers };
}

export function artifactRoutes(): Route[] {
  return [
    route('GET', '/runs/{runId}/artifacts/{artifactId}', true, getArtifact),
    route('GET', '/v1/runs/{runId}/artifacts/{artifactId}', true, getArtifact, 1),
  ];
}
