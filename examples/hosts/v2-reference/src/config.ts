/**
 * Host configuration — every knob is an env var with a dev default.
 *
 * The v2 host serves two majors through the overlap (versioning.md §5):
 * `/v1/…` path keys under the 1.11 contract and unversioned keys under 2.0.
 * `preferredVersion` selects the header-less representation of the one
 * well-known resource (capabilities.md §1, versioning.md §1.3). Through the
 * overlap RFC 0176 §C.1 says the header-less representation is the v1
 * document, which is only consistent with RFC 0172 §A.3 ("absent ⇒
 * preferredVersion's major") when preferredVersion names the 1.x member —
 * hence the default below. Set OPENWOP_PREFERRED_VERSION=2.0 to prefer the
 * closed v2 root instead (then RFC 0176 §C.1's header-less v1 rendering is
 * no longer served).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, '..');

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { name: string; version: string };

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}
function envInt(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim() === 'true' || v.trim() === '1';
}

export const V1_VERSION = '1.11';
export const V2_VERSION = '2.0';
export const PROTOCOL_VERSIONS: readonly string[] = [V1_VERSION, V2_VERSION];
export const ENGINE_VERSION = 1;
export const EVENT_LOG_SCHEMA_VERSION = 3;
export const EVENT_SCHEMA_VERSION = 1;
export const MIN_CLIENT_VERSION = '1.0';
export const SEAMS_PROFILE_ID = 'openwop-conformance-seams-v2';
export const SEAMS_PREFIX = '/conformance/seams';
export const HOST_NAME = 'openwop-host-v2-reference';
export const HOST_VERSION = pkg.version;
export const HOST_VENDOR = 'openwop (reference example)';
export const HOST_ID = 'openwop.dev/examples/hosts/v2-reference';
export const EXTENSION_ORG = 'openwop-v2-reference';
export const LEGACY_ISSUER = 'urn:openwop:legacy';
export const API_KEY_ISSUER = `urn:${HOST_NAME}:api-key`;
export const SESSION_ISSUER = `urn:${HOST_NAME}:session`;
export const DEFAULT_TENANT = 'openwop-reference-tenant';

/**
 * RFC 0168 §E.2 — the bundle-signing key this host publishes.
 *
 * `keys/host.pem` signs; `keys/host.pub.pem` is what discovery advertises. The
 * id here MUST be the same string the bundle's `signature.keyId` carries, or a
 * verifier resolves nothing: the whole point of publishing is that someone else
 * can look the id up and check the attestation. It is deliberately a constant
 * in the same file as the rest of the host's identity, next to HOST_ID, rather
 * than a value the certify command passes in — a signer and a publisher that
 * take the id from different places will eventually disagree.
 */
export const BUNDLE_SIGNING_KEY_ID = 'v2-reference-1';
export const KEYS_DIR = new URL('../keys/', import.meta.url).pathname;

export interface HostConfig {
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
  readonly tenant: string;
  readonly dbPath: string;
  readonly preferredVersion: string;
  readonly seamsProfile: boolean;
  readonly webhookAllowPrivate: boolean;
  readonly webhookMaxAttempts: number;
  readonly webhookBackoffBaseMs: number;
  readonly webhookRetentionDays: number;
  readonly implementedChangeIds: ReadonlySet<string>;
  readonly devValidate: 'off' | 'warn' | 'strict';
  readonly interruptSecret: string;
  readonly interruptKid: string;
  readonly legacyInterruptSecret: string;
  readonly rateLimitPerMinute: number;
  readonly fixturesDir: string | null;
  readonly hostBuild: { kind: 'commit' | 'image-digest' | 'artifact-sha256'; id: string };
  readonly workloadTrustRoots: readonly string[];
  readonly replayRetentionDays: number;
}

export function loadConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  const preferred = env('OPENWOP_PREFERRED_VERSION', V1_VERSION);
  if (!PROTOCOL_VERSIONS.includes(preferred)) {
    throw new Error(`OPENWOP_PREFERRED_VERSION must be one of ${PROTOCOL_VERSIONS.join(', ')} (got ${preferred})`);
  }
  const build = /^(commit|image-digest|artifact-sha256):(.+)$/.exec(env('OPENWOP_HOST_BUILD', 'commit:dev'));
  const validate = env('OPENWOP_DEV_VALIDATE', process.env['NODE_ENV'] === 'production' ? 'off' : 'warn');
  return {
    host: env('OPENWOP_HOST', '127.0.0.1'),
    port: envInt('OPENWOP_PORT', 3838),
    apiKey: env('OPENWOP_API_KEY', 'openwop-v2-dev-key'),
    tenant: env('OPENWOP_TENANT', DEFAULT_TENANT),
    dbPath: env('OPENWOP_DB_PATH', join(PKG_ROOT, 'data', 'v2-reference.sqlite')),
    preferredVersion: preferred,
    seamsProfile: envBool('OPENWOP_SEAMS_PROFILE', true),
    webhookAllowPrivate: envBool('OPENWOP_WEBHOOK_ALLOW_PRIVATE', false),
    webhookMaxAttempts: envInt('OPENWOP_WEBHOOK_MAX_ATTEMPTS', 5),
    webhookBackoffBaseMs: envInt('OPENWOP_WEBHOOK_BACKOFF_BASE_MS', 500),
    webhookRetentionDays: envInt('OPENWOP_WEBHOOK_RETENTION_DAYS', 7),
    implementedChangeIds: new Set(env('OPENWOP_IMPLEMENTED_CHANGE_IDS', '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
    devValidate: validate === 'strict' ? 'strict' : validate === 'off' || validate === 'false' ? 'off' : 'warn',
    interruptSecret: env('OPENWOP_INTERRUPT_SECRET', randomBytes(32).toString('hex')),
    interruptKid: env('OPENWOP_INTERRUPT_KID', 'v2-reference-1'),
    legacyInterruptSecret: env('OPENWOP_LEGACY_INTERRUPT_SECRET', 'openwop-v1-legacy-interrupt-secret'),
    rateLimitPerMinute: envInt('OPENWOP_RATELIMIT_REQS_PER_MIN', 1200),
    fixturesDir: process.env['OPENWOP_FIXTURES_DIR']?.trim() || null,
    hostBuild: build ? { kind: build[1] as HostConfig['hostBuild']['kind'], id: build[2] as string } : { kind: 'commit', id: 'dev' },
    workloadTrustRoots: env('OPENWOP_WORKLOAD_TRUST_ROOTS', 'spiffe://example').split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    replayRetentionDays: envInt('OPENWOP_REPLAY_RETENTION_DAYS', 30),
    ...overrides,
  };
}
