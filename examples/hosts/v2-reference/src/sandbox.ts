/**
 * security-defaults.md §Sandbox isolation / RFC 0173 §B — the `sandbox` family
 * and the §8 seam (host-sample-test-seams.md) that lets the suite drive the
 * eight `node-pack-sandbox-*` invariants without a real misbehaving pack.
 *
 * isolationModel `process`: every invocation is a fresh child process started
 * with Node's permission model (`--permission` — no filesystem, no
 * child_process, no workers, no addons), an EMPTY environment, a V8 heap cap
 * and a wall-clock kill. The synthetic packs below are real code that really
 * tries to escape; the refusal the child OBSERVES is what becomes the
 * SandboxError. Nothing here maps a typeId to an answer.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from './errors.js';
import type { Host } from './host.js';

export const SANDBOX_FACET = {
  isolationModel: 'process',
  allowedHostCalls: ['fetch'],
  memoryLimitBytes: 48 * 1024 * 1024,
  wallClockLimitMs: 2000,
} as const;

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'sandbox', 'child.cjs');

/** The synthetic misbehaving-pack registry (host-sample-test-seams.md §8). Bodies run as `async (args, host, require) => { … }`. */
const PACKS: Readonly<Record<string, string>> = {
  'misbehave.fs-escape-read': "return require('node:fs').readFileSync('/etc/hostname', 'utf8');",
  'misbehave.fs-escape-write': "require('node:fs').writeFileSync('/tmp/openwop-sandbox-escape', 'x'); return true;",
  'misbehave.env-leak': 'return Object.keys(process.env);',
  'misbehave.network-escape': "return await fetch('http://127.0.0.1:1/');",
  'misbehave.process-escape': "return require('node:child_process').execSync('id').toString();",
  'misbehave.timeout': 'for (;;) {}',
  'misbehave.memory-bomb': 'const a = []; for (;;) a.push(new Array(1_000_000).fill(1));',
  'misbehave.cross-pack-mutate': 'globalThis.__shared = (globalThis.__shared ?? 0) + 1; return { shared: globalThis.__shared };',
  'misbehave.capability-gate-violation': "return host.call('fetch', { url: 'https://example.invalid/' });",
  'well-behaved.echo': 'return { echoed: args.input };',
  'well-behaved.host-fetch': "return host.call('fetch', { url: 'https://example.invalid/' });",
};

export interface SandboxError { code: string; details: Record<string, unknown> & { message: string } }
export type SandboxReply = { result: unknown } | { error: SandboxError };

export function sandboxPackIds(): string[] { return Object.keys(PACKS); }

export async function invokeSandboxed(host: Host, typeId: string, args: Record<string, unknown>, allowedHostCalls: string[]): Promise<SandboxReply> {
  const source = PACKS[typeId];
  if (source === undefined) throw err('validation_error', `unknown synthetic typeId ${typeId} (host-sample-test-seams.md §8 lists them)`, { typeId });
  for (const c of allowedHostCalls) if (!(SANDBOX_FACET.allowedHostCalls as readonly string[]).includes(c)) throw err('validation_error', `allowedHostCalls names ${c}, which sandbox.allowedHostCalls does not offer`, { call: c });
  const heapMb = Math.max(16, Math.floor(host.config.sandboxMemoryLimitBytes / (1024 * 1024)));
  // `--allow-fs-read=<CHILD>` grants the child its OWN entry file and nothing
  // else. Node >= 24 grants the entry point implicitly; 22.13 and 23.6 do not,
  // and there every invocation died reading `child.cjs` before pack code ran —
  // all nine RFC 0173 isolation rows answered `sandbox_invocation_error` on a
  // runtime this package's `engines` admits. The grant is not a widening: the
  // file is this sandbox's own non-secret source, and a read of anything else
  // is still refused with ERR_ACCESS_DENIED (witnessed: /etc/hosts).
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${CHILD}`, `--max-old-space-size=${heapMb}`, CHILD], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let errText = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { errText += c.toString(); });
  child.stdin.end(JSON.stringify({ source, args, allowedHostCalls }));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, host.config.sandboxWallClockLimitMs);
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  if (timedOut) return { error: { code: 'sandbox_timeout', details: { message: `pack code exceeded wallClockLimitMs ${host.config.sandboxWallClockLimitMs}` } } };
  if (out.trim() !== '') {
    const reply = JSON.parse(out) as { ok: boolean; result?: unknown; error?: SandboxError };
    return reply.ok ? { result: reply.result } : { error: reply.error as SandboxError };
  }
  // No reply: the child died. A V8 heap overflow is the memory cap firing.
  if (/heap out of memory|Allocation failed|OOM/i.test(errText) || exit.signal === 'SIGABRT') {
    return { error: { code: 'sandbox_memory_exceeded', details: { message: `pack code exceeded memoryLimitBytes ${host.config.sandboxMemoryLimitBytes}` } } };
  }
  return { error: { code: 'sandbox_invocation_error', details: { message: `sandbox child exited ${exit.code ?? exit.signal ?? 'unknown'} without a reply: ${errText.slice(0, 200)}` } } };
}
