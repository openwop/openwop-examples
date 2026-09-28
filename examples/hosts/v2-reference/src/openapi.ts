/**
 * `GET /openapi.json` — the canonical contract from `@openwop/spec-artifacts`
 * (`api/v2/openapi.yaml` for major 2, `api/openapi.yaml` for major 1), filtered
 * to the path items and methods this host's router actually mounts. The filter
 * reads the router's own route table, so the served document cannot drift from
 * what the host serves. Seams (`api/seams-v2.yaml`) are a separate document and
 * are not mixed in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { Ctx, Reply } from './router.js';

/** The OpenAPI 3.1 operation keys of a path item; every other key (`parameters`, `summary`, …) is kept as is. */
const METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export interface MountedRoute { readonly method: string; readonly path: string; readonly contract: 1 | 2 | 'both' }

type Doc = Record<string, unknown> & { paths?: Record<string, Record<string, unknown>> };

/** A path template with its parameter names erased: `/runs/{runId}` and `/runs/{id}` are one path. */
const shape = (path: string): string => path.replace(/\{[^}]+\}/g, '{}');

/**
 * The canonical document keeping only the operations `routes` mounts under
 * `major`; a path item left with no operation is dropped. `components`,
 * `servers`, `tags` and `security` are kept, so every `$ref` still resolves.
 */
export function filterOpenApi(doc: Doc, routes: readonly MountedRoute[], major: 1 | 2): Doc {
  const mounted = new Set<string>();
  for (const r of routes) if (r.contract === 'both' || r.contract === major) mounted.add(`${r.method.toLowerCase()} ${shape(r.path)}`);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, item] of Object.entries(doc.paths ?? {})) {
    const kept = Object.entries(item).filter(([k]) => !METHODS.has(k) || mounted.has(`${k} ${shape(key)}`));
    if (kept.some(([k]) => METHODS.has(k))) paths[key] = Object.fromEntries(kept);
  }
  return { ...doc, paths };
}

const cache = new Map<string, Doc | null>();

function canonical(root: string, major: 1 | 2): Doc | null {
  const file = resolve(root, 'api', ...(major === 2 ? ['v2', 'openapi.yaml'] : ['openapi.yaml']));
  if (!cache.has(file)) cache.set(file, existsSync(file) ? parse(readFileSync(file, 'utf8')) as Doc : null);
  return cache.get(file) ?? null;
}

export function openapiHandler(routes: () => readonly MountedRoute[]): (ctx: Ctx) => Promise<Reply> {
  return async (ctx) => {
    const doc = canonical(ctx.host.artifacts.root, ctx.major);
    const source = `@openwop/spec-artifacts ${ctx.host.artifacts.version} ${ctx.major === 2 ? 'api/v2/openapi.yaml' : 'api/openapi.yaml'}`;
    if (doc === null) throw new Error(`${source} is not installed`);
    const served = filterOpenApi(doc, routes(), ctx.major);
    const info = (served['info'] ?? {}) as Record<string, unknown>;
    const note = `Served by ${ctx.host.config.host}: ${source}, filtered to the operations this host mounts.`;
    served['info'] = { ...info, version: ctx.version, description: typeof info['description'] === 'string' ? `${note}\n\n${info['description']}` : note };
    return { status: 200, body: served };
  };
}
