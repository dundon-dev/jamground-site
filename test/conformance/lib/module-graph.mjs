/* Recursive relative-import walker: no module graph from
 * astro.config.mjs or src/pages/** may resolve into editor/. Bare specifiers — npm packages,
 * and virtual modules such as 'astro:content' — are left unresolved on purpose: neither can
 * ever resolve to a file inside this repo's editor/ directory, so following them would only
 * spend the walk on node_modules for no gain. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const IMPORT_RE =
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const CANDIDATE_SUFFIXES = ['', '.ts', '.mjs', '.js', '.astro', '/index.ts', '/index.mjs', '/index.js'];

function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function extractSpecifiers(source) {
  const specs = [];
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source))) specs.push(match[1] ?? match[2] ?? match[3]);
  return specs;
}

/** Walks the relative-import graph reachable from `entryFiles` and returns the set of every
 *  resolved absolute file path visited, entries included. */
export function collectModuleGraph(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith('.')) continue; // bare specifier: npm package or virtual module
      const resolved = resolveRelative(file, spec);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}
