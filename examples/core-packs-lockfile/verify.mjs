// Verify openwop-pack-lockfile.json against the registry's v2 tree.
//
// For each pinned pack:
//   1. Download the tarball from `resolved` and check its SHA-256 against
//      `integrity` (a mismatch fails the install: pack_integrity_mismatch).
//   2. Extract `pack.json`, check it is the pinned name/version and a v2
//      manifest (`kind`, an `engines.openwop` range whose ceiling admits 2).
//   3. Verify `signature.value` — the detached Ed25519 signature over the
//      RFC 8785 (JCS) bytes of `pack.json` (packs.md §Signing) — with
//      `signature.publicKey`.
//
//   node verify.mjs              verify the lockfile
//   node verify.mjs --generate   rewrite it from the registry's current `latest`
//
// Registry paths are resolved through `/.well-known/openwop-registry.json`
// `endpoints.v2`, never constructed (packs.md §"The registry tree").
//
// Zero dependencies — Node 20+ fetch, node:crypto, node:zlib.

import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const LOCKFILE = join(dirname(fileURLToPath(import.meta.url)), 'openwop-pack-lockfile.json');
const REGISTRY = 'https://packs.openwop.dev';
const PACKS = ['core.openwop.ai', 'core.openwop.http', 'core.openwop.mcp', 'core.openwop.triggers'];

async function get(url, as = 'json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

/** One regular file out of a gzipped USTAR tarball, or null. */
function readTarballFile(tgz, want) {
  const tar = gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const raw = tar.subarray(off, off + 100);
    const end = raw.indexOf(0);
    const name = raw.subarray(0, end < 0 ? 100 : end).toString('utf8').replace(/^\.\//, '');
    if (name === '') break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('ascii').replace(/\0/g, '').trim(), 8) || 0;
    const type = tar[off + 156];
    if (name === want && (type === 0x30 || type === 0)) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** RFC 8785 (JCS): keys sorted by UTF-16 code unit; ES number and string serialization. */
function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
}

const rawKeyOf = (pem) => {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64');
};
const keyFromRaw = (b64) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')]), format: 'der', type: 'spki' });

async function endpoints() {
  const meta = await get(`${REGISTRY}/.well-known/openwop-registry.json`);
  if (!meta.endpoints?.v2) throw new Error('the registry names no v2 tree (endpoints.v2)');
  return { v2: meta.endpoints.v2, publicKey: meta.endpoints.publicKey };
}

async function generate() {
  const { v2, publicKey } = await endpoints();
  const packs = [];
  for (const name of PACKS) {
    const index = await get(`${REGISTRY}${v2.packMetadata.replace('{name}', name)}`);
    const row = index.versions.find((v) => v.version === index.latest);
    const fill = (t) => t.replace('{name}', name).replace('{version}', row.version);
    const sig = await get(`${REGISTRY}${fill(v2.versionSignature)}`, 'bytes');
    const pem = (await get(`${REGISTRY}${publicKey.replace('{keyId}', row.signingKeyId)}`, 'bytes')).toString('utf8');
    const manifest = await get(`${REGISTRY}${fill(v2.versionManifest)}`);
    packs.push({
      name,
      version: row.version,
      resolved: `${REGISTRY}${fill(v2.versionTarball)}`,
      integrity: row.integrity,
      signature: { algorithm: 'ed25519', publicKey: rawKeyOf(pem), value: sig.toString('base64') },
      ...(manifest.peerDependencies ? { peerDependencies: manifest.peerDependencies } : {}),
    });
  }
  const lock = { lockfileVersion: 1, generatedAt: new Date().toISOString(), registry: REGISTRY, packs };
  writeFileSync(LOCKFILE, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`wrote ${LOCKFILE} (${packs.map((p) => `${p.name}@${p.version}`).join(', ')})`);
}

async function verify() {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
  let bad = 0;
  for (const p of lock.packs) {
    const tgz = await get(p.resolved, 'bytes');
    const digest = `sha256-${createHash('sha256').update(tgz).digest('base64')}`;
    const manifestBytes = readTarballFile(tgz, 'pack.json');
    const manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) : null;
    const ceiling = /<(\d+)\.0\.0$/.exec(manifest?.engines?.openwop ?? '')?.[1];
    const checks = {
      integrity: digest === p.integrity,
      identity: manifest?.name === p.name && manifest?.version === p.version,
      v2manifest: typeof manifest?.kind === 'string' && ceiling !== undefined && Number(ceiling) > 2,
      signature: manifest !== null && ed25519Verify(null, Buffer.from(jcs(manifest), 'utf8'), keyFromRaw(p.signature.publicKey), Buffer.from(p.signature.value, 'base64')),
    };
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0) bad++;
    console.log(`${failed.length === 0 ? '✓' : '✗'} ${p.name}@${p.version}  kind=${manifest?.kind ?? '?'} engines=${manifest?.engines?.openwop ?? '?'}${failed.length ? `  FAILED: ${failed.join(', ')}` : '  integrity + signature verified'}`);
  }
  if (bad > 0) {
    console.error(`✗ ${bad} of ${lock.packs.length} pinned packs failed verification`);
    process.exit(1);
  }
  console.log(`✓ all ${lock.packs.length} pinned packs verified against ${lock.registry}`);
}

(process.argv.includes('--generate') ? generate() : verify()).catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
