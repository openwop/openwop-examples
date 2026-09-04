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
import { createHash } from 'node:crypto';
import { ENGINE_VERSION, EVENT_LOG_SCHEMA_VERSION, EXTENSION_ORG, HOST_ID, HOST_NAME, HOST_VENDOR, HOST_VERSION, MIN_CLIENT_VERSION, PROTOCOL_VERSIONS, SEAMS_PROFILE_ID, SESSION_ISSUER, API_KEY_ISSUER, V1_VERSION } from './config.js';
import type { Host } from './host.js';

const SINCE = '2.0';

export function advertisedFixtures(host: Host): string[] {
  return [...host.workflows.keys()].sort();
}

/** The closed v2 root (schemas/v2/capabilities.schema.json). */
export function v2Document(host: Host): Record<string, unknown> {
  const c = host.config;
  const record = (witness: string, facets: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'stable', since: SINCE, witness, ...facets });
  const doc: Record<string, unknown> = {
    protocolVersions: [...PROTOCOL_VERSIONS],
    preferredVersion: c.preferredVersion,
    minClientVersion: MIN_CLIENT_VERSION,
    implementation: { name: HOST_NAME, version: HOST_VERSION, vendor: HOST_VENDOR },
    engineVersion: ENGINE_VERSION,
    eventLogSchemaVersion: EVENT_LOG_SCHEMA_VERSION,
    fixtures: advertisedFixtures(host),
    testing: { testKeyPrefix: 'ow2k_' },
    extensions: {
      [`${EXTENSION_ORG}.host`]: { hostId: HOST_ID, build: c.hostBuild, webhookBackoffBaseMs: c.webhookBackoffBaseMs, deadLetterRetentionDays: c.webhookRetentionDays, deadLetterRead: '/webhooks/{webhookId}/dead-letters' },
    },
    // ── core families ───────────────────────────────────────────────────
    limits: record('witnessable-gated', { clarificationRounds: 0, schemaRounds: 0, envelopesPerTurn: 0, maxNodeExecutions: 1000, maxRunDurationMs: 600_000, maxRequestBodyBytes: 4_194_304 }),
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
