// THE CANVAS STYLESHEET: what is sent, what is deliberately not, and the escaping that carries it
// into a PHP single-quoted literal.
//
// It asserts against build.mjs's own exports rather than a second copy of the rules, the same
// discipline bundles-for-browser.test.mjs uses for `browserDefines` — a test that restated the
// file list would agree with itself while the build sent something else.
//
// The escaping is worth a test of its own because it is the one place a CSS file that nobody
// thinks of as code becomes code. `content: '\2014'` and `font-family: 'Foo'` both appear in
// ordinary stylesheets, and both are the characters that end a PHP single-quoted string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANVAS_STYLESHEETS, canvasStylesheet, phpSingleQuoted,
  CANVAS_CSS_PLACEHOLDER, substituteCanvasCss,
} from '../build.mjs';

const editorDir = path.dirname(fileURLToPath(import.meta.url));

/** CSS comments only — the payload keeps them, and this is for asserting about rules. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const muPluginPath = path.join(editorDir, '..', 'mu-plugin', 'jamground.php');

test('the canvas gets tokens, element defaults, the core contract and the three block sheets', async () => {
  const css = await canvasStylesheet();
  assert.ok(css.includes('--jp-color-bg'), 'tokens.css — everything below reads its custom properties');
  assert.ok(css.includes(':focus-visible'), 'base.css element defaults');
  assert.ok(css.includes('.wp-block-quote'), 'base.css — the eight core wp-block-* selectors');
  for (const cls of ['.jp-hero__heading', '.jp-feature-grid__item', '.jp-cta__link']) {
    assert.ok(css.includes(cls), `${cls} — the block sheet the markup contract targets`);
  }
});

test('the canvas does NOT get the page', async () => {
  // The load-bearing half. `enqueue_block_assets` reaches wp-admin's own body as well as the
  // canvas, and design/site.css holds a `body` that is `min-height: 100vh; display: flex` — a
  // page layout assuming header/main/footer children, which would be laid over the whole admin.
  // The chrome selectors are the milder case: dead weight describing elements that are not there.
  //
  // COMMENTS ARE STRIPPED BEFORE LOOKING, and that is not a detail. base.css's own header explains
  // which half of the `body` rule went to site.css and names `min-height: 100vh` in doing so — so
  // a search over the raw text finds the prose that documents the split and reports it as the
  // defect the split prevents. What is being asserted is about RULES.
  const css = stripComments(await canvasStylesheet());
  for (const forbidden of ['.site-header', '.site-footer', '.site-container', '.site-nav__', '100vh']) {
    assert.equal(css.includes(forbidden), false, `${forbidden} belongs to the page, not to a block`);
  }
  assert.equal(CANVAS_STYLESHEETS.includes('site.css'), false);

  // And the stripper is not doing it by removing everything.
  assert.ok(css.includes('.jp-hero'), 'stripComments removed more than the comments');
});

test('every stylesheet the list names exists, and the build fails if one does not', async () => {
  // A missing file would otherwise produce a canvas that is one block sheet short — subtly wrong,
  // and not a symptom anyone can read back to a cause.
  for (const file of CANVAS_STYLESHEETS) {
    const source = await readFile(path.join(editorDir, '..', '..', 'design', file), 'utf-8');
    assert.ok(source.length > 0, `design/${file} is empty`);
  }
});

test('the PHP escaping handles exactly the two characters a single-quoted string ends on', () => {
  // Both appear in real stylesheets: `content: '\\2014'` has a backslash, `font-family: 'Foo'` has
  // apostrophes. Everything else must pass through untouched — a single-quoted PHP string
  // interpolates nothing, so escaping `$` or `{` would put those characters into the CSS.
  assert.equal(phpSingleQuoted("a'b"), "a\\'b");
  assert.equal(phpSingleQuoted('a\\b'), 'a\\\\b');
  assert.equal(phpSingleQuoted('${x} {y} "z" \n'), '${x} {y} "z" \n');

  // ORDER: backslash first. Escaping the apostrophe first would produce `\'`, and escaping
  // backslashes after would turn it into `\\'` — which closes the string one character early.
  assert.equal(phpSingleQuoted("\\'"), "\\\\\\'");
});

test('the escaped stylesheet, read back the way PHP would read it, is the original', () => {
  // The round trip, rather than a claim about the escaper. PHP's single-quoted rule is exactly:
  // `\\` is a backslash, `\'` is an apostrophe, and every other backslash is literal.
  const phpUnquote = (s) => s.replace(/\\(['\\])/g, '$1');
  const hostile = [
    "content: '\\2014';",
    'font-family: \'Söhne\', system-ui;',
    'content: "\\\\";',
    'body::after { content: \'it\\\'s\'; }',
    '/* ${not_interpolated} {braces} */',
  ].join('\n');
  assert.equal(phpUnquote(phpSingleQuoted(hostile)), hostile);
});

test('the real stylesheet survives the round trip, and it does contain both characters', async () => {
  const css = await canvasStylesheet();
  const phpUnquote = (s) => s.replace(/\\(['\\])/g, '$1');
  assert.equal(phpUnquote(phpSingleQuoted(css)), css);
  // If neither character is present the test above proves nothing about this file, so say so
  // rather than pass quietly.
  assert.ok(/['\\]/.test(css), 'the stylesheet contains no quote or backslash — this test is vacuous');
});

test('substitution refuses a mu-plugin with nowhere to put the stylesheet', async () => {
  const muPlugin = await readFile(muPluginPath, 'utf-8');
  assert.ok(muPlugin.includes(CANVAS_CSS_PLACEHOLDER), 'section 3 must carry the placeholder');

  const substituted = substituteCanvasCss(muPlugin, await canvasStylesheet());
  assert.equal(substituted.includes(CANVAS_CSS_PLACEHOLDER), false);
  assert.ok(substituted.includes('--jp-color-bg'));

  assert.throws(
    () => substituteCanvasCss('<?php // no placeholder here', 'body{}'),
    /has no __JAMGROUND_CANVAS_CSS__ to substitute/,
  );
});

test('the substituted PHP has a balanced string literal — the escaping is the only thing between the CSS and a parse error', async () => {
  // Counting the apostrophes that are NOT escaped inside the substituted literal. An odd count
  // means the string closed somewhere it should not have, which in PHP is a syntax error that
  // takes the whole mu-plugin — and therefore the entire admin — with it.
  const muPlugin = await readFile(muPluginPath, 'utf-8');
  const substituted = substituteCanvasCss(muPlugin, await canvasStylesheet());
  const start = substituted.indexOf("$css = '") + "$css = '".length;
  let i = start, escaped = false, closed = -1;
  for (; i < substituted.length; i++) {
    const c = substituted[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === "'") { closed = i; break; }
  }
  assert.notEqual(closed, -1, 'the literal never closes');
  assert.equal(substituted.slice(closed, closed + 2), "';", 'the literal must close exactly at the end of the assignment');
});
