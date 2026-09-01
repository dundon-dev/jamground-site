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

// ---- The standing line, and the second vocabulary rule it depends on ------------------------

test('the gate refuses "staging", which names a thing this product does not have', () => {
  // Separate from the git words above and failing for a different reason: "branch" leaks the
  // mechanism, "staging site" names the wrong thing. The glossary is explicit — "there is
  // deliberately no long-lived staging environment" — and what a change gets is an ephemeral
  // Preview at `pr-<number>.preview.<domain>`, torn down with the change that owned it.
  const violations = checkForViolations('saved — your staging site is updating');
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].word, 'staging');
  assert.match(violations[0].instead, /preview/i);

  // And it does not fire on the word this product actually uses.
  assert.strictEqual(checkForViolations('saved — your preview is updating').length, 0);
});

test('the standing line says what the editor is for, without overselling it', async () => {
  const { VOCAB } = await import('../../editor/lib/vocabulary.mjs');

  assert.ok(VOCAB.standingNote, 'there must be a standing line');
  assert.strictEqual(checkForViolations(VOCAB.standingNote).length, 0);

  // The two halves 09 §7 asks for. CLAIMED: a block does not look wrong — its colours, type and
  // spacing match the site. NOT CLAIMED: the page around it, which is where the preview is the
  // visual truth. A line with only the first half is the oversell 09 §7 opens by warning about.
  assert.match(VOCAB.standingNote, /design system/i, 'it should say where the styling comes from');
  assert.match(VOCAB.standingNote, /preview/i, 'it should name where the page is actually settled');

  // ADR-0013 claims "near-true WYSIWYG for allowlisted blocks" and 09 §7 says the word oversells
  // it and editors will notice the gap. So the word does not appear, and neither does any claim
  // of exactness — asserted rather than left to whoever edits this line next.
  for (const oversold of [/wysiwyg/i, /\bexactly\b/i, /\bidentical\b/i, /\bpixel/i]) {
    assert.strictEqual(oversold.test(VOCAB.standingNote), false,
      `the standing line must not claim ${oversold} — 09 §7 is explicit that it would not be true`);
  }
});

test('the shell renders the standing line permanently, with nothing to dismiss it', async () => {
  // A notice an editor can close is a notice most editors have closed, and what this one says does
  // not stop being true after one reading. Asserted on the markup rather than in the browser
  // because what is being checked is the ABSENCE of a control, and absence is what a browser test
  // is worst at: a selector that silently stops matching passes it.
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../editor/index.html', import.meta.url), 'utf8');

  assert.match(html, /id="jamground-standing-note"/, 'the shell needs somewhere to put it');
  // Empty in the markup: entry.mjs fills it from VOCAB, so there is no second copy of the words.
  assert.match(html, /<p id="jamground-standing-note"><\/p>/);

  const entry = readFileSync(new URL('../../editor/entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /standingNote\.textContent = VOCAB\.standingNote/);
  // No dismiss affordance anywhere near it.
  assert.strictEqual(/standing-note[^]{0,400}?(dismiss|close|×|aria-label="Close")/i.test(html), false);
});
