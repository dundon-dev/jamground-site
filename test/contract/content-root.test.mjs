// Contract test for content root binding.
// Asserts that src/content.config.ts imports resolveContentRoot and uses absolute paths,
// not relative 'content/' paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const contentConfigPath = resolve(projectRoot, 'src/content.config.ts');

test('content.config.ts — imports resolveContentRoot from ./contract/env.ts', (t) => {
  const source = readFileSync(contentConfigPath, 'utf8');

  // Should import resolveContentRoot from ./contract/env.ts
  assert(
    source.includes('resolveContentRoot'),
    'content.config.ts should import resolveContentRoot',
  );
  assert(
    source.includes("from './contract/env.ts'"),
    'content.config.ts should import from ./contract/env.ts',
  );
});

test('content.config.ts — uses absolute paths, not relative content/ literals', (t) => {
  const source = readFileSync(contentConfigPath, 'utf8');

  // Should not have relative paths like 'content/pages', 'content/posts', etc.
  const relativePaths = [
    "'content/",
    '"content/',
  ];

  for (const pattern of relativePaths) {
    assert(
      !source.includes(pattern),
      `content.config.ts should not contain relative path ${pattern}`,
    );
  }
});

test('content.config.ts — calls resolveContentRoot at the top level', (t) => {
  const source = readFileSync(contentConfigPath, 'utf8');

  // Should have a line that calls resolveContentRoot()
  assert(
    source.includes('resolveContentRoot()'),
    'content.config.ts should call resolveContentRoot()',
  );
});
