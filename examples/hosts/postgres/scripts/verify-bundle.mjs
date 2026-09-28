#!/usr/bin/env node
/**
 * Verify a certification bundle v3 this host cut, against the host's LIVE
 * discovery document — the attribution check RFC 0168 §E.2 asks for, and the
 * same computation `scripts/check-cut-gates.mjs` (openwop) performs:
 *
 *   1. bundle.discovery.url is exactly <base>/.well-known/openwop — the bundle
 *      measured THIS host, not a stale process on the same port;
 *   2. the embedded discovery.document hashes to the signed discovery.sha256;
 *   3. signature.keyId resolves in the live discovery's signingKeys[] (and in
 *      the embedded copy), and the Ed25519 attestation over
 *      {witnessSha256, host.build, suite.version, discovery.sha256} verifies
 *      under the PUBLISHED key;
 *   4. prints totals and the RFC 0218 rows.
 *
 *   node scripts/verify-bundle.mjs <bundle.json> <base-url> [--require-0218]
 *
 * Exit 0 on a verified, attributed signature (and, with --require-0218, both
 * 0218 rows executed-pass); 1 otherwise. It does NOT judge certification —
 * that is the suite's `--verify`.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [bundlePath, baseArg] = process.argv.slice(2);
const require0218 = process.argv.includes('--require-0218');
if (!bundlePath || !baseArg) { console.error('usage: verify-bundle.mjs <bundle.json> <base-url> [--require-0218]'); process.exit(2); }
const base = baseArg.replace(/\/+$/, '');
const b = JSON.parse(readFileSync(bundlePath, 'utf8'));
const fails = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { fails.push(m); console.log(`  FAIL ${m}`); };

const canonicalJSON = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
};
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const rawKey = (b64u) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(b64u, 'base64url')]), format: 'der', type: 'spki' });

console.log(`bundle ${bundlePath}: v${b.bundleVersion}, suite ${b.suite?.version} (targetMajor ${b.suite?.targetMajor}), host.build ${JSON.stringify(b.host?.build)}`);

const wantUrl = `${base}/.well-known/openwop`;
b.discovery?.url === wantUrl ? ok(`discovery.url = ${wantUrl}`) : bad(`discovery.url is ${b.discovery?.url}, want ${wantUrl}`);

const embedded = b.discovery?.document;
const digest = embedded ? createHash('sha256').update(canonicalJSON(embedded)).digest('hex') : null;
digest && digest === b.discovery?.sha256 ? ok('embedded discovery.document hashes to the signed discovery.sha256') : bad(`embedded discovery.document digest ${digest} != discovery.sha256 ${b.discovery?.sha256}`);

const sig = b.signature ?? {};
let live;
try {
  const r = await fetch(wantUrl);
  live = await r.json();
  ok(`fetched live discovery (${r.status})`);
} catch (e) { bad(`could not fetch live discovery ${wantUrl}: ${e.message}`); }

const payload = Buffer.from(canonicalJSON({ witnessSha256: b.witnessSha256, 'host.build': b.host?.build, 'suite.version': b.suite?.version, 'discovery.sha256': b.discovery?.sha256 }), 'utf8');
for (const [where, doc] of [['live', live], ['embedded', embedded]]) {
  if (!doc) continue;
  const keys = Array.isArray(doc.signingKeys) ? doc.signingKeys : [];
  const k = keys.find((x) => x && x.keyId === sig.keyId);
  if (!k) { bad(`${where} discovery: signature.keyId ${sig.keyId} is not among signingKeys[] (${keys.map((x) => x.keyId).join(', ') || 'none published'})`); continue; }
  let v = false;
  try { v = verify(null, payload, rawKey(k.publicKey), Buffer.from(String(sig.sig), 'base64url')); } catch { v = false; }
  v ? ok(`${where} discovery: signature verifies under published ${sig.keyId} (${k.publicKey})`) : bad(`${where} discovery: signature does NOT verify under published ${sig.keyId}`);
}

const t = b.results?.totals ?? {};
console.log(`totals ${JSON.stringify(t)}`);
console.log(`certified profiles: ${(b.claimedProfiles ?? []).filter((p) => p.certified).map((p) => p.id).join(', ') || 'none'}`);
const rows = (b.results?.requirements ?? []).filter((r) => String(r.id).includes('.0218.'));
for (const r of rows) console.log(`  ${r.id}  ${r.result}${r.detail ? `  — ${String(r.detail).slice(0, 140)}` : ''}`);
if (require0218) {
  for (const id of ['openwop.requirement.0218.checkpoint-signature-over-root', 'openwop.requirement.0218.checkpoint-preimage-vectors']) {
    const r = rows.find((x) => x.id === id);
    r?.result === 'executed-pass' ? ok(`${id} executed-pass`) : bad(`${id} is ${r?.result ?? 'absent'}`);
  }
}
if (fails.length) { console.error(`VERIFY FAILED (${fails.length})`); process.exit(1); }
console.log(`VERIFIED: signature attributes to ${sig.keyId} via ${wantUrl}`);
