import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '..');

test('editor/entry.mjs bundles for browser without jsdom errors', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(editorDir, 'entry.mjs')],
    format: 'esm',
    bundle: true,
    platform: 'browser',
    external: ['https://unpkg.com/*'],
    write: false,
  });
  assert(result.outputFiles, 'Bundle output should be present');
  assert(result.outputFiles.length > 0, 'Bundle should produce output files');
});

test('editor/lib/change.mjs bundles for browser without jsdom errors', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(editorDir, 'lib', 'change.mjs')],
    format: 'esm',
    bundle: true,
    platform: 'browser',
    external: ['https://unpkg.com/*'],
    write: false,
  });
  assert(result.outputFiles, 'Bundle output should be present');
  assert(result.outputFiles.length > 0, 'Bundle should produce output files');
});
