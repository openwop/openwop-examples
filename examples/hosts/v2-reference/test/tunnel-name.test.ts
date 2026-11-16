/**
 * cut-public.sh accepts a tunnel only by `scripts/tunnel-name.sh`. On 2026-11-16 a
 * quick-tunnel request timed out, cloudflared's error line named its own API, and
 * the script took `https://api.trycloudflare.com` as the OAuth authorization
 * server's public name. That cost a full uncertified cut. These cases pin the
 * refusal so one bad tunnel costs seconds, before any scenario runs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'scripts', 'tunnel-name.sh');
// Under the flags cut-public.sh itself runs with, so a helper that returns non-zero
// where the script cannot afford it fails here, not in a live cut.
const sh = (script: string): { code: number; out: string } => {
  try { return { code: 0, out: execFileSync('bash', ['-c', `set -euo pipefail; . "${HELPER}"; ${script}`], { encoding: 'utf8' }).trim() }; }
  catch (e) { const x = e as { status?: number; stdout?: string }; return { code: x.status ?? 1, out: String(x.stdout ?? '').trim() }; }
};
const log = (text: string): string => { const p = join(mkdtempSync(join(tmpdir(), 'tunnel-name-')), 'cf.log'); writeFileSync(p, text); return p; };

const FAILED = '2026-11-16T20:30:07Z INF Requesting new quick Tunnel on trycloudflare.com...\nfailed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)\n';
const GOOD = '2026-11-16T20:30:09Z INF |  https://solved-edges-alex-inn.trycloudflare.com                                           |\n';

describe('cut-public accepts only quick-tunnel names', () => {
  it('refuses cloudflared\'s API name and other non-tunnel shapes', () => {
    for (const u of ['https://api.trycloudflare.com', 'https://api-edge-tunnel.trycloudflare.com', 'https://www.trycloudflare.com', 'https://two-words.trycloudflare.com', 'https://a.b-c-d.trycloudflare.com', 'http://solved-edges-alex-inn.trycloudflare.com', 'https://solved-edges-alex-inn.trycloudflare.com.evil.example']) {
      expect(sh(`valid_tunnel_url '${u}'`).code, u).not.toBe(0);
    }
    expect(sh("valid_tunnel_url 'https://solved-edges-alex-inn.trycloudflare.com'").code).toBe(0);
  });

  it('a failed quick-tunnel request yields no URL, even though its log names one', () => {
    expect(sh(`quick_tunnel_url '${log(FAILED)}'`).out).toBe('');
    expect(sh(`quick_tunnel_url '${log(FAILED + GOOD)}'`).out, 'a log that recorded the failure is not trusted later').toBe('');
  });

  it('an empty or still-silent log yields nothing and does not end the caller under set -euo pipefail', () => {
    // The shape cut-public.sh uses: an assignment from $( ), then a line after it.
    const r = sh(`x="$(quick_tunnel_url '${log('')}')"; echo "survived:[$x]"`);
    expect(r, 'the first tunnel of a cut polls an empty log').toEqual({ code: 0, out: 'survived:[]' });
    const noise = sh(`x="$(quick_tunnel_url '${log('INF Requesting new quick Tunnel on trycloudflare.com...\n')}')"; echo "survived:[$x]"`);
    expect(noise).toEqual({ code: 0, out: 'survived:[]' });
  });

  it('a successful log yields its quick-tunnel URL', () => {
    expect(sh(`quick_tunnel_url '${log('INF Requesting new quick Tunnel on trycloudflare.com...\n' + GOOD)}'`).out).toBe('https://solved-edges-alex-inn.trycloudflare.com');
  });

  it('cut-public.sh sources the helper and refuses before any scenario runs', () => {
    const s = readFileSync(join(ROOT, 'scripts', 'cut-public.sh'), 'utf8');
    expect(s).toMatch(/^\. scripts\/tunnel-name\.sh$/m);
    expect(s).toContain('TUNNEL_URL="$(quick_tunnel_url "$log")"');
    expect(s.indexOf('valid_tunnel_url "$TUNNEL_URL"')).toBeLessThan(s.indexOf('  ./scripts/cut-bundle.sh "$OUT"'));
    expect(s).not.toMatch(/grep -oE 'https:\/\/\[a-z0-9-\]\+\\\.trycloudflare\\\.com' "\$log" \| head -1/);
  });
});
