/**
 * The fixture catalog (server.ts loadWorkflows): an honoured fixture id the
 * installed suite does not ship is never loaded and never an error; the same
 * id is loaded as soon as a fixtures directory carries it (openwop#1700).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadWorkflows } from '../src/server.js';

const ROUTED = 'conformance-approval-reject-routed';
const TIMEOUT = 'conformance-approval-timeout';

describe('fixture catalog', () => {
  it('an honoured fixture absent from every fixtures directory is skipped, not thrown', () => {
    const empty = mkdtempSync(join(tmpdir(), 'owp-fixtures-empty-'));
    const ids = [...loadWorkflows(loadConfig({ fixturesDir: empty })).keys()];
    expect(ids).toContain('conformance-approval');
    expect(ids).not.toContain(ROUTED);
    expect(ids).not.toContain(TIMEOUT);
  });
  it('the same ids load when a fixtures directory carries them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owp-fixtures-'));
    const gate = (config: Record<string, unknown> = {}) => ({ id: 'gate', typeId: 'core.approvalGate', config: { title: 'Gate', actions: ['accept', 'reject'], ...config }, inputs: {} });
    writeFileSync(join(dir, `${ROUTED}.json`), JSON.stringify({ id: ROUTED, name: ROUTED, version: '1.0', nodes: [gate(), { id: 'notify', typeId: 'core.noop', config: {}, inputs: {} }], edges: [{ id: 'e', sourceNodeId: 'gate', targetNodeId: 'notify', triggerRule: 'any_failed' }], variables: [] }));
    writeFileSync(join(dir, `${TIMEOUT}.json`), JSON.stringify({ id: TIMEOUT, name: TIMEOUT, version: '1.0', nodes: [gate({ timeoutMs: 1500 })], edges: [], variables: [] }));
    const ids = [...loadWorkflows(loadConfig({ fixturesDir: dir })).keys()];
    expect(ids).toContain(ROUTED);
    expect(ids).toContain(TIMEOUT);
  });
});
