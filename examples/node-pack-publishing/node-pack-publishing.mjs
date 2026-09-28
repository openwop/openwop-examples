// Node-pack publishing example — build a v2 manifest, sign it, verify it,
// and show how it would reach a registry.
//
// Defaults to --dry-run (no network):
//
//   1. Generate an Ed25519 keypair.
//   2. Build a v2 node-pack manifest (`pack.json`) under the
//      `private.local-example` scope — `private.*` MUST NOT appear in a public
//      registry, so the example is safe by default.
//   3. Sign the RFC 8785 (JCS) bytes of `pack.json` with the private key:
//      the one v2 scheme, `ed25519-canonical-json` (packs.md §Signing).
//   4. Verify the signature with the public key.
//
// --print-publish-cmd additionally reads the registry's
// `/.well-known/openwop-registry.json` and prints where this version would
// live in the registry's v2 tree and how that registry accepts submissions.
// Registry paths are resolved through that document's `endpoints.v2`, never
// constructed (packs.md §"The registry tree"). `--live` is a deprecated alias.
//
// Configuration via env vars (--print-publish-cmd only):
//   OPENWOP_PACK_REGISTRY_URL  default https://packs.openwop.dev
//
// @see spec/v2/core/packs.md (§"The engine range", §Signing, §"The registry tree")
// @see schemas/v2/node-pack-manifest.schema.json

import { generateKeyPairSync, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';

// Tiny ANSI helpers — colors when stdout is a TTY, no-op when piped/CI.
const _tty = process.stdout.isTTY;
const _c = _tty
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', reset: '' };
const fail = (msg) => console.error(`${_c.red}${msg}${_c.reset}`);
const ok = (msg) => console.log(`${_c.green}${msg}${_c.reset}`);

const args = new Set(process.argv.slice(2));
const PRINT_PUBLISH = args.has('--print-publish-cmd') || args.has('--live');
const REGISTRY_URL = (process.env.OPENWOP_PACK_REGISTRY_URL || 'https://packs.openwop.dev').replace(/\/$/, '');
const KEY_ID = 'local-example-1';

/**
 * RFC 8785 (JCS) for the values a manifest holds — objects with keys sorted by
 * UTF-16 code unit, arrays in order, strings and integers as JSON.stringify
 * writes them. A manifest MUST be I-JSON (conformance.md §"Canonical JSON"):
 * no non-integer numbers here, so no JCS number formatting is needed.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function buildManifest() {
  return {
    kind: 'node',
    name: 'private.local-example.echo-tool',
    version: '1.0.0',
    description: 'Reference example pack — one pure echo node, demonstration only.',
    license: 'Apache-2.0',
    // A `>=` lower bound and an explicit `<` major ceiling (packs.md §"The engine range").
    engines: { openwop: '>=2.0.0 <3.0.0' },
    runtime: { language: 'javascript', entry: 'dist/index.js', format: 'esm' },
    nodes: [
      {
        typeId: 'private.local-example.echo-tool.echo',
        version: '1.0.0',
        label: 'Echo',
        category: 'data',
        role: 'pure',
        capabilities: ['cacheable'],
      },
    ],
    // Optional on a bare manifest; when present, the closed { keyId, scheme } block.
    signing: { keyId: KEY_ID, scheme: 'ed25519-canonical-json' },
  };
}

function dryRun(manifest, canonical, signature, publicKey) {
  console.log('→ Built pack.json:');
  console.log(`  kind:     ${manifest.kind}`);
  console.log(`  name:     ${manifest.name}`);
  console.log(`  version:  ${manifest.version}`);
  console.log(`  engines:  openwop ${manifest.engines.openwop}`);
  console.log('  scope:    private.local-example (MUST NOT appear in a public registry)');
  console.log(`  signing:  ${manifest.signing.scheme} / keyId ${manifest.signing.keyId}`);
  console.log('');
  console.log(`→ JCS bytes (${Buffer.byteLength(canonical)}):`);
  console.log(`  ${canonical.slice(0, 120)}${canonical.length > 120 ? '...' : ''}`);
  console.log('');
  console.log(`→ Ed25519 signature (64 bytes, base64): ${signature.toString('base64').slice(0, 40)}...`);
  console.log(`→ Public key (raw 32 bytes, base64):    ${rawPublicKey(publicKey)}`);
  console.log('');
}

function rawPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64');
}

async function printPublish(manifest) {
  console.log(`→ Registry: ${REGISTRY_URL}/.well-known/openwop-registry.json`);
  const res = await fetch(`${REGISTRY_URL}/.well-known/openwop-registry.json`);
  if (!res.ok) {
    fail(`✗ registry metadata fetch failed: ${res.status}`);
    process.exit(1);
  }
  const meta = await res.json();
  const v2 = meta.endpoints?.v2;
  if (!v2) {
    fail('✗ This registry names no v2 tree (`endpoints.v2`); it cannot serve a v2 pack.');
    process.exit(1);
  }
  const fill = (t) => t.replace('{name}', manifest.name).replace('{version}', manifest.version);
  console.log(`  name: ${meta.name ?? '<unnamed>'}`);
  console.log(`  signing schemes: [${(meta.supportedSigningSchemes ?? []).join(', ')}]`);
  console.log('  This version would live in the v2 tree at:');
  for (const k of ['versionManifest', 'versionTarball', 'versionSignature', 'versionSbom']) {
    if (v2[k]) console.log(`    ${k.padEnd(16)} ${REGISTRY_URL}${fill(v2[k])}`);
  }
  const write = meta.writeApi ?? {};
  console.log('');
  if (write.supported === true) {
    console.log(`  Submissions: ${write.publishMethod ?? 'write API'} at ${write.publishUrl ?? '<unnamed>'}`);
  } else {
    console.log(`  Submissions: no write API; publish by ${write.publishMethod ?? 'the operator\'s process'}${write.publishUrl ? ` at ${write.publishUrl}` : ''}.`);
  }
  console.log('  Before submitting: register your keyId with the registry operator (its');
  console.log('  signingKeys[] entry names the namespaces the key may sign), use a public');
  console.log('  scope (vendor.<org>.* / community.<author>.*), and build a deterministic');
  console.log('  tarball containing pack.json and the runtime entry. The registry refuses a');
  console.log('  republished version, a bad signature, or an engine range without a ceiling.');
  console.log('');
  ok('✓ Publish plan printed (no submission made).');
}

async function main() {
  console.log('=== OpenWOP v2 node-pack publishing example ===');
  console.log(`Mode: ${PRINT_PUBLISH ? 'print-publish-cmd' : 'dry-run (default)'}`);
  console.log('');

  console.log('→ Generating Ed25519 keypair...');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log('  ✓ keypair generated');

  const manifest = buildManifest();
  const canonical = canonicalJson(manifest);
  const signature = ed25519Sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  dryRun(manifest, canonical, signature, publicKey);

  console.log('→ Verifying the signature against the public key...');
  if (!ed25519Verify(null, Buffer.from(canonical, 'utf8'), publicKey, signature)) {
    fail('✗ signature did not verify');
    process.exit(1);
  }
  const tampered = canonicalJson({ ...manifest, version: '1.0.1' });
  if (ed25519Verify(null, Buffer.from(tampered, 'utf8'), publicKey, signature)) {
    fail('✗ a changed manifest still verified');
    process.exit(1);
  }
  console.log('  ✓ verifies; a manifest with a changed version does not');
  console.log('');

  if (!PRINT_PUBLISH) {
    console.log('Re-run with --print-publish-cmd to see where this version would live in a');
    console.log("registry's v2 tree and how that registry accepts submissions.");
    console.log('');
    ok('✓ Dry-run complete (no network calls made).');
    return;
  }
  await printPublish(manifest);
}

main().catch((err) => {
  fail(`✗ ${err.message}`);
  process.exit(1);
});
