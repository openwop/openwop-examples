'use strict';
// The sandbox child (RFC 0173 §B; host-sample-test-seams.md §8). One process
// per invocation, started by ../sandbox.ts with `--permission` (no fs, no
// child_process, no workers) and an EMPTY environment. This file must stay
// self-contained: under `--permission` it may not read any other file.
//
// It reads one JSON request from stdin — { source, args, allowedHostCalls } —
// runs `source` as the body of an async function (args, host), and writes one
// JSON reply to stdout: { ok: true, result } | { ok: false, error }.
// Escapes are DETECTED, not tabulated: a filesystem read is refused by Node's
// permission model (ERR_ACCESS_DENIED), an env read hits the guard below, a
// raw network call hits the shim, and each refusal is mapped to the canonical
// SandboxError where it was observed.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

class SandboxError extends Error {
  constructor(code, details) { super(details.message); this.code = code; this.details = details; }
}
const escape = (kind, message) => new SandboxError('sandbox_escape_attempt', { escapeKind: kind, message });

// host-env-leak: the child starts with an empty environment; any read is still an attempt.
Object.defineProperty(process, 'env', { get() { throw escape('host-env-leak', 'pack code read process.env'); }, configurable: false });
// network-escape: ungated egress through any of the four doors is refused before a socket opens.
const noNet = () => { throw escape('network-escape', 'pack code attempted network egress outside allowedHostCalls'); };
globalThis.fetch = noNet;
http.request = noNet; http.get = noNet; https.request = noNet; https.get = noNet; net.connect = noNet; net.createConnection = noNet;
// host-process-escape: `--permission` already denies ChildProcess/WorkerThreads at the
// binding, but child_process copies process.env in JS BEFORE it reaches the binding, so
// the env guard above would fire first and misname the escape. Refuse at the module door
// so the observed refusal names what the pack actually tried; the permission model stays
// the backstop for any door this list does not name.
const noProc = () => { throw escape('host-process-escape', 'pack code attempted to spawn a process or worker'); };
const cp = require('node:child_process');
for (const k of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[k] = noProc;
const wt = require('node:worker_threads');
wt.Worker = noProc;

function mapAccessDenied(e) {
  if (e && e.code === 'ERR_ACCESS_DENIED') {
    const p = String(e.permission || '');
    if (p.startsWith('FileSystem')) return escape('host-fs-escape', `pack code attempted ${p} (${e.resource || 'unknown path'})`);
    if (p === 'ChildProcess' || p === 'WorkerThreads' || p === 'Inspector' || p === 'Addons' || p === 'WASI') return escape('host-process-escape', `pack code attempted ${p}`);
    return escape('host-process-escape', `pack code attempted ${p || 'a denied host capability'}`);
  }
  if (e instanceof SandboxError) return e;
  return new SandboxError('sandbox_invocation_error', { message: e && e.message ? String(e.message) : String(e) });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let reply;
  try {
    const req = JSON.parse(raw);
    const allowed = new Set(Array.isArray(req.allowedHostCalls) ? req.allowedHostCalls : []);
    // The host-call bridge: the only sanctioned way out. A call outside the
    // whitelist is sandbox_capability_denied with the capability named.
    const host = {
      call(name, params) {
        if (!allowed.has(name)) throw new SandboxError('sandbox_capability_denied', { requestedCapability: String(name), message: `host call ${name} is not in allowedHostCalls` });
        if (name === 'fetch') return { status: 200, body: 'fixture', url: params && params.url }; // a fixture answer: the reference host never egresses on a pack's behalf
        throw new SandboxError('sandbox_capability_denied', { requestedCapability: String(name), message: `host call ${name} is not implemented by this host` });
      },
    };
    const fn = new Function('args', 'host', 'require', `return (async () => { ${req.source}\n })();`);
    const result = await fn(req.args ?? {}, host, require);
    reply = { ok: true, result: result === undefined ? null : result };
  } catch (e) {
    const se = mapAccessDenied(e);
    reply = { ok: false, error: { code: se.code, details: se.details } };
  }
  process.stdout.write(JSON.stringify(reply));
});
