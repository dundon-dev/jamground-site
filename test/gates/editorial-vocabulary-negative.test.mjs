import { test } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { scanEditorialVocabulary } from './lib/editorial-vocabulary.mjs';

const mkdtempAsync = promisify(mkdtemp);

// Git vocabulary that must never appear in editor-facing strings
const FORBIDDEN_WORDS = ['branch', 'commit', 'merge', 'rebase', 'pull request'];

test('editorial vocabulary gate negative — detects each forbidden word when planted', async (t) => {
  for (const forbiddenWord of FORBIDDEN_WORDS) {
    await t.test(`detects "${forbiddenWord}" in .mjs file`, async () => {
      const tempDir = await mkdtempAsync(join(tmpdir(), 'vocab-test-'));

      try {
        // Create editor/lib directory structure
        mkdirSync(join(tempDir, 'editor', 'lib'), { recursive: true });

        // Create a test file with the forbidden word
        const testFile = join(tempDir, 'editor', 'lib', 'test.mjs');
        writeFileSync(
          testFile,
          `const message = "Click to ${forbiddenWord} the file";\nexport default message;`
        );

        // Scan the temp directory
        const violations = scanEditorialVocabulary(tempDir);

        // Assert that we found the violation
        assert.ok(violations.length > 0, `Should detect "${forbiddenWord}"`);
        assert.ok(
          violations.some((v) => v.word === forbiddenWord),
          `Should report word "${forbiddenWord}"`
        );
        assert.ok(
          violations.some((v) => v.file === testFile),
          `Should report file "${testFile}"`
        );
      } finally {
        // Cleanup happens implicitly since mkdtemp creates temp files
      }
    });

    await t.test(`detects "${forbiddenWord}" in HTML file`, async () => {
      const tempDir = await mkdtempAsync(join(tmpdir(), 'vocab-test-'));

      try {
        // Create editor directory
        mkdirSync(join(tempDir, 'editor'), { recursive: true });

        // Create index.html with the forbidden word
        const htmlFile = join(tempDir, 'editor', 'index.html');
        writeFileSync(
          htmlFile,
          `<html><body><p>Click to ${forbiddenWord} your changes</p></body></html>`
        );

        // Scan the temp directory
        const violations = scanEditorialVocabulary(tempDir);

        // Assert that we found the violation
        assert.ok(violations.length > 0, `Should detect "${forbiddenWord}"`);
        assert.ok(
          violations.some((v) => v.word === forbiddenWord),
          `Should report word "${forbiddenWord}"`
        );
        assert.ok(
          violations.some((v) => v.file === htmlFile),
          `Should report file "${htmlFile}"`
        );
      } finally {
        // Cleanup happens implicitly
      }
    });
  }
});

test('editorial vocabulary gate negative — clean tree shows no violations', async () => {
  const tempDir = await mkdtempAsync(join(tmpdir(), 'vocab-test-'));

  try {
    // Create editor directory structure with clean files
    mkdirSync(join(tempDir, 'editor', 'lib'), { recursive: true });

    // Create a clean .mjs file
    const mjs_file = join(tempDir, 'editor', 'lib', 'clean.mjs');
    writeFileSync(
      mjs_file,
      `const message = "Click to save your changes";
export const help = "Send for review when ready";
export default message;`
    );

    // Create a clean index.html
    const htmlFile = join(tempDir, 'editor', 'index.html');
    writeFileSync(
      htmlFile,
      `<html><body><p>Click save to save your changes</p><p>Send for review when ready</p></body></html>`
    );

    // Scan the temp directory
    const violations = scanEditorialVocabulary(tempDir);

    // Assert that no violations were found
    assert.strictEqual(
      violations.length,
      0,
      'Clean tree should have no violations'
    );
  } finally {
    // Cleanup happens implicitly
  }
});
