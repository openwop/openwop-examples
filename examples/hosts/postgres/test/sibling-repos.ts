/**
 * Resolve files this host's tests borrow from the repos it split out of.
 *
 * Several tests reach into the spec repo (openwop/openwop: the conformance
 * suite's fake MCP server and synthetic OIDC issuer, the out-of-band audit
 * verifier) and the registry repo (openwop/openwop-registry: the canonical
 * signed example pack). Before the split they were all one tree, reached with
 * `../../../../`; after it, that path points into openwop-examples and the
 * imports fail with ERR_MODULE_NOT_FOUND. The host resolves its fixture catalog
 * with the same probe order used here: explicit env, the pre-split layout, then
 * a sibling checkout.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function resolveIn(envName: string, sibling: string, segments: readonly string[]): string {
  const env = process.env[envName];
  const candidates = [
    ...(env ? [join(env, ...segments)] : []),
    join(REPO_ROOT, ...segments),
    join(REPO_ROOT, '..', sibling, ...segments),
  ];
  // A `.js` specifier of a TypeScript source (tsx maps it) exists on disk as `.ts`.
  const hit = candidates.find((p) => existsSync(p) || (p.endsWith('.js') && existsSync(p.replace(/\.js$/, '.ts'))));
  if (!hit) {
    throw new Error(`${segments.join('/')} not found; set ${envName} to a ${sibling} checkout (tried ${candidates.join(', ')})`);
  }
  return hit;
}

/** A path inside the spec repo (OPENWOP_SPEC_REPO, else a sibling `openwop` checkout). */
export const specRepoPath = (...segments: string[]): string => resolveIn('OPENWOP_SPEC_REPO', 'openwop', segments);
/** A path inside the registry repo (OPENWOP_REGISTRY_REPO, else a sibling `openwop-registry` checkout). */
export const registryRepoPath = (...segments: string[]): string => resolveIn('OPENWOP_REGISTRY_REPO', 'openwop-registry', segments);
/** Import a module from the spec repo. */
export const importFromSpecRepo = (...segments: string[]): Promise<Record<string, unknown>> =>
  import(pathToFileURL(specRepoPath(...segments)).href) as Promise<Record<string, unknown>>;
