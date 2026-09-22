/**
 * The front door: major negotiation (versioning.md §1.3–§1.5), the
 * `OpenWOP-Version` response header on every response (§1.4), authentication,
 * a simple token bucket (429 rate_limited + Retry-After), the flat error
 * envelope (errors.md) and Layer-1 idempotency (idempotency.md).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIN_CLIENT_VERSION, SERVED_VERSIONS, V1_RETIRED, V1_VERSION, V2_VERSION } from './config.js';
import { HostError, err } from './errors.js';
import { authenticate, bearerOf } from './identity.js';
import { IDEMPOTENCY_KEY, unprojectBoundId } from './ids.js';
import { challengeFor } from './protected-resource.js';
import { scopeForRoute } from './scopes.js';
import type { Host, Subject } from './host.js';

export interface Reply {
  status: number;
  body?: unknown;
  raw?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
}

export const STREAMED: unique symbol = Symbol('streamed');

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly major: 1 | 2;
  readonly version: string;
  readonly subject: Subject | null;
  readonly host: Host;
  readonly baseUrl: string;
  /** Response headers the handler must emit itself when it streams. */
  readonly responseHeaders: Record<string, string>;
  text(): Promise<string>;
  json<T = Record<string, unknown>>(): Promise<T>;
  raw(): Promise<Buffer>;
  header(name: string): string | null;
}

export type Handler = (ctx: Ctx) => Promise<Reply | typeof STREAMED>;

export interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly auth: boolean;
  readonly handler: Handler;
  /** `v1` routes serve the 1.x contract; everything else is the 2.x surface. */
  readonly contract?: 1 | 2 | 'both';
  /** RFC 0200 §B.1 — the ONE scope this operation requires, or null where none is specified (`scopes.ts`). */
  readonly scope?: string | null;
}

/** The path parameters that carry a tenant-bound id (identity.md §5 table) — the only ones the `~` projection applies to; `nodeId` admits a literal `~`. */
const TENANT_BOUND_PARAMS: ReadonlySet<string> = new Set(['runId', 'webhookId']);

export function route(method: string, pattern: string, auth: boolean, handler: Handler, contract?: 1 | 2 | 'both'): Route {
  // A tenant-bound id (`<tenantId>/<opaque>`) may arrive with its slash raw or
  // percent-encoded; every other parameter is one path segment.
  const re = new RegExp(`^${pattern.replace(/\{(runId|webhookId)\}/g, '(?<$1>[^/]+(?:/[A-Za-z0-9._~-]{16,128})?)').replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
  // RFC 0200: the scope is resolved HERE, from the literal pattern, so a route and its
  // scope cannot drift — `scopeForRoute` throws at boot for an unlisted, non-exempt route.
  const scope = auth ? scopeForRoute(method, pattern) : null;
  return contract === undefined ? { method, pattern: re, auth, handler, scope } : { method, pattern: re, auth, handler, contract, scope };
}

function versionMajor(raw: string | null): { major: number | null; malformed: boolean } {
  if (raw === null || raw.trim() === '') return { major: null, malformed: false };
  const m = /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))?$/.exec(raw.trim());
  if (!m) return { major: null, malformed: true };
  return { major: Number(m[1]), malformed: false };
}

function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const ma = pa[0] ?? 0; const na = pa[1] ?? 0; const mb = pb[0] ?? 0; const nb = pb[1] ?? 0;
  return ma < mb || (ma === mb && na < nb);
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly perMinute: number) { this.tokens = perMinute; }
  take(): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return { ok: true, retryAfterSec: 0 }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - this.tokens) / this.perMinute * 60)) };
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly host: Host) {}

  add(...routes: Route[]): void {
    this.routes.push(...routes);
  }

  private bucketFor(key: string): TokenBucket {
    let b = this.buckets.get(key);
    if (!b) { b = new TokenBucket(this.host.config.rateLimitPerMinute); this.buckets.set(key, b); }
    return b;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isV1Path = path === '/v1' || path.startsWith('/v1/');
    const { major: requested, malformed } = versionMajor(req.headers['openwop-version'] as string | undefined ?? null);
    const preferredMajor = Number(this.host.config.preferredVersion.split('.')[0]);

    // The contract this request is served under — decided before anything else so
    // even a refusal names it (versioning.md §1.4).
    // Under retirement there is exactly one major, so every request is served
    // under it — including a `/v1/…` path, which then finds no route and falls
    // to the 404 below rather than being served a contract this host no longer
    // advertises. `OpenWOP-Version: 1` names a major not in protocolVersions[]
    // and is refused 406 further down (§1.3 row 2), not quietly honoured.
    let major: 1 | 2;
    if (V1_RETIRED) major = 2;
    else if (isV1Path) major = 1;
    else if (requested === 2) major = 2;
    else if (requested === 1) major = 1;
    else if (requested === null && !malformed) major = path === '/.well-known/openwop' ? (preferredMajor === 2 ? 2 : 1) : 2;
    else major = 2;
    const version = major === 1 ? V1_VERSION : V2_VERSION;
    const responseHeaders: Record<string, string> = { 'OpenWOP-Version': version };

    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    const hostHeader = (req.headers['host'] as string | undefined) ?? `${this.host.config.host}:${this.host.config.port}`;
    const baseUrl = `${proto}://${hostHeader}`;
    // RFC 0200 §B — the refusal the caller is ALREADY getting is what carries the
    // challenge. `scopeRequired` is set only where a scope would cure the 403.
    let scopeRequired: string | null = null;
    const send = (reply: Reply): void => {
      const headers: Record<string, string> = { ...responseHeaders, ...(reply.headers ?? {}) };
      if ((reply.status === 401 || reply.status === 403) && headers['WWW-Authenticate'] === undefined) {
        const code = typeof (reply.body as { error?: unknown } | undefined)?.error === 'string' ? String((reply.body as { error: string }).error) : '';
        const challenge = challengeFor(this.host, baseUrl, reply.status, code, scopeRequired, bearerOf(req) !== null);
        if (challenge !== null) headers['WWW-Authenticate'] = challenge;
      }
      if (reply.raw !== undefined) {
        headers['Content-Type'] = reply.contentType ?? 'application/octet-stream';
        res.writeHead(reply.status, headers);
        res.end(reply.raw);
        return;
      }
      if (reply.body === undefined) { res.writeHead(reply.status, headers); res.end(); return; }
      const text = JSON.stringify(reply.body);
      headers['Content-Type'] = 'application/json; charset=utf-8';
      res.writeHead(reply.status, headers);
      res.end(text);
    };
    const fail = (e: unknown): void => {
      if (e instanceof HostError) {
        send({ status: e.status, body: e.body(), headers: e.headers });
        return;
      }
      process.stderr.write(`[internal] ${String((e as Error)?.stack ?? e)}\n`);
      send({ status: 500, body: { error: 'internal_error', message: 'the host failed to serve the request' } });
    };

    try {
      if (malformed) throw err('validation_error', 'OpenWOP-Version MUST be <major> or <major>.<minor>', { header: 'OpenWOP-Version' });
      if (!V1_RETIRED && isV1Path && requested !== null && requested !== 1) {
        throw err('protocol_version_mismatch', 'a /v1/ path key MUST NOT carry OpenWOP-Version with a value other than 1', { requested, path: '/v1/' });
      }
      // §1.3 row 2: a header naming a major not in protocolVersions[] MUST be
      // 406 with the list echoed. Reading the ADVERTISED set rather than the
      // built-in constant is what makes `OpenWOP-Version: 1` a refusal under
      // retirement instead of a silently honoured downgrade — the single
      // behaviour a dual-stack host can never exercise.
      const servedMajors = new Set(SERVED_VERSIONS.map((v) => Number(v.split('.')[0])));
      if ((!isV1Path || V1_RETIRED) && requested !== null && !servedMajors.has(requested)) {
        throw err('protocol_version_unsupported', `major ${requested} is not served by this host`, { protocolVersions: [...SERVED_VERSIONS] });
      }
      const client = req.headers['openwop-client-version'];
      if (typeof client === 'string' && client.trim() !== '') {
        const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/.exec(client.trim());
        const announced = m ? `${m[1]}.${m[2]}` : '0.0';
        if (versionLt(announced, MIN_CLIENT_VERSION)) throw err('client_version_unsupported', `the client announced ${client.trim()}, below minClientVersion ${MIN_CLIENT_VERSION}`, { minClientVersion: MIN_CLIENT_VERSION });
      }
      const bucketKey = (req.headers['authorization'] as string | undefined) ?? req.socket.remoteAddress ?? 'anon';
      const taken = this.bucketFor(bucketKey).take();
      if (!taken.ok) throw err('rate_limited', 'too many requests', undefined, { 'Retry-After': String(taken.retryAfterSec) });

      const method = (req.method ?? 'GET').toUpperCase();
      let matched: Route | undefined;
      let params: Record<string, string> = {};
      let pathSeen = false;
      for (const r of this.routes) {
        const m = r.pattern.exec(path);
        if (!m) continue;
        pathSeen = true;
        if (r.method !== method) continue;
        if (r.contract !== 'both' && (r.contract ?? 2) !== major) continue;
        matched = r;
        // identity.md §5: a tenant-bound parameter is accepted projected (`~2F`) or
        // percent-encoded (`%2F`), decoded ONCE before the grammar is matched.
        params = Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, TENANT_BOUND_PARAMS.has(k) ? unprojectBoundId(decodeURIComponent(v ?? '')) : decodeURIComponent(v ?? '')]));
        break;
      }
      if (!matched) {
        if (!isV1Path && major === 1 && path !== '/.well-known/openwop') throw err('not_found', 'v1 operations keep their /v1/ path keys through the overlap; unversioned keys are the v2 surface');
        throw err('not_found', pathSeen ? `${method} is not served at ${path}` : `no operation at ${path}`);
      }

      let bodyBuf: Buffer | null = null;
      const raw = async (): Promise<Buffer> => {
        if (bodyBuf !== null) return bodyBuf;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          const chunk = c as Buffer;
          total += chunk.length;
          if (total > 4_194_304) throw err('validation_error', 'request body exceeds limits.maxRequestBodyBytes', { maxRequestBodyBytes: 4_194_304 });
          chunks.push(chunk);
        }
        bodyBuf = Buffer.concat(chunks);
        return bodyBuf;
      };
      const authed = matched.auth ? await authenticate(this.host, req) : null;
      // RFC 0200 §B.1 / auth.md §Scopes — the endpoint-level scope check, before the
      // handler runs and therefore before any resource is looked up: a caller that lacks
      // the scope learns nothing about whether the resource exists.
      if (authed !== null && matched.scope !== null && matched.scope !== undefined && !authed.scopes.has(matched.scope)) {
        scopeRequired = matched.scope;
        throw err('forbidden', `the credential does not hold ${matched.scope}`, { scopeRequired: matched.scope });
      }
      const ctx: Ctx = {
        req, res, url, params, major, version, host: this.host, responseHeaders,
        subject: authed?.subject ?? null,
        baseUrl,
        raw,
        text: async () => (await raw()).toString('utf8'),
        json: async <T,>() => {
          const text = (await raw()).toString('utf8');
          if (text.trim() === '') return {} as T;
          try { return JSON.parse(text) as T; } catch { throw err('validation_error', 'the request body is not JSON'); }
        },
        header: (name) => { const v = req.headers[name.toLowerCase()]; return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null; },
      };
      const reply = await matched.handler(ctx);
      if (reply === STREAMED) return;
      send(reply);
    } catch (e) {
      fail(e);
    }
  }
}

/**
 * idempotency.md §Layer 1 — keyed on (authenticatedTenantId, canonicalEndpointId,
 * callerIdempotencyKey); final outcomes are cached and replayed with
 * `OpenWOP-Idempotent-Replay: true`; a different digest is 409
 * idempotency_key_mismatch; 400/401/403/429/5xx are never cached.
 */
export async function withIdempotency(ctx: Ctx, endpoint: string, digestInput: string, fn: () => Promise<Reply>): Promise<Reply> {
  const key = ctx.header('idempotency-key');
  if (key === null) return fn();
  if (!IDEMPOTENCY_KEY.test(key)) throw err('idempotency_key_invalid', 'Idempotency-Key MUST match ^[A-Za-z0-9._~-]{22,128}$');
  if (ctx.subject === null) return fn();
  const tenant = ctx.subject.tenant;
  const store = ctx.host.store;
  const digest = createHash('sha256').update(digestInput).digest('hex');
  const existing = store.getIdempotency(tenant, endpoint, key);
  if (existing !== undefined) {
    if (existing.digest !== digest) throw err('idempotency_key_mismatch', 'a different request digest was presented under the same Idempotency-Key');
    if (existing.status === null) throw err('idempotency_in_flight', 'a request under this Idempotency-Key is still in flight', undefined, { 'Retry-After': '1' });
    return { status: existing.status, body: existing.body === null ? undefined : JSON.parse(existing.body), headers: { ...(JSON.parse(existing.headers_json ?? '{}') as Record<string, string>), 'OpenWOP-Idempotent-Replay': 'true' } };
  }
  if (!store.claimIdempotency(tenant, endpoint, key, digest)) throw err('idempotency_in_flight', 'a concurrent request under this Idempotency-Key is in flight', undefined, { 'Retry-After': '1' });
  let reply: Reply;
  try {
    reply = await fn();
  } catch (e) {
    // RFC 0201 §D.16: a refused endpoint verification is a FINAL outcome (retriable: false) — a
    // same-key duplicate replays the cached 400 and never sends a second verification request.
    if (e instanceof HostError && ((e.status < 500 && e.status !== 429 && e.status !== 400 && e.status !== 401 && e.status !== 403) || e.code === 'webhook_endpoint_unverified')) {
      store.completeIdempotency(tenant, endpoint, key, e.status, e.headers, JSON.stringify(e.body()));
    } else {
      store.releaseIdempotency(tenant, endpoint, key);
    }
    throw e;
  }
  if (reply.status < 500 && reply.status !== 429 && reply.raw === undefined) {
    store.completeIdempotency(tenant, endpoint, key, reply.status, reply.headers ?? {}, JSON.stringify(reply.body ?? null));
  } else {
    store.releaseIdempotency(tenant, endpoint, key);
  }
  return reply;
}
