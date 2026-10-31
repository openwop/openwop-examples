/**
 * interrupt.md §Forms (RFC 0255 §E): a `clarification` MAY carry `data.form`
 * (`schemas/v2/interrupt-form.schema.json`), with `questions` as its fallback. A
 * host MUST NOT raise a form that fails that schema or has an input `id` outside
 * `questions[].id`. `core.clarificationGate` passes `config.form` through
 * verbatim, after this check.
 *
 * Unlike the dev validator (validate.ts, warn-only by default) this check always
 * refuses. When Ajv is not installed, or the installed corpus has no
 * interrupt-form schema, the host cannot enforce the rule: it raises no form and
 * does not advertise the form fixtures (server.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FormCheck = (form: unknown, questionIds: readonly string[]) => { ok: true } | { ok: false; reason: string };

interface AjvLike {
  addSchema(schema: object): unknown;
  getSchema(id: string): ((d: unknown) => boolean) & { errors?: unknown } | undefined;
  errorsText(errors: unknown, opts: { separator: string }): string;
}

const FORM_ID = 'https://openwop.dev/spec/v2/interrupt-form.schema.json';
/** The input components of both form versions: v0.9 messages and the 0.9.1 tree. */
const INPUTS = new Set(['TextField', 'CheckBox', 'ChoicePicker', 'DateTimeInput', 'field.text', 'field.date', 'field.select', 'field.checkbox']);

/** Every input component's `id`, wherever it sits in the form. */
export function inputIds(form: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o['component'] === 'string' && INPUTS.has(o['component']) && typeof o['id'] === 'string') out.push(o['id']);
    Object.values(o).forEach(walk);
  };
  walk(form);
  return out;
}

export async function createFormCheck(schemasDir: string): Promise<FormCheck | null> {
  if (!existsSync(join(schemasDir, 'interrupt-form.schema.json'))) return null;
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
  const v = ajv.getSchema(FORM_ID);
  if (v === undefined) return null;
  return (form, questionIds) => {
    if (!v(form)) return { ok: false, reason: `the form fails interrupt-form.schema.json: ${ajv.errorsText(v.errors, { separator: '; ' }).slice(0, 800)}` };
    const unbound = inputIds(form).filter((id) => !questionIds.includes(id));
    if (unbound.length > 0) return { ok: false, reason: `form input id(s) ${unbound.join(', ')} name no question (questions[].id: ${questionIds.join(', ')})` };
    return { ok: true };
  };
}
