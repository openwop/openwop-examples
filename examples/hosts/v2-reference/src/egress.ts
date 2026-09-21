/**
 * webhooks.md §Egress — the one outbound HTTP path the host has (webhook
 * delivery and the `http.fetch` node seam share it). At registration: https
 * only, no RFC 1918 / loopback / link-local / ULA / metadata / localhost. At
 * delivery: re-resolve, validate every address, connect to the validated
 * address without re-resolving, refuse redirects (a 3xx is a failure).
 */
import { promises as dns } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { err } from './errors.js';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', '169.254.169.254', 'fd00:ec2::254']);

/**
 * Is this ADDRESS one a webhook or an outbound fetch may reach?
 *
 * Judged on the address, never on its spelling. The first version matched
 * IPv4-mapped IPv6 only in its dotted form (`::ffff:127.0.0.1`), but the
 * WHATWG URL parser always emits the hex form (`[::ffff:127.0.0.1]` becomes
 * hostname `::ffff:7f00:1`), so loopback, the metadata address and RFC 1918
 * all passed at registration AND at delivery - measured: two POSTs reached a
 * real loopback listener. Found in a sibling host's copy of the same pattern.
 *
 * So: parse to bytes; an IPv6 address that EMBEDS an IPv4 address in a
 * standard translation form is judged by that IPv4 address (the Go
 * `netip.Addr.Unmap` / ipaddr.js `process()` / Python `ipv4_mapped` rule);
 * then allow only what the IANA IPv4 / IPv6 Special-Purpose Address
 * Registries mark globally reachable. An allow-by-reachability rule refuses
 * what a hand-kept deny list forgot. NAT64 and 6to4 are NOT denied wholesale:
 * an IPv6-only host behind DNS64 is legitimately handed `64:ff9b::<public v4>`
 * for a public destination; `64:ff9b::7f00:1` is loopback and refused.
 */
type Cidr = readonly [readonly number[], number];
const V4_NOT_GLOBAL: readonly Cidr[] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];
const V6_NOT_GLOBAL: readonly Cidr[] = [
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64],                  // 100::/64 discard-only
  [[0x20, 0x01, 0x00, 0x00], 23],                          // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32)
  [[0x20, 0x01, 0x0d, 0xb8], 32],                          // 2001:db8::/32 documentation
  [[0x3f, 0xff, 0x00, 0x00], 20],                          // 3fff::/20 documentation
  [[0x5f, 0x00], 16],                                      // 5f00::/16 SRv6 SIDs
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48],              // 64:ff9b:1::/48 local-use NAT64
  [[0xfc], 7],                                             // fc00::/7 ULA
  [[0xfe, 0x80], 10],                                      // fe80::/10 link-local
  [[0xfe, 0xc0], 10],                                      // fec0::/10 deprecated site-local
  [[0xff], 8],                                             // ff00::/8 multicast
];

function inCidr(bytes: readonly number[], [net, bits]: Cidr): boolean {
  for (let i = 0; i * 8 < bits; i++) {
    const take = Math.min(8, bits - i * 8);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((net[i] ?? 0) & mask)) return false;
  }
  return true;
}

function v4Bytes(ip: string): number[] | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return b.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? b : null;
}

/** 16 bytes, or null. Handles `::` compression and a dotted IPv4 tail; drops a zone id. */
export function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  let tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const v4 = v4Bytes(dotted[1] as string); if (!v4) return null; tail = v4; s = s.slice(0, -(dotted[1] as string).length) + '0:0'; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (h: string): string[] => (h === '' ? [] : h.split(':'));
  const head = words(halves[0] as string); const rest = halves.length === 2 ? words(halves[1] as string) : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const w of all) { if (!/^[0-9a-f]{1,4}$/.test(w)) return null; const n = parseInt(w, 16); out.push(n >> 8, n & 0xff); }
  if (tail.length) out.splice(12, 4, ...tail);
  return out.length === 16 ? out : null;
}

/** The IPv4 address an IPv6 address embeds in a standard translation form, else null. */
export function embeddedV4(b: readonly number[]): number[] | null {
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12, 16);                   // ::ffff:0:0/96 mapped
  if (zero(0, 12) && !(zero(12, 15) && (b[15] === 0 || b[15] === 1))) return b.slice(12, 16);     // ::/96 IPv4-compatible (not :: or ::1)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12, 16); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);                                        // 2002::/16 6to4
  return null;
}

function v4Global(b: readonly number[]): boolean {
  if (b.every((x) => x === 255)) return false;
  return !V4_NOT_GLOBAL.some((c) => inCidr(b, c));
}

function v6Global(b: readonly number[]): boolean {
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return false; // :: and ::1
  const v4 = embeddedV4(b);
  if (v4) return v4Global(v4);
  return !V6_NOT_GLOBAL.some((c) => inCidr(b, c));
}

export function addressDenied(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) { const b = v4Bytes(ip); return b === null || !v4Global(b); }
  if (family === 6) { const b = v6Bytes(ip); return b === null || !v6Global(b); }
  return true;
}

export function hostnameDenied(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (METADATA_HOSTS.has(h)) return true;
  if (isIP(h.replace(/^\[|\]$/g, ''))) return addressDenied(h.replace(/^\[|\]$/g, ''));
  return false;
}

/** Registration-time guard: throws 400 validation_error naming the reason. */
export function validateEgressUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw err('webhook_url_rejected', 'url MUST be an absolute https:// URL', { url: raw }); }
  if (allowPrivate) return url;
  if (url.protocol !== 'https:') throw err('webhook_url_rejected', 'url MUST be https:// (webhooks.md §Egress)', { url: raw });
  if (hostnameDenied(url.hostname)) throw err('webhook_url_rejected', 'url names a loopback, private, link-local or metadata host (webhooks.md §Egress)', { url: raw });
  return url;
}

export interface EgressResult { status: number; body: string; error?: string }

/** Delivery-time guarded request: resolve, validate every address, pin the connection, no redirects. */
export async function guardedRequest(url: URL, init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number; allowPrivate: boolean }): Promise<EgressResult> {
  let address: string;
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    address = url.hostname.replace(/^\[|\]$/g, '');
  } else {
    const records = await dns.lookup(url.hostname, { all: true });
    if (records.length === 0) return { status: 0, body: '', error: 'dns: no address' };
    if (!init.allowPrivate) {
      const denied = records.find((r) => addressDenied(r.address));
      if (denied) return { status: 0, body: '', error: `egress denied: ${url.hostname} resolves to ${denied.address}` };
    }
    address = (records[0] as { address: string }).address;
  }
  if (!init.allowPrivate && addressDenied(address)) return { status: 0, body: '', error: `egress denied: ${address}` };
  const family = isIP(address);
  const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<EgressResult>((resolve) => {
    const req = fn(url, {
      method: init.method,
      headers: { ...init.headers, Host: url.host },
      timeout: init.timeoutMs,
      // connect to the validated address without re-resolving
      // Node calls a custom `lookup` in TWO shapes and this answered only one.
      // With `all: true` - what net.connect asks for on every current Node -
      // the callback takes an ARRAY of { address, family }; answering
      // (null, address, family) made Node read `addresses[0].address` off a
      // string and fail every connect with "Invalid IP address: undefined".
      // An IP-literal URL never reaches `lookup`, so loopback fixtures always
      // worked and NOTHING ELSE EVER DID: this host could not deliver a webhook,
      // fire an http effect, or reach an IdP at any real hostname. It went
      // unseen because every cut ran against 127.0.0.1 under a relaxed guard -
      // found by the first cut that relaxed nothing.
      lookup: (_h: string, o: { all?: boolean } | undefined, cb: (e: Error | null, a: string | Array<{ address: string; family: number }>, f?: number) => void) =>
        (o?.all === true ? cb(null, [{ address, family }]) : cb(null, address, family)),
      servername: url.protocol === 'https:' ? url.hostname : undefined,
    } as never, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        // A 3xx is a delivery failure; redirects are never followed.
        resolve(status >= 300 && status < 400 ? { status, body, error: 'redirect refused' } : { status, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e: Error) => resolve({ status: 0, body: '', error: e.message }));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
