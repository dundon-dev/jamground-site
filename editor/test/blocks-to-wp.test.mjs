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

test('code maps to core/code as PLAIN TEXT — markdown marks in a sample are not marks', () => {
  // `Code.text` is a bare `z.string()`, not InlineText. Running it through `inlineToHtml`
  // would read `**bold**` in a code sample as a mark and hand core `<strong>bold</strong>`,
  // rewriting the sample. `core/code`'s `content` is nevertheless a rich-text attribute — so
  // it is HTML, and an unescaped `<` in a sample is read as a tag and the rest EATEN.
  const sample = 'if (a < b && c) { return "**not bold**"; }';
  const markup = blocksToMarkup(api, [{ type: 'code', text: sample }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/code');
  const content = String(block.attributes.content);
  assert.match(content, /\*\*not bold\*\*/, 'the asterisks are literal text in a code sample');
  assert.doesNotMatch(content, /<strong>/, 'and must never have become a mark');
  assert.doesNotMatch(content, /<b>/);
  assert.match(content, /a &lt; b/, 'and `<` is entity-escaped, or the sample would be truncated');
});

test('code — the markup contract: pre.wp-block-code > code, and no language anywhere', () => {
  const markup = blocksToMarkup(api, [{ type: 'code', text: 'const x = 1;' }]);
  assert.match(markup, /<pre class="wp-block-code"><code>const x = 1;<\/code><\/pre>/);
  assert.doesNotMatch(markup, /lang/i, 'the contract carries no info string, so nothing may emit one');
  assertAllValid(markup);
});

test('code — an empty code block is legal and survives as an empty block', () => {
  const markup = blocksToMarkup(api, [{ type: 'code', text: '' }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/code');
  assert.equal(String(block.attributes.content), '');
  assert.match(markup, /<pre class="wp-block-code"><code><\/code><\/pre>/);
});

test('table maps to core/table with head/body as arrays of ROWS, th in head and td in body', () => {
  const markup = blocksToMarkup(api, [
    { type: 'table', head: ['Plan', 'Price'], rows: [['Starter', '$0'], ['Pro', '$9']] },
  ]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/table');

  // Not a flat array of cells: one row object per row, each with a `cells` array.
  assert.equal(block.attributes.head.length, 1, 'the contract has exactly one header row');
  assert.deepEqual(block.attributes.head[0].cells.map((c) => c.tag), ['th', 'th']);
  assert.deepEqual(
    block.attributes.head[0].cells.map((c) => String(c.content)), ['Plan', 'Price'],
  );
  assert.equal(block.attributes.body.length, 2);
  assert.deepEqual(block.attributes.body[0].cells.map((c) => c.tag), ['td', 'td']);
  assert.deepEqual(
    block.attributes.body.map((r) => r.cells.map((c) => String(c.content))),
    [['Starter', '$0'], ['Pro', '$9']],
  );
  assert.deepEqual(block.attributes.foot, [], 'the contract has no footer, so none is written');
});

test('table cells are InlineText and keep their marks, unlike a code block', () => {
  const markup = blocksToMarkup(api, [
    { type: 'table', head: ['Plan'], rows: [[' **Pro** '.trim()]] },
  ]);
  const [block] = assertAllValid(markup);
  assert.equal(String(block.attributes.body[0].cells[0].content), '<strong>Pro</strong>');
});

test('table — the markup contract: figure.wp-block-table > table.has-fixed-layout', () => {
  const markup = blocksToMarkup(api, [{ type: 'table', head: ['A'], rows: [['b']] }]);
  assert.match(
    markup,
    /<figure class="wp-block-table"><table class="has-fixed-layout"><thead><tr><th>A<\/th><\/tr><\/thead><tbody><tr><td>b<\/td><\/tr><\/tbody><\/table><\/figure>/,
  );
});

test('separator maps to core/separator, with both default classes and no attributes set', () => {
  const markup = blocksToMarkup(api, [{ type: 'separator' }]);
  const [block] = assertAllValid(markup);
  assert.equal(block.name, 'core/separator');
  assert.match(markup, /<hr class="wp-block-separator has-alpha-channel-opacity"\/>/);
  // Both classes come from `opacity` and `tagName` still sitting at their registered
  // defaults — which is why the mapper sets no attribute at all.
  assert.deepEqual(block.attributes, { opacity: 'alpha-channel', tagName: 'hr' });
});

// `image` is the one core-derived type still genuinely unmapped: `content/media/` does not
// exist, media import is out of scope (import.mjs:12), and `MediaRef` requires a path into
// that directory. It has no positive case above for that reason.
test('image is still refused, naming itself, because there is no media path yet', () => {
  assert.throws(
    () => blockToWp(api, { type: 'image', media: { ref: 'media/a.jpg', alt: 'a' } }),
    /unmapped contract block type: image/,
  );
});

// The `default:` arm is asserted with a type the contract does not have and never will, so
// that supporting a further block type cannot invalidate this test the way adding `separator`
// invalidated its previous form. What is being asserted is the arm, not the example.
test('an unmapped block type throws rather than being silently dropped', () => {
  assert.throws(
    () => blockToWp(api, { type: 'notAType' }),
    /unmapped contract block type: notAType/,
  );
});

test('ampersand and angle brackets in InlineText survive as valid, entity-encoded markup', () => {
  const markup = blocksToMarkup(api, [{ type: 'paragraph', text: 'Sales & Marketing: a < b' }]);
  const [block] = assertAllValid(markup);
  assert.equal(String(block.attributes.content), 'Sales &amp; Marketing: a &lt; b');
});
