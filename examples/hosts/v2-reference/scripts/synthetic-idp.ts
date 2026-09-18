/**
 * The operator-supplied synthetic SAML IdP the RFC 0050 seams need
 * (host-sample-test-seams.md names it and leaves its HTTP shape to the
 * operator). Built on the suite's own minter so the assertions are exactly
 * the ones conformance reasons about. Shape, which the reference host's ACS
 * consumes and which any host may share:
 *
 *   GET {idpUrl}/metadata                     → { entityID, certificatePem }
 *   GET {idpUrl}/assert?variant=<v>&nameId=<n> → { entityID, certificatePem, assertion }
 *
 * Run: npx tsx scripts/synthetic-idp.ts [port] [entityID]
 * Then: OPENWOP_TEST_SAML_IDP_URL=http://127.0.0.1:<port> OPENWOP_TEST_SCIM_URL=urn:openwop:conformance:scim npx openwop-conformance …
 */
import { createServer } from 'node:http';
import { createSyntheticSamlIdp, type SamlVariant } from '@openwop/openwop-conformance/src/lib/saml-idp.js';

export function startSyntheticIdp(port = 0, entityID?: string): Promise<{ url: string; close: () => void; entityID: string }> {
  const idp = createSyntheticSamlIdp(entityID ? { entityID } : undefined);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const json = (b: unknown): void => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/metadata') return json({ entityID: idp.entityID, certificatePem: idp.certificatePem });
    if (u.pathname === '/assert') {
      const variant = (u.searchParams.get('variant') ?? 'valid') as SamlVariant;
      const nameId = u.searchParams.get('nameId') ?? undefined;
      return json({ entityID: idp.entityID, certificatePem: idp.certificatePem, assertion: idp.mint(variant, nameId ? { subject: nameId } : undefined) });
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const a = server.address(); const p = typeof a === 'object' && a ? a.port : port;
    resolve({ url: `http://127.0.0.1:${p}`, close: () => server.close(), entityID: idp.entityID });
  }));
}

if (process.argv[1] && process.argv[1].endsWith('synthetic-idp.ts')) {
  // `--exit-with-parent` ties the process to a piped stdin, so a spawning test
  // harness leaves no orphan holding the port (CI's retired lane reuses 3839).
  // It is OPT-IN: a detached operator launch (`npx tsx … &`) has a stdin that
  // ends immediately, and tying to it silently killed the IdP mid-cut — the
  // subject-link rows then recorded `blocked` with no sign of why.
  if (process.argv.includes('--exit-with-parent')) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
  const port = Number(process.argv[2] ?? 3839);
  startSyntheticIdp(port, process.argv[3]).then((s) => console.log(`synthetic IdP ${s.entityID} at ${s.url}`)).catch((e) => { console.error(e); process.exit(1); });
}
