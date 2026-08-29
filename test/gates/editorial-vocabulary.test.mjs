import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  extractStringLiterals,
  extractHtmlText,
  checkForViolations,
  scanEditorialVocabulary,
} from './lib/editorial-vocabulary.mjs';

test('editorial vocabulary gate — no git vocabulary in editor-facing strings', async (t) => {
  const violations = scanEditorialVocabulary(process.cwd());

  // Report violations
  if (violations.length > 0) {
    const message = violations
      .map(v => `${v.file}: "${v.word}"`)
      .join('\n');
    assert.fail(`Git vocabulary found in editor-facing strings:\n${message}`);
  }
});

// Test the extractStringLiterals function
test('extractStringLiterals — correctly extracts strings and excludes code', (t) => {
  const source = `
    // This is a comment with branch in it - should be excluded
    const x = "save the change"; // another comment about commit
    const y = 'publish to main';
    const fn = (branch) => { /* merge all */ }; // excluded
    import { save } from './vocab'; // import name is code
    const obj = { branch: 'main' }; // property name is code
  `;

  const strings = extractStringLiterals(source);

  // Should find the actual string literals
  assert.ok(strings.includes('save the change'), 'should find double-quoted strings');
  assert.ok(strings.includes('publish to main'), 'should find single-quoted strings');

  // Should not include comment text
  assert.strictEqual(
    strings.filter(s => s.includes('comment with branch')).length,
    0,
    'should not extract from comments'
  );

  // Should not include identifiers
  assert.strictEqual(
    strings.filter(s => s === 'branch' && !strings.some(st => st.includes('save the change'))).length,
    0,
    'identifiers should not be extracted as standalone strings'
  );
});

test('checkForViolations — detects forbidden words case-insensitively', (t) => {
  const violations1 = checkForViolations('Click save the BRANCH');
  assert.strictEqual(
    violations1.length,
    1,
    'should find "branch" case-insensitively'
  );
  assert.strictEqual(violations1[0].word, 'branch');

  const violations2 = checkForViolations('Cannot MERGE this');
  assert.strictEqual(violations2.length, 1, 'should find "merge"');

  const violations3 = checkForViolations('Create a commit message');
  assert.strictEqual(violations3.length, 1, 'should find "commit"');

  const violations4 = checkForViolations('Click publish');
  assert.strictEqual(violations4.length, 0, 'should not flag "publish"');

  const violations5 = checkForViolations('send for review');
  assert.strictEqual(violations5.length, 0, 'should not flag "send for review"');

  const violations6 = checkForViolations('the rebase command');
  assert.strictEqual(violations6.length, 1, 'should find "rebase"');

  const violations7 = checkForViolations('open a pull request');
  assert.strictEqual(violations7.length, 1, 'should find "pull request"');
});
