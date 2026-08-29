/* Functions to check that no .php file exists outside editor/, and no module
 * graph from astro.config.mjs or src/pages/** resolves into it. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectModuleGraph } from './module-graph.mjs';

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

/** Returns an array of .php files tracked by git that exist outside editor/ */
export function strayPhpFiles(root) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  return tracked.filter((f) => f.endsWith('.php') && !f.startsWith('editor/'));
}

/** Returns an array of files in the module graph from astro.config.mjs or src/pages/**
 *  that resolve into editor/ */
export function graphEntriesIntoEditor(root) {
  const pagesDir = join(root, 'src/pages');
  const entries = [join(root, 'astro.config.mjs'), ...collectFiles(pagesDir)];
  const graph = collectModuleGraph(entries);
  const editorPrefix = join(root, 'editor') + '/';
  return [...graph].filter((f) => f.startsWith(editorPrefix));
}
