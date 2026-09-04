/**
 * The machine-readable contract the host implements FROM: `@openwop/spec-artifacts`
 * (api/, schemas/, spec/v2/*.json registries). Loaded once at boot; the error
 * registry, the event codemap and the declaration file are data, never code
 * (overview.md Axiom 4).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PKG_ROOT } from './config.js';

export interface ErrorRow { readonly code: string; readonly httpStatus: number; readonly retriable: boolean }
export interface CodemapRow { readonly v1: string; readonly v2: string; readonly payloadDef: string }
export interface AliasRow { readonly alias: string; readonly family: string; readonly facets?: readonly string[] }

export interface SpecArtifacts {
  readonly root: string;
  readonly version: string;
  readonly schemasDir: string;
  readonly errors: ReadonlyMap<string, ErrorRow>;
  readonly vendorCodePattern: RegExp;
  /** v1 → v2 event type name (identity rows included). */
  readonly codemap: ReadonlyMap<string, string>;
  /** Every registered v2 event type. */
  readonly v2EventTypes: ReadonlySet<string>;
  readonly vendorEventPattern: RegExp;
  /** Every family key the declaration file names (peer-dependency identifiers). */
  readonly familyKeys: ReadonlySet<string>;
  readonly metadataKeys: ReadonlySet<string>;
  readonly peerAliases: ReadonlyMap<string, AliasRow>;
}

function resolveRoot(): string {
  const override = process.env['OPENWOP_SPEC_ARTIFACTS_DIR']?.trim();
  if (override) return override;
  const req = createRequire(join(PKG_ROOT, 'package.json'));
  try {
    return dirname(req.resolve('@openwop/spec-artifacts/package.json'));
  } catch {
    throw new Error('@openwop/spec-artifacts is not installed — the host implements the contract it ships (npm install, or set OPENWOP_SPEC_ARTIFACTS_DIR)');
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

let cached: SpecArtifacts | undefined;

export function loadArtifacts(): SpecArtifacts {
  if (cached) return cached;
  const root = resolveRoot();
  const pkg = readJson<{ version: string }>(join(root, 'package.json'));
  const errorsDoc = readJson<{ vendorCodePattern: string; rows: ErrorRow[] }>(join(root, 'spec', 'v2', 'errors.json'));
  const codemapDoc = readJson<{ rows: CodemapRow[] }>(join(root, 'spec', 'v2', 'event-codemap.json'));
  const declaration = readJson<{ metadata: Array<{ key: string; disposition?: string }>; families: Array<{ key: string; anchor: string }> }>(join(root, 'spec', 'v2', 'declaration.json'));
  const runEvent = readJson<{ properties: { type: { oneOf: Array<{ enum?: string[]; pattern?: string }> } } }>(join(root, 'schemas', 'v2', 'run-event.schema.json'));
  const aliasPath = join(root, 'spec', 'v2', 'peer-dependency-aliases.json');
  const aliases = existsSync(aliasPath) ? readJson<{ rows: AliasRow[] }>(aliasPath).rows : [];

  const errors = new Map<string, ErrorRow>();
  for (const r of errorsDoc.rows) errors.set(r.code, r);
  const codemap = new Map<string, string>();
  for (const r of codemapDoc.rows) codemap.set(r.v1, r.v2);
  const v2EventTypes = new Set<string>(runEvent.properties.type.oneOf.flatMap((b) => b.enum ?? []));
  const vendorPattern = runEvent.properties.type.oneOf.find((b) => b.pattern !== undefined)?.pattern
    ?? '^(?!openwop\\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$';
  const familyKeys = new Set<string>(declaration.families.filter((f) => f.anchor !== 'deleted').map((f) => f.key));
  const metadataKeys = new Set<string>(declaration.metadata.filter((m) => m.disposition !== 'deleted').map((m) => m.key));
  const peerAliases = new Map<string, AliasRow>();
  for (const a of aliases) peerAliases.set(a.alias, a);

  cached = {
    root,
    version: pkg.version,
    schemasDir: join(root, 'schemas', 'v2'),
    errors,
    vendorCodePattern: new RegExp(errorsDoc.vendorCodePattern),
    codemap,
    v2EventTypes,
    vendorEventPattern: new RegExp(vendorPattern),
    familyKeys,
    metadataKeys,
    peerAliases,
  };
  return cached;
}
