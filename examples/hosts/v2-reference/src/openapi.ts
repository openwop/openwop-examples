/**
 * `GET /openapi.json` — the canonical contract from `@openwop/spec-artifacts`
 * (`api/v2/openapi.yaml` for major 2, `api/openapi.yaml` for major 1), filtered
 * to the path items and methods this host's router actually mounts. The filter
 * reads the router's own route table, so the served document cannot drift from
 * what the host serves. Seams (`api/seams-v2.yaml`) are a separate document and
 * are not mixed in.
 *
 * The canonical document points into `schemas/` by relative file `$ref`s, which a
 * client of the served JSON cannot follow; `bundleRefs` inlines every schema file
 * reached (transitively) under `components/schemas` so the document is self-contained.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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

type Json = unknown;
type Loader = (file: string) => Json;

const COMPONENT = '#/components/schemas/';

/**
 * Rewrites every non-local `$ref` of `doc` (read from `docFile`) to
 * `#/components/schemas/<name>`, adding each referenced schema file there.
 * Files are followed transitively and visited once, so a cycle terminates. A
 * bundled schema loses `$id` and `$schema` (its refs are rewritten to be
 * document-root pointers, which an `$id` would re-base), and its own
 * `#`/`#/…` refs become `#/components/schemas/<name>` + the same pointer. An
 * absolute ref names a schema by its `$id`; it is looked up among the loaded
 * files, then as the same basename beside the referring file.
 */
export function bundleRefs(doc: Doc, docFile: string, load: Loader): Doc {
  const names = new Map<string, string>(); // file → component name
  const taken = new Set(Object.keys(((doc['components'] ?? {}) as Record<string, Json>)['schemas'] ?? {}));
  const byId = new Map<string, string>(); // $id → file
  const loaded = new Map<string, Record<string, Json>>();
  const bundled: Record<string, Json> = {};
  const queue: string[] = [];

  const read = (file: string): Record<string, Json> => {
    let s = loaded.get(file);
    if (s === undefined) {
      s = load(file) as Record<string, Json>;
      loaded.set(file, s);
      if (typeof s['$id'] === 'string') byId.set(s['$id'], file);
    }
    return s;
  };
  const fileOf = (url: string, from: string): string => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return resolve(dirname(from), url);
    const known = byId.get(url);
    if (known !== undefined) return known;
    const guess = resolve(dirname(from), basename(new URL(url).pathname));
    if (read(guess)['$id'] !== url) throw new Error(`$ref ${url} (from ${from}) names no known schema $id`);
    return guess;
  };
  const nameOf = (file: string): string => {
    let name = names.get(file);
    if (name === undefined) {
      const stem = basename(file).replace(/\.schema\.json$|\.json$/, '');
      name = stem;
      for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`;
      taken.add(name);
      names.set(file, name);
      read(file);
      queue.push(file);
    }
    return name;
  };
  const pointer = (name: string, fragment: string, ref: string): string => {
    if (fragment !== '' && !fragment.startsWith('/')) throw new Error(`$ref ${ref}: only JSON-pointer fragments are bundled`);
    return `${COMPONENT}${name}${fragment}`;
  };
  /** `self` is the component a schema is bundled as (null for the OpenAPI document itself). */
  const rewrite = (node: Json, from: string, self: string | null): Json => {
    if (Array.isArray(node)) return node.map((v) => rewrite(v, from, self));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const hash = v.indexOf('#');
        const url = hash < 0 ? v : v.slice(0, hash);
        const fragment = hash < 0 ? '' : v.slice(hash + 1);
        if (url === '') out[k] = self === null ? v : pointer(self, fragment, v);
        else out[k] = pointer(nameOf(fileOf(url, from)), fragment, v);
      } else out[k] = rewrite(v, from, self);
    }
    return out;
  };

  const root = rewrite(doc, docFile, null) as Doc;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const name = names.get(file) as string;
    const { $id: _id, $schema: _schema, ...schema } = read(file);
    bundled[name] = rewrite(schema, file, name);
  }
  if (Object.keys(bundled).length === 0) return root;
  const components = (root['components'] ?? {}) as Record<string, Json>;
  root['components'] = { ...components, schemas: { ...((components['schemas'] ?? {}) as Record<string, Json>), ...bundled } };
  return root;
}

const cache = new Map<string, Doc | null>();
const schemaFiles = new Map<string, Json>();
const readSchema: Loader = (file) => {
  if (!schemaFiles.has(file)) schemaFiles.set(file, JSON.parse(readFileSync(file, 'utf8')));
  return schemaFiles.get(file);
};

const canonicalFile = (root: string, major: 1 | 2): string => resolve(root, 'api', ...(major === 2 ? ['v2', 'openapi.yaml'] : ['openapi.yaml']));

function canonical(file: string): Doc | null {
  if (!cache.has(file)) cache.set(file, existsSync(file) ? parse(readFileSync(file, 'utf8')) as Doc : null);
  return cache.get(file) ?? null;
}

export function openapiHandler(routes: () => readonly MountedRoute[]): (ctx: Ctx) => Promise<Reply> {
  return async (ctx) => {
    const file = canonicalFile(ctx.host.artifacts.root, ctx.major);
    const doc = canonical(file);
    const source = `@openwop/spec-artifacts ${ctx.host.artifacts.version} ${ctx.major === 2 ? 'api/v2/openapi.yaml' : 'api/openapi.yaml'}`;
    if (doc === null) throw new Error(`${source} is not installed`);
    const served = bundleRefs(filterOpenApi(doc, routes(), ctx.major), file, readSchema);
    const info = (served['info'] ?? {}) as Record<string, unknown>;
    const note = `Served by ${ctx.host.config.host}: ${source}, filtered to the operations this host mounts, with every referenced schema bundled under components/schemas.`;
    served['info'] = { ...info, version: ctx.version, description: typeof info['description'] === 'string' ? `${note}\n\n${info['description']}` : note };
    return { status: 200, body: served };
  };
}
