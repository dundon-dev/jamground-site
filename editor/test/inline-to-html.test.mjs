import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineToHtml } from '../lib/inline-to-html.mjs';

test('empty string yields empty html', () => {
  assert.equal(inlineToHtml(''), '');
});

test('plain text passes through unchanged', () => {
  assert.equal(inlineToHtml('just text'), 'just text');
});

test('strong (11 §Canonical-InlineText)', () => {
  assert.equal(inlineToHtml('**bold**'), '<strong>bold</strong>');
});

test('emphasis (11 §Canonical-InlineText)', () => {
  assert.equal(inlineToHtml('_italic_'), '<em>italic</em>');
});

test('inline code (11 §Canonical-InlineText)', () => {
  assert.equal(inlineToHtml('`code`'), '<code>code</code>');
});

test('external link (11 §Canonical-InlineText)', () => {
  assert.equal(
    inlineToHtml('[label](https://example.org/)'),
    '<a href="https://example.org/">label</a>',
  );
});

test('the four constructs together, nested where CommonMark allows it', () => {
  const value = 'A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).';
  assert.equal(
    inlineToHtml(value),
    'A paragraph with <strong>bold</strong>, <em>italic</em>, <code>code</code> and a <a href="https://example.com">link</a>.',
  );
});

test('emphasis inside strong nests the tags', () => {
  assert.equal(inlineToHtml('**bold _and italic_**'), '<strong>bold <em>and italic</em></strong>');
});

test('link label carries its own marks', () => {
  assert.equal(
    inlineToHtml('[**bold label**](https://example.com)'),
    '<a href="https://example.com"><strong>bold label</strong></a>',
  );
});

test('ampersand, decoded by remark-parse, is re-encoded for HTML', () => {
  assert.equal(inlineToHtml('Sales & Marketing'), 'Sales &amp; Marketing');
  assert.equal(inlineToHtml('Sales &amp; Marketing'), 'Sales &amp; Marketing');
});

test('angle brackets, once decoded to literal text, are re-encoded so they cannot read back as markup', () => {
  assert.equal(inlineToHtml('a \\< b \\> c'), 'a &lt; b &gt; c');
  assert.equal(inlineToHtml('a &lt; b &gt; c'), 'a &lt; b &gt; c');
});

test('ampersand inside inline code is also encoded', () => {
  assert.equal(inlineToHtml('`a & b`'), '<code>a &amp; b</code>');
});

test('unicode text is preserved', () => {
  assert.equal(inlineToHtml('café ☕'), 'café ☕');
});

test('image is prohibited inside InlineText and throws rather than silently rendering', () => {
  assert.throws(() => inlineToHtml('![alt](x.png)'), /Prohibited construct/);
});

test('strikethrough is prohibited inside InlineText and throws', () => {
  assert.throws(() => inlineToHtml('~~gone~~'), /Prohibited construct/);
});

test('reference-style links are prohibited inside InlineText and throw', () => {
  assert.throws(
    () => inlineToHtml('[label][ref]\n\n[ref]: https://example.com'),
    /Not canonical InlineText|Prohibited construct/,
  );
});

test('more than one top-level node is not canonical InlineText and throws', () => {
  assert.throws(() => inlineToHtml('one\n\ntwo'), /Not canonical InlineText/);
});
