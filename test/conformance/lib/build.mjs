/* Shared build helper for the contract conformance suite. Every assertion that needs
 * a real dist/ builds through Astro's programmatic API (`import { build } from 'astro'`)
 * into an isolated, freshly created temp directory rather than this project's own dist/, so
 * that conformance tests — node --test runs separate test *files* as separate, concurrent OS
 * processes by default, proven by a planted process.pid check — never race each other over
 * shared build state. Two proven collisions, not one, and neither is `outDir` alone:
 *
 * 1. Astro's content-layer cache (`cacheDir`, default `node_modules/.astro/data-store.json`)
 *    and its generated-types directory (`.astro/` at `root` — `dotAstroDir`, not configurable
 *    at all) are both keyed off `root`. Two conformance test files building against the
 *    project's own root at once intermittently threw `TypeError: Cannot read properties of
 *    undefined (reading 'setInternals')` deep inside Astro's prerenderer. Fixed by giving
 *    every build its own `root` (a symlink farm, not a copy — the point is isolating the
 *    cache paths, not the sources) and its own `cacheDir`.
 * 2. Astro's intermediate server/prerender output (`astro/dist/core/build/common.js`,
 *    `getOutDirWithinCwd`) is written under `outDir` ONLY if `outDir` is a subpath of
 *    `process.cwd()` — otherwise it silently falls back to `<process.cwd()>/.astro/.prerender/`,
 *    a path keyed off the real OS working directory, not off any config value this file
 *    controls. Every conformance process shares that same cwd, so an `outDir` under the
 *    system temp directory reproduced the identical `setInternals` failure, and once that was
 *    fixed a *different* one followed — `ERR_MODULE_NOT_FOUND` for a prerender chunk — both
 *    are the same fallback collision. Fixed by creating `outDir` under `process.cwd()` (inside
 *    the gitignored `node_modules/`, which is guaranteed to exist) so the fallback path is
 *    never taken.
 * 3. Vite's own dependency-optimizer cache (`node_modules/.vite/deps`) is written into
 *    whatever `node_modules/` sits under `root` — symlinking `root/node_modules` itself
 *    (point 1's fix, as first written) makes that the SAME shared directory again, and
 *    concurrent builds collided on `deps_temp_*` renames (`ENOENT` / `ENOTEMPTY`). Fixed by
 *    making `root/node_modules` a real, per-build directory and symlinking each PACKAGE
 *    inside it individually — every dependency still resolves to the one real install (same
 *    pinned versions, nothing reinstalled), but `.vite/`, `.astro/` and `.bin/` under it are
 *    now per-build. Dotfile entries in the real node_modules (`.vite`, `.astro`, `.bin`,
 *    `.package-lock.json`) are skipped when populating the per-build one for the same reason.
 *
 * Nothing here ever touches the project's own dist/, .astro/ or node_modules/.astro/. */
import { build } from 'astro';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Symlinked, not copied: builds must see this checkout's actual sources.
// 'design' is the first source directory outside src/: BaseLayout.astro imports
// design/*.css, so an isolated root without it cannot resolve them.
// 'jamground.config.mjs' is here for the same reason and one sharper one: astro.config.mjs
// imports it for `site`, and without it in this list every isolated build would resolve the
// import through the astro.config.mjs SYMLINK's realpath back into the project root — it
// would work, by accident, and keep working right up until something changed where the
// symlink pointed. An isolated root has to carry every file the build reads.
const LINKED_ENTRIES = ['src', 'design', 'public', 'package.json', 'astro.config.mjs', 'jamground.config.mjs'];

/** Populates `<intoDir>/node_modules` as a REAL directory (not a symlink — point 3 above)
 *  containing one symlink per installed package, resolved back to the one real install so
 *  every dependency stays at its pinned version with nothing reinstalled. Exported so any
 *  checkout being built (the isolated root below, or the clean-checkout clone assertion 4
 *  makes) gets the same isolation for Vite's dependency-optimizer cache. */
export function linkNodeModulesInto(intoDir) {
  const realNodeModules = join(PROJECT_ROOT, 'node_modules');
  const isolatedNodeModules = join(intoDir, 'node_modules');
  mkdirSync(isolatedNodeModules);
  for (const name of readdirSync(realNodeModules)) {
    if (name.startsWith('.')) continue; // .vite, .astro, .bin, .package-lock.json: never shared
    symlinkSync(join(realNodeModules, name), join(isolatedNodeModules, name));
  }
}

function createIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jamground-conformance-root-'));
  for (const entry of LINKED_ENTRIES) symlinkSync(join(PROJECT_ROOT, entry), join(root, entry));
  linkNodeModulesInto(root);
  return root;
}

// Under process.cwd() on purpose (see point 2 above) and inside node_modules/ so it is
// already gitignored and never mistaken for a deliverable — created fresh per process,
// removed the same way, and never shared with the project's own dist/.
function scratchBase() {
  const base = join(process.cwd(), 'node_modules', '.jamground-conformance');
  mkdirSync(base, { recursive: true });
  return base;
}

/** Builds the site into a fresh temp directory and returns its absolute path. `options` is
 *  forwarded to Astro's inline config — `root` is used to point at a different checkout
 *  entirely (assertion 4, SC-8 reproducibility) without disturbing the caller's own working
 *  tree; when the caller does not supply one, an isolated root is created and torn down here
 *  so every other caller gets the isolation without asking for it explicitly. */
export async function buildToTempDir(options = {}) {
  const outDir = mkdtempSync(join(scratchBase(), 'out-'));
  const cacheDir = options.cacheDir ?? mkdtempSync(join(tmpdir(), 'jamground-conformance-cache-'));
  const ownRoot = options.root === undefined;
  const root = options.root ?? createIsolatedRoot();
  try {
    await build({ logLevel: 'silent', ...options, root, outDir, cacheDir });
  } finally {
    if (ownRoot) rmSync(root, { recursive: true, force: true });
    if (options.cacheDir === undefined) rmSync(cacheDir, { recursive: true, force: true });
  }
  return outDir;
}

/** Every file under `dir`, as a path relative to `dir` with forward slashes. */
export function listFiles(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(d, entry.name), rel);
      else out.push(rel);
    }
  })(dir, '');
  return out;
}

/** path -> sha256 hex digest, for every file under `dir`. */
export function hashTree(dir) {
  const out = new Map();
  for (const rel of listFiles(dir)) {
    out.set(rel, createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex'));
  }
  return out;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
