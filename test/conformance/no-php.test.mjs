/* No .php file exists outside editor/, and no module graph from
 * astro.config.mjs or src/pages/** resolves into it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { strayPhpFiles, graphEntriesIntoEditor } from './lib/no-php.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('no .php file exists outside editor/', () => {
  const phpOutsideEditor = strayPhpFiles(projectRoot);
  assert.deepEqual(phpOutsideEditor, []);
});

test('no module graph from astro.config.mjs or src/pages/** resolves into editor/', () => {
  const intoEditor = graphEntriesIntoEditor(projectRoot);
  assert.deepEqual(intoEditor, []);
});
