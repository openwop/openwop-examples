#!/usr/bin/env node
/**
 * The restart supervisor RFC 0158 §E names as an OPERATOR PRECONDITION of the
 * kill rows: "a black-box suite cannot itself restart a killed single instance —
 * something must". This is that something, and it is deliberately outside the
 * host: a process cannot be the evidence of its own restart.
 *
 *   node scripts/supervisor.mjs [--restart-ms 1000] [--max-restarts 20] [--log <file>]
 *
 * It spawns the host, and when the child dies by SIGNAL it waits `--restart-ms`
 * (the `supervisor.restartDelay` term of the bound the host declares — the two
 * are the same number, passed to the child as OPENWOP_SUPERVISOR_RESTART_MS) and
 * starts it again on the SAME database file. A clean exit is not restarted.
 *
 * IT COUNTS THE DEATHS ITSELF, and writes each to its log as one JSON line. A
 * cut script reads that log and refuses a bundle whose kill rows passed with
 * fewer SIGKILLs than kill rows: a green row is otherwise indistinguishable
 * from a seam that answered 202 and never died. The suite cannot see a death;
 * the supervisor cannot miss one.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback; };
const restartMs = Number(arg('--restart-ms', process.env.OPENWOP_SUPERVISOR_RESTART_MS ?? '1000'));
const maxRestarts = Number(arg('--max-restarts', '20'));
const logFile = arg('--log', null);

let deaths = 0; let stopping = false; let child = null;
const record = (entry) => { const line = JSON.stringify({ at: new Date().toISOString(), ...entry }); process.stdout.write(`[supervisor] ${line}\n`); if (logFile) appendFileSync(logFile, line + '\n'); };

function start() {
  // `node --import tsx`, NOT the `tsx` CLI: the CLI is a wrapper that runs the
  // host as ITS child, so a SIGKILL on the host surfaces here as a plain
  // `exit 137` with `signal === null` — a death that reads as a clean exit and
  // is never restarted (measured on the first run of this script). With the
  // loader flag the host IS this supervisor's child and its signal is reported.
  child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'server.ts')], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, OPENWOP_SUPERVISOR_RESTART_MS: String(restartMs) },
  });
  record({ event: 'started', pid: child.pid, incarnation: deaths + 1 });
  child.on('exit', (code, signal) => {
    if (stopping) { record({ event: 'stopped', code, signal }); process.exit(0); }
    // A shell or wrapper reports a signal death as 128+n; count that as a death too.
    const bySignal = signal ?? (typeof code === 'number' && code > 128 ? `exit-code-${code}` : null);
    if (bySignal === null) { record({ event: 'exited-cleanly', code }); process.exit(code ?? 0); }
    deaths++;
    record({ event: 'died', signal: bySignal, deaths, restartInMs: restartMs });
    if (deaths > maxRestarts) { record({ event: 'gave-up', deaths }); process.exit(1); }
    setTimeout(start, restartMs);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); else process.exit(0); });
start();
