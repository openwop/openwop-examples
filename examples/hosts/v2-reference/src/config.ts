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

/**
 * Retirement is ONE flag, and every consequence is derived from it.
 *
 * `versioning.md` §5: *"Retirement is atomic, and that is a consequence of §1.1
 * rather than a separate rule."* Through the overlap `preferredVersion` MUST
 * name a `1.x` member, so dropping v1 from `protocolVersions[]` and flipping
 * the preference are the same act — *"there is no legal intermediate state"*.
 * A host that exposes them as separate switches has made an illegal state
 * reachable by configuration, so this host exposes one.
 *
 * WHY THIS EXISTS AT ALL. Every host passes through the retired state exactly
 * once, in December, and until 2026-09-13 no host had ever been MEASURED in it
 * except a tier-2 host's throwaway Cloud Run lane. That single rehearsal found
 * a suite defect — `v2-version-header-honored` failed a *conformant*
 * single-major host, fixed in suite 2.1.2 — which no dual-stack host could
 * have surfaced, and it produced the first real answer to "what does going
 * v2-only cost" (11 rows, every one of them a test OF the overlap). Without a
 * continuous instrument, the first host through the door in December is the
 * one that discovers whatever else is there. This is that instrument.
 */
export const V1_RETIRED = envBool('OPENWOP_V1_RETIRED', false);

/** The advertised set. Retirement drops the `1.x` member; nothing else may. */
export const SERVED_VERSIONS: readonly string[] = V1_RETIRED ? [V2_VERSION] : PROTOCOL_VERSIONS;
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
export const DEFAULT_TENANT_B = 'openwop-reference-tenant-b';

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
// Rotated 2026-09-05 (`v2-reference-1` → `v2-reference-2`): the rc.16 bundle's
// private half was never on this machine, so the rc.57 re-cut signs under a
// fresh pair; the old public key stays verifiable from git history.
// Rotated 2026-09-17 (`v2-reference-2` → `v2-reference-3`): the -2 private half
// was never on this machine either (same shape as the 09-05 rotation), so the
// 2.3.1 re-cut signs under a fresh pair; -2's public key stays in git history.
// Rotated 2026-09-20 (`v2-reference-3` → `v2-reference-4`): the -3 private half
// was not on this machine either — the third rotation for the same reason. The
// key is gitignored and lived only in a worktree that was later removed. From
// -4 the private half is ALSO kept outside the repository, in the steward's
// `~/.openwop-private-keys/v2-reference-4.host.pem`, so a later cut copies it
// into `keys/host.pem` instead of rotating; -3's public key stays in git history.
export const BUNDLE_SIGNING_KEY_ID = 'v2-reference-4';
export const KEYS_DIR = new URL('../keys/', import.meta.url).pathname;

export interface HostConfig {
  readonly host: string;
  readonly port: number;
  readonly apiKey: string;
  readonly tenant: string;
  readonly dbPath: string;
  readonly preferredVersion: string;
  readonly seamsProfile: boolean;
  /** RFC 0158 §E item 12 — the self-terminating seam. Deployment-time, boot-read, default OFF. */
  readonly durabilitySeam: boolean;
  /** The operator's restart supervisor delay: a TERM of the recovery bound that lives outside this process. */
  readonly supervisorRestartMs: number;
  /** The budget boot has to re-enter every in-flight run; exceeding it is reported, not hidden. */
  readonly bootReentryBudgetMs: number;
  readonly webhookAllowPrivate: boolean;
  readonly webhookMaxAttempts: number;
  readonly webhookBackoffBaseMs: number;
  readonly webhookRetentionDays: number;
  readonly webhookDeadLetterMaxPageSize: number;
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
  /** security-defaults.md §Sandbox isolation — the caps the `sandbox` facet advertises and the child enforces. */
  /** workflow-chain-packs.md §Composition depth — the advertised bound IS the enforced one. */
  readonly chainMaxDepth: number;
  readonly sandboxMemoryLimitBytes: number;
  readonly sandboxWallClockLimitMs: number;
  /** A credential bound to a SECOND tenant (the cross-tenant conformance legs); null = none provisioned. */
  readonly tenantBApiKey: string | null;
  readonly tenantB: string;
  /** RFC 0208 — the one workflow the A2A interface routes (A2A 1.0 Message carries no skill selector). */
  readonly a2aWorkflowId: string;
  /** RFC 0208 — the HMAC key MCP `requestState` tokens are integrity-protected under. */
  readonly mcpStateSecret: string;
}

export function loadConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  // Derived, not independently settable: §1.1 binds preferredVersion to a 1.x
  // member while one is advertised, and to the single major once it is not.
  // Honouring an explicit v1 preference under retirement would manufacture the
  // illegal intermediate state §5 says does not exist, so it is refused rather
  // than silently overridden — a config that lies is worse than one that stops.
  const preferred = V1_RETIRED ? V2_VERSION : env('OPENWOP_PREFERRED_VERSION', V1_VERSION);
  if (V1_RETIRED && env('OPENWOP_PREFERRED_VERSION', V2_VERSION) !== V2_VERSION) {
    throw new Error(
      `OPENWOP_V1_RETIRED=1 and OPENWOP_PREFERRED_VERSION=${env('OPENWOP_PREFERRED_VERSION', '')} cannot both hold: versioning.md §1.1 requires preferredVersion to name the single advertised major once 1.x is dropped`,
    );
  }
  if (!SERVED_VERSIONS.includes(preferred)) {
    throw new Error(`OPENWOP_PREFERRED_VERSION must be one of ${SERVED_VERSIONS.join(', ')} (got ${preferred})`);
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
    durabilitySeam: envBool('OPENWOP_DURABILITY_SEAM', false),
    supervisorRestartMs: envInt('OPENWOP_SUPERVISOR_RESTART_MS', 1000),
    bootReentryBudgetMs: envInt('OPENWOP_BOOT_REENTRY_BUDGET_MS', 5000),
    webhookAllowPrivate: envBool('OPENWOP_WEBHOOK_ALLOW_PRIVATE', false),
    webhookMaxAttempts: envInt('OPENWOP_WEBHOOK_MAX_ATTEMPTS', 5),
    webhookBackoffBaseMs: envInt('OPENWOP_WEBHOOK_BACKOFF_BASE_MS', 500),
    webhookRetentionDays: envInt('OPENWOP_WEBHOOK_RETENTION_DAYS', 7),
    webhookDeadLetterMaxPageSize: envInt('OPENWOP_WEBHOOK_DEAD_LETTER_MAX_PAGE', 100),
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
    chainMaxDepth: envInt('OPENWOP_CHAIN_MAX_DEPTH', 8),
    sandboxMemoryLimitBytes: envInt('OPENWOP_SANDBOX_MEMORY_LIMIT_BYTES', 48 * 1024 * 1024),
    sandboxWallClockLimitMs: envInt('OPENWOP_SANDBOX_WALL_CLOCK_LIMIT_MS', 2000),
    tenantBApiKey: process.env['OPENWOP_TENANT_B_API_KEY']?.trim() || null,
    tenantB: env('OPENWOP_TENANT_B', DEFAULT_TENANT_B),
    a2aWorkflowId: env('OPENWOP_A2A_WORKFLOW_ID', 'conformance-approval'),
    mcpStateSecret: env('OPENWOP_MCP_STATE_SECRET', randomBytes(32).toString('hex')),
    ...overrides,
  };
}
