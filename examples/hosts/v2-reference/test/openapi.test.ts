/**
 * The `/openapi.json` filter and bundler (openapi.ts): the canonical document keeps
 * exactly the operations the route table mounts under the requested major, and
 * every schema file it references is inlined under components/schemas.
 */
import { describe, expect, it } from 'vitest';
import { bundleRefs, filterOpenApi, type MountedRoute } from '../src/openapi.js';

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '2.43.0' },
  servers: [{ url: 'https://{host}' }],
  paths: {
    '/runs': { post: { operationId: 'createRun' }, get: { operationId: 'listRuns' } },
    '/runs/{runId}': { parameters: [{ $ref: '#/components/parameters/RunId' }], get: { operationId: 'getRun' }, delete: { operationId: 'deleteRun' } },
    '/runs/{runId}:pause': { post: { operationId: 'pauseRun' } },
    '/prompts': { get: { operationId: 'listPrompts' } },
  },
  components: { parameters: { RunId: { name: 'runId', in: 'path' } } },
};

describe('filterOpenApi', () => {
  it('keeps only the mounted methods, drops unmounted path items, keeps path-level keys and components', () => {
    const routes: MountedRoute[] = [
      { method: 'POST', path: '/runs', contract: 'both' },
      { method: 'GET', path: '/runs/{id}', contract: 2 },
      { method: 'POST', path: '/runs/{runId}:pause', contract: 2 },
    ];
    const out = filterOpenApi(doc, routes, 2);
    expect(Object.keys(out.paths ?? {})).toEqual(['/runs', '/runs/{runId}', '/runs/{runId}:pause']);
    expect(Object.keys(out.paths?.['/runs'] ?? {})).toEqual(['post']);
    expect(Object.keys(out.paths?.['/runs/{runId}'] ?? {})).toEqual(['parameters', 'get']);
    expect(out['components']).toBe(doc.components);
    expect(out['servers']).toBe(doc.servers);
    expect(doc.paths['/runs'].get).toBeDefined();
  });
  it('honours the route contract: a v1-only route is not served under major 2, and vice versa', () => {
    const routes: MountedRoute[] = [
      { method: 'GET', path: '/runs', contract: 1 },
      { method: 'GET', path: '/prompts', contract: 2 },
    ];
    expect(Object.keys(filterOpenApi(doc, routes, 2).paths ?? {})).toEqual(['/prompts']);
    expect(Object.keys(filterOpenApi(doc, routes, 1).paths ?? {})).toEqual(['/runs']);
  });
});

describe('bundleRefs', () => {
  const files: Record<string, unknown> = {
    '/s/v2/run.schema.json': { $id: 'https://x.dev/v2/run.schema.json', $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { id: { $ref: 'ids.schema.json#/$defs/runId' }, parent: { $ref: '#' }, meta: { $ref: '#/$defs/Meta' } }, $defs: { Meta: { type: 'object' } } },
    '/s/v2/ids.schema.json': { $id: 'https://x.dev/v2/ids.schema.json', $defs: { runId: { type: 'string' }, other: { $ref: 'https://x.dev/v2/run.schema.json' } } },
    '/s/v2/Error.schema.json': { type: 'object' },
  };
  const loads: string[] = [];
  const load = (f: string): unknown => { loads.push(f); if (!(f in files)) throw new Error(`no ${f}`); return files[f]; };
  const doc = {
    openapi: '3.1.0',
    paths: { '/runs': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '../../s/v2/run.schema.json' } } } }, 400: { $ref: '#/components/responses/Bad' } } } } },
    components: { schemas: { Error: { type: 'object' } }, responses: { Bad: { description: 'b', content: { 'application/json': { schema: { $ref: '../../s/v2/Error.schema.json' } } } } } },
  };
  const out = bundleRefs(doc, '/api/v2/openapi.yaml', load) as any;

  it('inlines each referenced file once, transitively, and rewrites the refs to components/schemas', () => {
    expect(out.paths['/runs'].get.responses[200].content['application/json'].schema.$ref).toBe('#/components/schemas/run');
    expect(out.paths['/runs'].get.responses[400].$ref).toBe('#/components/responses/Bad');
    expect(Object.keys(out.components.schemas).sort()).toEqual(['Error', 'Error-2', 'ids', 'run']);
    expect(out.components.responses.Bad.content['application/json'].schema.$ref).toBe('#/components/schemas/Error-2');
    // The ids → run cycle terminates: each file is loaded once.
    expect(new Set(loads).size).toBe(loads.length);
  });
  it('re-roots a bundled schema\'s own and cross-file fragments, and drops $id/$schema', () => {
    const run = out.components.schemas.run;
    expect(run.$id).toBeUndefined();
    expect(run.$schema).toBeUndefined();
    expect(run.properties.id.$ref).toBe('#/components/schemas/ids/$defs/runId');
    expect(run.properties.parent.$ref).toBe('#/components/schemas/run');
    expect(run.properties.meta.$ref).toBe('#/components/schemas/run/$defs/Meta');
    expect(out.components.schemas.ids.$defs.other.$ref).toBe('#/components/schemas/run');
  });
  it('leaves no external ref, and every local ref resolves', () => {
    const refs: string[] = [];
    (function walk(o: unknown): void {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o !== null && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === '$ref') refs.push(v as string); else walk(v); }
    })(out);
    expect(refs.every((r) => r.startsWith('#/'))).toBe(true);
    for (const r of refs) expect(r.slice(2).split('/').reduce<any>((o, k) => o?.[k], out), r).toBeDefined();
  });
  it('leaves the input untouched and refuses an anchor fragment it cannot re-root', () => {
    expect(doc.paths['/runs'].get.responses[200].content['application/json'].schema.$ref).toBe('../../s/v2/run.schema.json');
    expect(() => bundleRefs({ paths: { '/a': { get: { $ref: '../../s/v2/ids.schema.json#runId' } } } }, '/api/v2/openapi.yaml', load)).toThrow(/JSON-pointer/);
  });
});
