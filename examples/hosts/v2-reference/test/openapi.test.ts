/**
 * The `/openapi.json` filter (openapi.ts): the canonical document keeps exactly
 * the operations the route table mounts under the requested major.
 */
import { describe, expect, it } from 'vitest';
import { filterOpenApi, type MountedRoute } from '../src/openapi.js';

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
