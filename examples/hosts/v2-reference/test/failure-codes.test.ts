/**
 * errors.md §The registry (openwop#1698, gap openwop.gap.0171.8): every code the
 * host can put on `run.failed`, `node.failed` or the snapshot `error` is either a
 * registered code (spec/v2/errors.json) or a vendor code under the registered
 * `example` org. The suite only drives some failure paths, so this scans every
 * place the executor mints one: a NodeFailure, a ctx.mcp rejection (which fails
 * the node with its own code), and the literal error objects in executor.ts.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (f: string): string => readFileSync(join(SRC, f), 'utf8');
const req = createRequire(import.meta.url);
const errorsJson = JSON.parse(readFileSync(join(dirname(req.resolve('@openwop/spec-artifacts/package.json')), 'spec', 'v2', 'errors.json'), 'utf8')) as { vendorCodePattern: string; rows: Array<{ code: string }> };
const REGISTERED = new Set(errorsJson.rows.map((r) => r.code));
const VENDOR = new RegExp(errorsJson.vendorCodePattern);
const literals = (expr: string): string[] => [...expr.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

function emittedCodes(): Map<string, string> {
  const codes = new Map<string, string>(); // code -> where
  const executor = read('executor.ts');
  // Every NodeFailure's first argument: literals only, or the ctx.mcp rejection's own code.
  for (const m of executor.matchAll(/new NodeFailure\(([^,]+),/g)) {
    const expr = (m[1] as string).trim();
    if (expr === 'e.code') continue; // McpClientError — its codes are scanned below
    const found = literals(expr);
    expect(found.length, `NodeFailure code must be a literal (or e.code of an McpClientError): ${expr}`).toBeGreaterThan(0);
    for (const c of found) codes.set(c, `executor.ts NodeFailure(${expr})`);
  }
  // Literal error objects written straight onto run.failed / node.failed / error_json.
  for (const m of executor.matchAll(/\{ code: '([^']+)'/g)) codes.set(m[1] as string, 'executor.ts error object');
  // ctx.mcp rejections become node.failed codes (executor.ts: NodeFailure(e.code, …)).
  const mcp = read('mcp-client.ts');
  const union = /constructor\(readonly code: ([^,]+),/.exec(mcp);
  expect(union, 'McpClientError declares its code union').not.toBeNull();
  for (const c of literals(union?.[1] ?? '')) codes.set(c, 'mcp-client.ts McpClientError');
  for (const m of mcp.matchAll(/new McpClientError\('([^']+)'/g)) codes.set(m[1] as string, 'mcp-client.ts new McpClientError');
  // The sandbox's own catalogue: the codes the §8 seam answers with (sandbox.ts, child.cjs).
  const sandbox = read('sandbox.ts') + read(join('sandbox', 'child.cjs'));
  for (const m of sandbox.matchAll(/(?:code: |SANDBOX_INVOCATION_ERROR = |new SandboxError\()'([^']+)'/g)) codes.set(m[1] as string, 'sandbox');
  return codes;
}

describe('every failure code the host emits is registered or an example.* vendor code', () => {
  it('the scan finds the known emit sites', () => {
    const codes = emittedCodes();
    for (const c of ['approval_rejected', 'capability_not_provided', 'example.conformance_failure', 'example.http_fetch_failed', 'mcp_error', 'example.mcp_unreachable', 'internal_error', 'node_config_invalid', 'sandbox_invocation_error', 'sandbox_timeout', 'sandbox_memory_exceeded']) expect(codes.has(c), c).toBe(true);
  });
  it('none is unregistered and non-vendor', () => {
    const bad = [...emittedCodes()].filter(([c]) => !REGISTERED.has(c) && !(VENDOR.test(c) && c.startsWith('example.')));
    expect(bad, `unregistered, non-vendor codes: ${bad.map(([c, w]) => `${c} (${w})`).join('; ')}`).toEqual([]);
  });
});
