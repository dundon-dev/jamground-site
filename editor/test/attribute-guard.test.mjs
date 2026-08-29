import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — see blocks-to-wp.test.mjs for why.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, getBlockType, parse, serialize, registerBlockType, unregisterBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const { guardBlockAttributes, guardExportTree } = await import('../lib/attribute-guard.mjs');

const api = { getBlockType };

test('an allowlisted attribute passes through untouched', () => {
  const [block] = parse(serialize([createBlock('core/paragraph', { content: 'hi' })]));
  const out = guardBlockAttributes(api, block);
  assert.equal(String(out.content), 'hi');
});

test('an attribute still at its registered default is ignored (dropCap: false)', () => {
  const [block] = parse(serialize([createBlock('core/paragraph', { content: 'hi' })]));
  assert.equal(block.attributes.dropCap, false); // present, and exactly the case isDefaulted() exists for
  assert.doesNotThrow(() => guardBlockAttributes(api, block));
});

test('a non-default, non-contract attribute is refused, naming the block and attribute', () => {
  const [block] = parse(
    serialize([createBlock('core/paragraph', { content: 'hi', textColor: 'vivid-red' })]),
  );
  assert.throws(() => guardBlockAttributes(api, block), /textColor/);
  assert.throws(() => guardBlockAttributes(api, block), /core\/paragraph/);
});

test('align set away from its default is refused', () => {
  const [block] = parse(serialize([createBlock('core/paragraph', { content: 'hi', align: 'wide' })]));
  assert.throws(() => guardBlockAttributes(api, block), /align/);
});

test('heading carries level and content, nothing else', () => {
  const [block] = parse(serialize([createBlock('core/heading', { level: 2, content: 'A heading' })]));
  const out = guardBlockAttributes(api, block);
  assert.deepEqual(Object.keys(out).sort(), ['content', 'level']);
  assert.equal(String(out.content), 'A heading');
  assert.equal(out.level, 2);
});

test('image export strips the attachment id and the wp-image-N class', () => {
  const block = createBlock('core/image', {
    url: 'https://example.test/y.jpg',
    alt: 'a photo',
    id: 42,
    className: 'wp-image-42',
  });
  const [parsed] = parse(serialize([block]));
  const out = guardBlockAttributes(api, parsed);
  assert.equal(out.id, undefined);
  assert.equal(out.className, undefined);
  assert.equal(out.url, 'https://example.test/y.jpg');
  assert.equal(out.alt, 'a photo');
});

test('a genuine className left after stripping wp-image-N is still refused (className is not in the table)', () => {
  const block = createBlock('core/image', {
    url: 'https://example.test/y.jpg',
    alt: 'a photo',
    id: 7,
    className: 'foo wp-image-7 bar',
  });
  const [parsed] = parse(serialize([block]));
  assert.throws(() => guardBlockAttributes(api, parsed), /className/);
});

test('a block with no contract representation at all is refused', () => {
  const [block] = parse(serialize([createBlock('core/spacer', {})]));
  assert.throws(() => guardBlockAttributes(api, block), /core\/spacer/);
});

// `core/table`'s `caption` is a rich-text attribute with NO registered default, so every
// table parses with `caption` present and empty whether or not anyone typed one — and
// `isDefaulted` cannot see that. Without the empty-caption strip, the guard refused EVERY
// table, so no table could round-trip and every post containing one stayed held back.
test('a table with no caption passes: the empty caption every table parses with is stripped', () => {
  const [block] = parse(serialize([createBlock('core/table', {
    head: [{ cells: [{ content: 'Plan', tag: 'th' }] }],
    body: [{ cells: [{ content: 'Starter', tag: 'td' }] }],
  })]));
  assert.equal('caption' in block.attributes, true, 'present on every parsed table, and empty');
  assert.equal(String(block.attributes.caption), '');
  const out = guardBlockAttributes(api, block);
  assert.equal('caption' in out, false, 'the parser artifact is dropped, not carried');
  assert.deepEqual(Object.keys(out).sort(), ['body', 'foot', 'hasFixedLayout', 'head']);
});

test('a caption someone actually TYPED is still refused — the contract has nowhere to keep it', () => {
  const [block] = parse(serialize([createBlock('core/table', {
    caption: 'Prices as of today',
    head: [{ cells: [{ content: 'Plan', tag: 'th' }] }],
    body: [{ cells: [{ content: 'Starter', tag: 'td' }] }],
  })]));
  assert.equal(String(block.attributes.caption), 'Prices as of today');
  assert.throws(() => guardBlockAttributes(api, block), /caption/);
  assert.throws(() => guardBlockAttributes(api, block), /core\/table/);
});

test('a table footer is refused: `foot` leaves its [] default and the contract has no footer', () => {
  const [block] = parse(serialize([createBlock('core/table', {
    head: [{ cells: [{ content: 'Plan', tag: 'th' }] }],
    body: [{ cells: [{ content: 'Starter', tag: 'td' }] }],
    foot: [{ cells: [{ content: 'Total', tag: 'td' }] }],
  })]));
  assert.throws(() => guardBlockAttributes(api, block), /foot/);
});

test('a separator passes on its two defaults alone, and refuses a colour set away from them', () => {
  const [block] = parse(serialize([createBlock('core/separator', {})]));
  assert.deepEqual(guardBlockAttributes(api, block), { opacity: 'alpha-channel', tagName: 'hr' });

  const [coloured] = parse(serialize([createBlock('core/separator', { backgroundColor: 'vivid-red' })]));
  assert.throws(() => guardBlockAttributes(api, coloured), /backgroundColor/);
});

test('a code block carries content and nothing else', () => {
  const [block] = parse(serialize([createBlock('core/code', { content: 'const x = 1;' })]));
  const out = guardBlockAttributes(api, block);
  assert.deepEqual(Object.keys(out), ['content']);
});

test('a jamground custom block allows exactly its registered (schema) attributes', () => {
  registerBlockType('jamground/callout', {
    title: 'Callout',
    category: 'text',
    attributes: { text: { type: 'string', default: '' } },
    supports: { className: false },
    save() {
      return null;
    },
  });
  try {
    const [block] = parse(serialize([createBlock('jamground/callout', { text: 'hi' })]));
    const out = guardBlockAttributes(api, block);
    assert.deepEqual(out, { text: 'hi' });
  } finally {
    unregisterBlockType('jamground/callout');
  }
});

test('guardExportTree sanitises inner blocks too (quote > paragraph)', () => {
  const quote = createBlock(
    'core/quote',
    { citation: 'Someone' },
    [createBlock('core/paragraph', { content: 'quoted', textColor: 'vivid-red' })],
  );
  const parsed = parse(serialize([quote]));
  assert.throws(() => guardExportTree(api, parsed), /textColor/);
});

test('guardExportTree does not mutate the input tree', () => {
  const [block] = parse(
    serialize([createBlock('core/image', { url: 'https://example.test/y.jpg', alt: 'a', id: 9 })]),
  );
  const before = JSON.stringify(block.attributes);
  guardExportTree(api, [block]);
  assert.equal(JSON.stringify(block.attributes), before);
});
