import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — the ESM build imports JSON without an import attribute and fails under
// Node ESM.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse } = require('@wordpress/blocks');
registerCoreBlocks();

const { blockToWp, blocksToMarkup } = await import('../lib/blocks-to-wp.mjs');

const api = { createBlock, serialize };

function assertAllValid(markup) {
  const parsed = parse(markup);
  const invalid = parsed.filter((b) => !b.isValid);
  assert.equal(invalid.length, 0, `invalid blocks: ${invalid.map((b) => b.name).join(', ')}`);
  return parsed;
}

test('paragraph maps to core/paragraph and re-parses valid', () => {
  const markup = blocksToMarkup(api, [{ type: 'paragraph', text: 'A paragraph with **bold** and _italic_.' }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/paragraph');
  assert.equal(String(block.attributes.content), 'A paragraph with <strong>bold</strong> and <em>italic</em>.');
});

test('heading maps to core/heading, carrying level', () => {
  const markup = blocksToMarkup(api, [{ type: 'heading', level: 3, text: 'A heading' }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/heading');
  assert.equal(block.attributes.level, 3);
  assert.equal(String(block.attributes.content), 'A heading');
});

test('quote maps to core/quote with an innerBlock paragraph', () => {
  const markup = blocksToMarkup(api, [{ type: 'quote', text: 'A quoted line.' }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/quote');
  assert.equal(block.innerBlocks.length, 1);
  assert.equal(block.innerBlocks[0].name, 'core/paragraph');
  assert.equal(String(block.innerBlocks[0].attributes.content), 'A quoted line.');
});

test('quote citation is carried and HTML-escaped, not markdown-processed', () => {
  const markup = blocksToMarkup(api, [
    { type: 'quote', text: 'A quoted line.', citation: 'Sales & Marketing <team>' },
  ]);
  const [block] = assertAllValid(markup);
  assert.equal(String(block.attributes.citation), 'Sales &amp; Marketing &lt;team&gt;');
});

test('unordered list maps to core/list with core/list-item children', () => {
  const markup = blocksToMarkup(api, [
    { type: 'list', items: [{ text: 'first item' }, { text: 'second item' }] },
  ]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/list');
  assert.equal(block.attributes.ordered, false);
  assert.equal(block.innerBlocks.length, 2);
  assert.deepEqual(
    block.innerBlocks.map((li) => String(li.attributes.content)),
    ['first item', 'second item'],
  );
});

test('ordered list carries the ordered attribute', () => {
  const markup = blocksToMarkup(api, [{ type: 'list', ordered: true, items: [{ text: 'one' }] }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.attributes.ordered, true);
});

test('nested list (three levels, 11 §4a) becomes an innerBlock of its list-item', () => {
  const markup = blocksToMarkup(api, [
    {
      type: 'list',
      items: [
        {
          text: 'top',
          list: {
            ordered: true,
            items: [
              {
                text: 'middle',
                list: { items: [{ text: 'deepest' }] },
              },
            ],
          },
        },
      ],
    },
  ]);
  const parsed = assertAllValid(markup);
  const top = parsed[0];
  const topItem = top.innerBlocks[0];
  assert.equal(String(topItem.attributes.content), 'top');

  const middleList = topItem.innerBlocks[0];
  assert.equal(middleList.name, 'core/list');
  assert.equal(middleList.attributes.ordered, true);
  const middleItem = middleList.innerBlocks[0];
  assert.equal(String(middleItem.attributes.content), 'middle');

  const deepestList = middleItem.innerBlocks[0];
  assert.equal(deepestList.name, 'core/list');
  const deepestItem = deepestList.innerBlocks[0];
  assert.equal(String(deepestItem.attributes.content), 'deepest');
});

test('an unmapped block type throws rather than being silently dropped', () => {
  assert.throws(
    () => blockToWp(api, { type: 'separator' }),
    /unmapped contract block type: separator/,
  );
});

test('ampersand and angle brackets in InlineText survive as valid, entity-encoded markup', () => {
  const markup = blocksToMarkup(api, [{ type: 'paragraph', text: 'Sales & Marketing: a < b' }]);
  const [block] = assertAllValid(markup);
  assert.equal(String(block.attributes.content), 'Sales &amp; Marketing: a &lt; b');
});
