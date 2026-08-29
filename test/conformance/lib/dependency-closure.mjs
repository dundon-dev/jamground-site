/* Production dependency closure: no @wordpress/*, @wp-playground/*
 * or /php/-scoped package may appear once devDependencies are excluded — dev-only is
 * permitted, since @wordpress/blocks is a test dependency and this check is about what runs
 * on a server we operate. Package metadata is read directly off disk rather than through
 * Node's module resolver, so a package's own "exports" map (which commonly hides
 * ./package.json from deep imports) cannot block the read. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function findPackageDir(name, fromDir) {
  let dir = fromDir;
  while (true) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const BANNED_PATTERNS = [
  (name) => name.startsWith('@wordpress/'),
  (name) => name.startsWith('@wp-playground/'),
  (name) => /(^|\/)php(\/|$)/.test(name),
];

export function isBanned(name) {
  return BANNED_PATTERNS.some((test) => test(name));
}

/** The production dependency closure of `rootDir`'s package.json: every package reachable
 *  from its "dependencies" field by following each dependency's OWN "dependencies" field —
 *  never "devDependencies", at any depth. That is what keeps a dev-only tool out of a
 *  closure meant to describe what actually runs in production. Returns a Map of package name
 *  to its resolved install directory, or null if the name could not be resolved at all. */
export function productionDependencyClosure(rootDir) {
  const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const visited = new Map();
  const queue = Object.keys(rootPkg.dependencies ?? {});
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    const dir = findPackageDir(name, rootDir);
    visited.set(name, dir);
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return visited;
}
