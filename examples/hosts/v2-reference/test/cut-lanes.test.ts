/**
 * The cut script and CI boot the SAME host. Every private-egress switch the host
 * reads (config.ts `OPENWOP_*_ALLOW_PRIVATE`) must be driven by cut-bundle.sh's
 * one ALLOW_PRIVATE posture (open on the loopback lane, closed under PUBLIC=1)
 * and set in both CI legs. The OAuth switch was set in CI but not in the script,
 * so every loopback rehearsal failed seven RFC 0199 positive controls with "the
 * token endpoint refused the exchange" while CI passed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
const cut = readFileSync(join(ROOT, 'scripts', 'cut-bundle.sh'), 'utf8');
const ci = readFileSync(join(ROOT, '..', '..', '..', '.github', 'workflows', 'host-v2-reference.yml'), 'utf8');
const switches = [...new Set([...config.matchAll(/envBool\('(OPENWOP_[A-Z_]*ALLOW_PRIVATE)'/g)].map((m) => m[1] as string))];

describe('the cut script sets every private-egress switch the host reads', () => {
  it('cut-bundle.sh parses (bash -n)', () => {
    expect(() => execFileSync('bash', ['-n', join(ROOT, 'scripts', 'cut-bundle.sh')], { stdio: 'pipe' })).not.toThrow();
  });
  it('finds the host\'s switches', () => {
    expect(switches.sort()).toEqual(['OPENWOP_OAUTH_ALLOW_PRIVATE', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE']);
  });
  it.each(switches)('%s follows the ALLOW_PRIVATE posture in cut-bundle.sh and is set in both CI legs', (name) => {
    expect(cut, `cut-bundle.sh must launch the host with ${name}="$ALLOW_PRIVATE"`).toContain(`${name}="$ALLOW_PRIVATE"`);
    expect(ci.split(`${name}: 'true'`).length - 1, `both CI legs set ${name}`).toBe(2);
  });
});
