/**
 * packs.md — the install path the suite can drive: the packs-test publish seam
 * (`PUT /conformance/seams/packs-test/{name}/-/{version}.tgz`, an isolated
 * catalog). Every publication path runs the same checks:
 *
 *   - `engines.openwop` MUST admit the host's protocol major; a range with no
 *     upper bound reads `<2.0.0`; otherwise 400 pack_engine_unsupported
 *   - every `peerDependencies` key MUST be a declaration-file family (or an
 *     overlap alias row); otherwise 400 pack_peer_dependency_undefined
 *   - `kind` is REQUIRED; the vendor hatch `^(openwop-|x-|vendor\.)` is ignored
 *     anywhere in a pack-authored document (never rejected)
 *
 * This host registers and validates packs; it does not execute third-party
 * pack code (it advertises no `sandbox`), which security-defaults.md permits.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { err } from './errors.js';
import { nowIso } from './ids.js';
import type { Host } from './host.js';
import type { PackRow } from './store.js';

const HOST_MAJOR = 2;
const PACK_NAME = /^(core|vendor|community|private|local)\.[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const HATCH = /^(openwop-|x-|vendor\.)/;
const KINDS = new Set(['node', 'prompt', 'workflow-chain', 'artifact-type', 'chat-card', 'connection', 'form-content', 'frontend-plugin']);

interface TarEntry { name: string; data: Buffer }

/** A minimal ustar reader (512-byte headers, size in octal at 124..136). */
export function readTar(tgz: Buffer): TarEntry[] {
  let tar: Buffer;
  try { tar = gunzipSync(tgz); } catch { throw err('pack_validation_failed', 'the tarball is not gzip', { reason: 'tarball_gunzip_failed' }); }
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeStr || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw err('pack_validation_failed', 'a tar header is malformed', { reason: 'tarball_tar_parse_failed' });
    const type = String.fromCharCode(header[156] ?? 48);
    const full = prefix ? `${prefix}/${name}` : name;
    if (full.split('/').includes('..')) throw err('pack_validation_failed', 'a tar entry escapes the pack root', { reason: 'tarball_path_traversal' });
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (type === '0' || type === '\0' || type === '') entries.push({ name: full.replace(/^\.\//, ''), data: Buffer.from(data) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** packs.md §The engine range: `>=a.b.c <X.0.0`; absent ceiling ⇒ <2.0.0. */
export function rangeAdmitsMajor(range: string, major: number): boolean {
  const lower = /(?:^|\s)>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  const upper = /<\s*(\d+)\.0\.0/.exec(range) ?? /<\s*(\d+)(?:\.\d+)?(?:\.\d+)?/.exec(range);
  const lowerMajor = lower ? Number(lower[1]) : 0;
  const ceiling = upper ? Number(upper[1]) : 2;
  return lowerMajor <= major && major < ceiling;
}

function stripHatch(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(stripHatch);
  if (doc !== null && typeof doc === 'object') {
    return Object.fromEntries(Object.entries(doc as Record<string, unknown>).filter(([k]) => !HATCH.test(k)).map(([k, v]) => [k, stripHatch(v)]));
  }
  return doc;
}

export function validateManifest(host: Host, manifest: Record<string, unknown>, name: string, version: string): Record<string, unknown> {
  // The vendor hatch is ignored, never rejected (packs.md §The manifest schema family).
  const m = stripHatch(manifest) as Record<string, unknown>;
  if (m['name'] !== name) throw err('pack_validation_failed', 'manifest name does not match the URL', { reason: 'manifest_name_mismatch' });
  if (m['version'] !== version) throw err('pack_validation_failed', 'manifest version does not match the URL', { reason: 'manifest_version_mismatch' });
  if (typeof m['kind'] !== 'string') throw err('pack_kind_invalid', '`kind` is REQUIRED on every manifest (packs.md §Version manifests)');
  if (!KINDS.has(m['kind'])) throw err('pack_kind_invalid', `kind ${m['kind']} is not a pack kind`, { kind: m['kind'] });
  const engines = m['engines'] as { openwop?: unknown } | undefined;
  const range = engines && typeof engines === 'object' && typeof engines.openwop === 'string' ? engines.openwop : '>=1.0.0';
  if (!rangeAdmitsMajor(range, HOST_MAJOR)) {
    throw err('pack_engine_unsupported', `engines.openwop ${JSON.stringify(range)} does not admit protocol major ${HOST_MAJOR}${/<\s*\d/.test(range) ? '' : ' (a range with no upper bound reads <2.0.0)'}`, { range, hostMajor: HOST_MAJOR });
  }
  const peers = m['peerDependencies'];
  if (peers !== undefined) {
    if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) throw err('pack_validation_failed', 'peerDependencies MUST be an object');
    for (const key of Object.keys(peers as Record<string, unknown>)) {
      if (host.artifacts.familyKeys.has(key)) continue;
      const alias = host.artifacts.peerAliases.get(key);
      if (alias !== undefined) continue; // overlap alias (packs.md §The alias table; a MAY through the overlap)
      throw err('pack_peer_dependency_undefined', `peerDependencies key ${key} is not a spec/v2/declaration.json family nor an overlap alias`, { key });
    }
  }
  if (m['kind'] === 'node') {
    const runtime = m['runtime'] as { language?: unknown; entry?: unknown } | undefined;
    if (!runtime || typeof runtime !== 'object' || typeof runtime.language !== 'string') throw err('pack_validation_failed', 'a node pack MUST declare runtime.language', { reason: 'invalid_manifest' });
    if (!Array.isArray(m['nodes'])) throw err('pack_validation_failed', 'a node pack MUST declare nodes[]', { reason: 'invalid_manifest' });
  }
  if (m['kind'] === 'prompt') {
    if (!Array.isArray(m['prompts']) || m['prompts'].length === 0) throw err('pack_validation_failed', 'a prompt pack MUST declare prompts[] (minItems 1)', { reason: 'invalid_manifest' });
    for (const p of m['prompts'] as Array<Record<string, unknown>>) {
      if (typeof p['templateId'] !== 'string' || typeof p['version'] !== 'string') throw err('pack_validation_failed', 'every prompt template names templateId + version', { reason: 'invalid_manifest' });
    }
  }
  return m;
}

export function publishTestPack(host: Host, name: string, version: string, tgz: Buffer, assertedSha: string | null): { status: number; body: Record<string, unknown> } {
  if (!PACK_NAME.test(name)) throw err('pack_validation_failed', 'pack name is outside the reverse-DNS grammar', { reason: 'invalid_pack_name' });
  if (!SEMVER.test(version)) throw err('pack_validation_failed', 'version is not SemVer 2.0.0', { reason: 'invalid_version' });
  if (tgz.length === 0) throw err('pack_validation_failed', 'empty body', { reason: 'invalid_body' });
  if (tgz.length > 8 * 1024 * 1024) throw err('pack_validation_failed', 'tarball exceeds 8 MiB', { reason: 'tarball_too_large' });
  const sha256 = `sha256-${createHash('sha256').update(tgz).digest('base64')}`;
  if (assertedSha !== null && assertedSha !== sha256) throw err('pack_integrity_failure', 'the asserted OpenWOP-Pack-Sha256 does not match the uploaded bytes', { asserted: assertedSha, computed: sha256 });
  const existing = host.store.getPack('test', name, version);
  if (existing !== undefined) {
    if (existing.sha256 === sha256) return { status: 200, body: record(existing) };
    throw err('version_conflict', `${name}@${version} is already published with different content`);
  }
  const entries = readTar(tgz);
  const packJson = entries.find((e) => e.name === 'pack.json' || e.name.endsWith('/pack.json'));
  if (!packJson) throw err('pack_validation_failed', 'pack.json is missing from the tarball root', { reason: 'tarball_manifest_missing' });
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(packJson.data.toString('utf8')) as Record<string, unknown>; } catch { throw err('pack_validation_failed', 'pack.json is not JSON', { reason: 'tarball_manifest_not_json' }); }
  const validated = validateManifest(host, manifest, name, version);
  const row: PackRow = { catalog: 'test', name, version, kind: String(validated['kind']), manifest_json: JSON.stringify(manifest), tarball: tgz, sha256, published_at: nowIso() };
  host.store.insertPack(row);
  return { status: 201, body: record(row) };
}

function record(row: PackRow): Record<string, unknown> {
  return { name: row.name, version: row.version, tarballSha256: row.sha256, publishedAt: row.published_at, signed: false, signingMethod: 'none' };
}

export function installedPacks(host: Host, catalog: 'prod' | 'test'): Record<string, unknown> {
  return { packs: host.store.listPacks(catalog).map((p) => ({ name: p.name, version: p.version, kind: p.kind, tarballSha256: p.sha256, publishedAt: p.published_at })) };
}
