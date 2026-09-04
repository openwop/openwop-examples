/**
 * capabilities.md — one well-known resource, header-selected representation:
 *   no header  ⇒ preferredVersion's major (versioning.md §1.3); through the
 *                overlap that is the v1 document with protocolVersions[] +
 *                preferredVersion additive (RFC 0176 §C.1)
 *   OpenWOP-Version: 2 ⇒ the closed v2 root: metadata keys + family records
 *                {status, since, witness, ...facets}; no wrapper, no dotted
 *                mirror, no profiles[], no supportedTransports, no grpc.
 * Both carry a standard ETag and honour If-None-Match with 304.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { ENGINE_VERSION, EVENT_LOG_SCHEMA_VERSION, EXTENSION_ORG, HOST_ID, HOST_NAME, HOST_VENDOR, HOST_VERSION, MIN_CLIENT_VERSION, PROTOCOL_VERSIONS, SEAMS_PROFILE_ID, BUNDLE_SIGNING_KEY_ID, KEYS_DIR, SESSION_ISSUER, API_KEY_ISSUER, V1_VERSION } from './config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from './host.js';

const SINCE = '2.0';
/**
 * capabilities.md §8 — the `technical` maturity axis IS the record's `status`,
 * and `until` is REQUIRED when a record is not `stable`. `spec/v2/declaration.json`
 * declares every family this host advertises `technical: experimental` except
 * `limits`, so the records say so rather than over-claiming maturity. `2.1` is
 * the horizon by which each either stabilises or carries a removal row; it is
 * not in the past while the host serves 2.0.
 */
const EXPERIMENTAL_UNTIL = '2.1';

export function advertisedFixtures(host: Host): string[] {
  return [...host.workflows.keys()].sort();
}


/**
 * RFC 0168 §E.2 — the public half of the key this host signs bundles with,
 * derived from `keys/host.pub.pem` at startup rather than pasted in.
 *
 * Deriving it matters. A hand-copied constant can drift from the key that
 * actually signs, and the failure is invisible until a verifier tries to check
 * a bundle and cannot — which is the worst place to discover it. Reading the
 * same file the signer reads makes the published value wrong only if the key
 * itself is wrong.
 *
 * The wire form is raw base64url, unpadded (43 chars) — NOT PEM. That is the
 * last 32 bytes of the SPKI DER, which is the Ed25519 point itself.
 */
function signingPublicKeyB64u(): string {
  const pem = readFileSync(join(KEYS_DIR, 'host.pub.pem'), 'utf8');
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The `signingKeys[]` record, identical on both roots — a bundle is v3 regardless of major. */
export function signingKeys(): ReadonlyArray<Record<string, unknown>> {
  return [{ keyId: BUNDLE_SIGNING_KEY_ID, alg: 'ed25519', publicKey: signingPublicKeyB64u(), use: 'certification-bundle' }];
}

/** The closed v2 root (schemas/v2/capabilities.schema.json). */
export function v2Document(host: Host): Record<string, unknown> {
  const c = host.config;
  const record = (witness: string, facets: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'experimental', since: SINCE, until: EXPERIMENTAL_UNTIL, witness, ...facets });
  const stable = (witness: string, facets: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'stable', since: SINCE, witness, ...facets });
  const doc: Record<string, unknown> = {
    protocolVersions: [...PROTOCOL_VERSIONS],
    preferredVersion: c.preferredVersion,
    minClientVersion: MIN_CLIENT_VERSION,
    implementation: { name: HOST_NAME, version: HOST_VERSION, vendor: HOST_VENDOR },
    engineVersion: ENGINE_VERSION,
    eventLogSchemaVersion: EVENT_LOG_SCHEMA_VERSION,
    signingKeys: signingKeys(),
    fixtures: advertisedFixtures(host),
    testing: { testKeyPrefix: 'ow2k_' },
    extensions: {
      [`${EXTENSION_ORG}.host`]: { hostId: HOST_ID, build: c.hostBuild, webhookBackoffBaseMs: c.webhookBackoffBaseMs, deadLetterRetentionDays: c.webhookRetentionDays, deadLetterRead: '/webhooks/{webhookId}/dead-letters' },
    },
    // ── core families ───────────────────────────────────────────────────
    limits: stable('witnessable-gated', { clarificationRounds: 0, schemaRounds: 0, envelopesPerTurn: 0, maxNodeExecutions: 1000, maxRunDurationMs: 600_000, maxRequestBodyBytes: 4_194_304 }),
    eventLog: record('claims-check', { crossEngineOrdering: { orderingModel: 'global-sequencer' } }),
    interrupt: record('witnessable-gated', { tokenAlgs: ['hs256'], refKinds: ['principal'] }),
    replay: record('witnessable-gated', { modes: ['replay', 'branch'], retention: { days: c.replayRetentionDays }, effectSeamsManifest: '/host/effect-seams' }),
    webhooks: record('witnessable-gated', { signatureAlgorithms: ['v1'], retryPolicy: { maxAttempts: c.webhookMaxAttempts, backoff: 'exponential' } }),
    idempotency: record('witnessable-gated', { crossRegion: 'single-region' }),
    compensation: record('seam-gated', { profileVersion: '1', orderingModels: ['reverse-completion'], manualIntervention: false }),
    feedback: record('witnessable-gated', { targets: ['run', 'event', 'node'], signals: ['rating', 'correction', 'label', 'flag'] }),
    heartbeat: record('witnessable-gated', { minIntervalSec: 5, maxRuntimeMs: 1000, deliveryChannel: '/host/events' }),
    packs: record('claims-check', { testMode: { isolated: true, scopes: ['core', 'vendor', 'community', 'private', 'local'] } }),
    workspace: record('witnessable-gated', { versioned: false, maxFileBytes: 262_144, maxFiles: 256 }),
    auth: record('seam-gated', {
      lanes: [
        { lane: 'api-key', issuers: [API_KEY_ISSUER], revocation: 'next-request', minimumAssurance: 'bearer' },
        { lane: 'session', issuers: [SESSION_ISSUER], revocation: 'next-request', minimumAssurance: 'bearer' },
        { lane: 'workload', issuers: [...c.workloadTrustRoots], revocation: 'delegation-expiry', minimumAssurance: 'key-bound', delegationProofs: ['svid-chain', 'mtls-key-binding'] },
      ],
    }),
  };
  if (c.seamsProfile) {
    // RFC 0168 §C.1 reconciliation (suite lib/seams.ts): the seams profile is
    // advertised under the `conformance` METADATA key. NOTE: the generated
    // capabilities.schema.json still closes `conformance` without
    // `seamsProfile` — see README "Known corpus defects".
    doc['conformance'] = { seamsProfile: SEAMS_PROFILE_ID };
  }
  return doc;
}

/** The v1 document through the overlap: protocolVersion + the three v1 REQUIRED keys, plus protocolVersions[] and preferredVersion (RFC 0165 §A, RFC 0179). */
export function v1Document(host: Host): Record<string, unknown> {
  const c = host.config;
  return {
    protocolVersion: V1_VERSION,
    protocolVersions: [...PROTOCOL_VERSIONS],
    preferredVersion: c.preferredVersion,
    minClientVersion: MIN_CLIENT_VERSION,
    implementation: { name: HOST_NAME, version: HOST_VERSION, vendor: HOST_VENDOR },
    engineVersion: ENGINE_VERSION,
    eventLogSchemaVersion: EVENT_LOG_SCHEMA_VERSION,
    // Present on the v1 root too: a certification bundle is v3 regardless of
    // major, so a verifier resolving signature.keyId may only have this
    // document to resolve it against (RFC 0168 §E.2, v1.x additive half).
    signingKeys: signingKeys(),
    supportedEnvelopes: [],
    schemaVersions: {},
    limits: { clarificationRounds: 0, schemaRounds: 0, envelopesPerTurn: 0, maxNodeExecutions: 1000, maxRunDurationMs: 600_000 },
    fixtures: advertisedFixtures(host),
    // v1 readers: the surfaces this host serves under /v1/ keys through the overlap.
    interrupt: { supported: true, tokenAlgs: ['hs256'] },
    replay: { supported: true, fork: true, modes: ['replay', 'branch'] },
    webhooks: { supported: true, durable: true, signatureAlgorithms: ['v1'], retryPolicy: { maxAttempts: c.webhookMaxAttempts, backoff: 'exponential' } },
    idempotency: { supported: true, crossRegion: 'single-region' },
  };
}

export function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
}
