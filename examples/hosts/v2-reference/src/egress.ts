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

function ipv4Denied(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const a = p[0] ?? 0; const b = p[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (p[2] ?? 0) === 0) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6Denied(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v === '0:0:0:0:0:0:0:1') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA fc00::/7
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local fe80::/10
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Denied(mapped[1] as string);
  return false;
}

export function addressDenied(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4Denied(ip);
  if (family === 6) return ipv6Denied(ip);
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
      lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, address, family),
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
