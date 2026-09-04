/**
 * Dev-mode schema validation of every emitted document against schemas/v2
 * (the spec-artifacts peer). Ajv is a dev dependency loaded dynamically; when
 * it is absent or OPENWOP_DEV_VALIDATE=off the hook is a no-op. `warn` logs a
 * `[schema]` line per defect; `strict` throws (the route-level harness runs
 * strict so a drifted document fails a test, not a conformance run).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Validator = (doc: unknown) => { ok: boolean; errors: string };

interface AjvLike {
  addSchema(schema: object): unknown;
  getSchema(id: string): ((d: unknown) => boolean) & { errors?: unknown } | undefined;
  compile(schema: object): ((d: unknown) => boolean) & { errors?: unknown };
  errorsText(errors: unknown, opts: { separator: string }): string;
}

/** Known corpus defects the dev validator names instead of failing on (README §Known corpus defects). */
const KNOWN: ReadonlyArray<{ schema: string; pattern: RegExp; note: string }> = [
  { schema: 'capabilities', pattern: /\/conformance.*must NOT have additional properties/, note: 'declaration.json metadata `conformance` closes without `seamsProfile`, the key lib/seams.ts (RFC 0168 §C.1 reconciliation) reads' },
  { schema: 'run-event', pattern: /\/type must match exactly one schema in oneOf/, note: 'run-event.schema.json `type` is a oneOf whose vendor pattern also matches every registered domain.verb type, so no registered type validates' },
];

export async function createValidator(schemasDir: string, mode: 'off' | 'warn' | 'strict'): Promise<(schemaName: string, doc: unknown, context: string) => void> {
  if (mode === 'off') return () => undefined;
  let ajv: AjvLike;
  try {
    const mod = (await import('ajv/dist/2020.js')) as unknown as { Ajv2020?: new (o: object) => AjvLike; default?: { Ajv2020?: new (o: object) => AjvLike } | (new (o: object) => AjvLike) };
    const Ctor = mod.Ajv2020 ?? (mod.default as { Ajv2020?: new (o: object) => AjvLike } | undefined)?.Ajv2020 ?? (mod.default as new (o: object) => AjvLike);
    ajv = new Ctor({ allErrors: true, strict: false });
    try {
      const formats = (await import('ajv-formats')) as unknown as { default: (a: AjvLike) => void };
      formats.default(ajv);
    } catch { /* formats optional */ }
  } catch {
    process.stderr.write('[schema] ajv is not installed — dev-mode validation disabled\n');
    return () => undefined;
  }
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.schema.json') ? [p] : []; });
  for (const p of walk(schemasDir)) {
    try { ajv.addSchema(JSON.parse(readFileSync(p, 'utf8')) as object); } catch { /* duplicate $id registered once */ }
  }
  const cache = new Map<string, Validator>();
  const validatorFor = (name: string): Validator => {
    const hit = cache.get(name);
    if (hit) return hit;
    const id = `https://openwop.dev/spec/v2/${name}.schema.json`;
    const v = ajv.getSchema(id) ?? ajv.compile(JSON.parse(readFileSync(join(schemasDir, `${name}.schema.json`), 'utf8')) as object);
    const fn: Validator = (doc) => ({ ok: v(doc), errors: ajv.errorsText(v.errors, { separator: '; ' }) });
    cache.set(name, fn);
    return fn;
  };
  return (schemaName, doc, context) => {
    const r = validatorFor(schemaName)(doc);
    if (r.ok) return;
    const known = KNOWN.find((k) => k.schema === schemaName && k.pattern.test(r.errors));
    if (known) {
      process.stderr.write(`[schema] ${schemaName} (${context}): known corpus defect — ${known.note}\n`);
      return;
    }
    const line = `[schema] ${schemaName} (${context}) does not validate: ${r.errors}`;
    if (mode === 'strict') throw new Error(line);
    process.stderr.write(`${line}\n`);
  };
}
