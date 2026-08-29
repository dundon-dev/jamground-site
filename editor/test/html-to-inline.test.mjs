import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToInline } from '../lib/html-to-inline.mjs';
import { inlineToHtml } from '../lib/inline-to-html.mjs';

test('empty string yields no nodes', () => {
  assert.deepEqual(htmlToInline(''), []);
});

test('plain text passes through as a single text node', () => {
  assert.deepEqual(htmlToInline('just text'), [{ type: 'text', value: 'just text' }]);
});

test('strong (11 §Canonical-InlineText)', () => {
  assert.deepEqual(htmlToInline('<strong>bold</strong>'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ]);
});

test('emphasis (11 §Canonical-InlineText)', () => {
  assert.deepEqual(htmlToInline('<em>italic</em>'), [
    { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
  ]);
});

test('inline code (11 §Canonical-InlineText)', () => {
  assert.deepEqual(htmlToInline('<code>code</code>'), [{ type: 'inlineCode', value: 'code' }]);
});

test('external link (11 §Canonical-InlineText)', () => {
  assert.deepEqual(htmlToInline('<a href="https://example.org/">label</a>'), [
    {
      type: 'link',
      url: 'https://example.org/',
      children: [{ type: 'text', value: 'label' }],
    },
  ]);
});

test('emphasis inside strong nests the nodes', () => {
  assert.deepEqual(htmlToInline('<strong>bold <em>and italic</em></strong>'), [
    {
      type: 'strong',
      children: [
        { type: 'text', value: 'bold ' },
        { type: 'emphasis', children: [{ type: 'text', value: 'and italic' }] },
      ],
    },
  ]);
});

test('link label carries its own marks', () => {
  assert.deepEqual(htmlToInline('<a href="https://example.com"><strong>bold label</strong></a>'), [
    {
      type: 'link',
      url: 'https://example.com',
      children: [{ type: 'strong', children: [{ type: 'text', value: 'bold label' }] }],
    },
  ]);
});

test('ampersand and angle brackets, decoded by the DOM, come back as literal text', () => {
  assert.deepEqual(htmlToInline('Sales &amp; Marketing'), [
    { type: 'text', value: 'Sales & Marketing' },
  ]);
  assert.deepEqual(htmlToInline('a &lt; b &gt; c'), [{ type: 'text', value: 'a < b > c' }]);
});

test('unicode text is preserved', () => {
  assert.deepEqual(htmlToInline('café ☕'), [{ type: 'text', value: 'café ☕' }]);
});

test('round-trips through inlineToHtml for the four constructs together', () => {
  const value = 'A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).';
  const html = inlineToHtml(value);
  assert.deepEqual(htmlToInline(html), [
    { type: 'text', value: 'A paragraph with ' },
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
    { type: 'text', value: ', ' },
    { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
    { type: 'text', value: ', ' },
    { type: 'inlineCode', value: 'code' },
    { type: 'text', value: ' and a ' },
    {
      type: 'link',
      url: 'https://example.com',
      children: [{ type: 'text', value: 'link' }],
    },
    { type: 'text', value: '.' },
  ]);
});

test('span with a style attribute is prohibited and throws, naming the tag', () => {
  assert.throws(
    () => htmlToInline('<span style="color:red">x</span>'),
    /Prohibited mark inside InlineText: <span>/,
  );
});

test('script is prohibited and throws, naming the tag — isValid says nothing about this', () => {
  assert.throws(
    () => htmlToInline('<script>alert(1)</script>'),
    /Prohibited mark inside InlineText: <script>/,
  );
});

test('image is prohibited inside InlineText and throws', () => {
  assert.throws(() => htmlToInline('<img src="x.png" alt="alt">'), /Prohibited mark inside InlineText: <img>/);
});

test('hard break is prohibited and throws', () => {
  assert.throws(() => htmlToInline('a<br>b'), /Prohibited mark inside InlineText: <br>/);
});

test('strikethrough is prohibited and throws', () => {
  assert.throws(() => htmlToInline('<del>gone</del>'), /Prohibited mark inside InlineText: <del>/);
});

test('a raw comment is prohibited and throws, naming the node type', () => {
  assert.throws(() => htmlToInline('a<!-- comment -->b'), /Prohibited construct inside InlineText: node type 8/);
});

test('b and i are accepted as strong and emphasis aliases', () => {
  assert.deepEqual(htmlToInline('<b>bold</b>'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ]);
  assert.deepEqual(htmlToInline('<i>italic</i>'), [
    { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
  ]);
});

test('a link with no href still yields a link node with an empty url, rather than throwing', () => {
  assert.deepEqual(htmlToInline('<a>label</a>'), [
    { type: 'link', url: '', children: [{ type: 'text', value: 'label' }] },
  ]);
});
