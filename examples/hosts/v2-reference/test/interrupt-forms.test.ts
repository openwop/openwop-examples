/**
 * interrupt.md §Forms (RFC 0255 §E, forms.ts): the suite's positive form passes
 * the check; the obscured-input probe fails the schema; the unbound-input probe
 * fails the binding rule. The three fixtures load only as a set, and only when
 * the host can check a form.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadArtifacts } from '../src/artifacts.js';
import { loadConfig } from '../src/config.js';
import { createFormCheck, inputIds } from '../src/forms.js';
import { loadWorkflows } from '../src/server.js';

const FIXTURES = join(dirname(createRequire(import.meta.url).resolve('@openwop/openwop-conformance/package.json')), 'fixtures');
const IDS = ['conformance-interrupt-form', 'conformance-interrupt-form-refused', 'conformance-interrupt-form-unbound'];
const configOf = (id: string): { questions: Array<{ id: string }>; form: unknown } =>
  (JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8')) as { nodes: Array<{ config: { questions: Array<{ id: string }>; form: unknown } }> }).nodes[0]!.config;

describe('interrupt forms', async () => {
  const check = await createFormCheck(loadArtifacts().schemasDir);

  it('the installed corpus and Ajv let the host check a form', () => {
    expect(check).not.toBeNull();
  });
  it('the positive form passes', () => {
    const c = configOf(IDS[0]!);
    expect(check!(c.form, c.questions.map((q) => q.id))).toEqual({ ok: true });
  });
  it('an obscured (secret) input fails the schema', () => {
    const c = configOf(IDS[1]!);
    const v = check!(c.form, c.questions.map((q) => q.id));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/interrupt-form\.schema\.json/);
  });
  it('an input whose id names no question fails the binding rule', () => {
    const c = configOf(IDS[2]!);
    expect(inputIds(c.form)).toEqual(['q2']);
    const v = check!(c.form, c.questions.map((q) => q.id));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/q2/);
  });
  it('the three fixtures load together, and only when the host can check a form', () => {
    const on = [...loadWorkflows(loadConfig({}), false, true).keys()];
    for (const id of IDS) expect(on, id).toContain(id);
    const off = [...loadWorkflows(loadConfig({}), false, false).keys()];
    for (const id of IDS) expect(off, id).not.toContain(id);
  });
});
