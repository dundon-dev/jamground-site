/* Test the Block -> mdast conversion in blocks-to-mdast.mjs.
 * Tests that blocks round-trip from markdown fixtures, byte-identically.
 * Each test: markdown -> mdastToBlocks -> blocksToMdast -> stringify -> original markdown */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { blocksToMdast } from '../lib/blocks-to-mdast.mjs';

// Set up the stringifier with the same canonical settings as src/lib/mdast-to-blocks.ts
const stringifier = unified()
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
    ruleSpaces: false,
    resourceLink: true,
  })
  .use(remarkGfm);

// Copy the mdastToBlocks implementation from the source (needed for round-trip testing)
const parser = unified().use(remarkParse).use(remarkGfm);

function inlineText(children) {
  return stringifier.stringify({ type: 'root', children: [{ type: 'paragraph', children }] }).trimEnd();
}

const firstOfType = (nodes, type) => nodes.find((n) => n.type === type);

function mapList(node, level) {
  return {
    ordered: node.ordered,
    items: node.children.map((li) => {
      const paragraph = firstOfType(li.children, 'paragraph');
      const nestedList = firstOfType(li.children, 'list');
      const text = inlineText(paragraph ? paragraph.children : []);
      return !nestedList || level >= 3 ? { text } : { text, list: mapList(nestedList, level + 1) };
    }),
  };
}

function mapNode(node) {
  switch (node.type) {
    case 'heading':
      return { type: 'heading', level: node.depth, text: inlineText(node.children) };
    case 'paragraph':
      if (node.children.length === 1 && node.children[0].type === 'image') {
        const { url, alt } = node.children[0];
        return { type: 'image', media: { ref: url, alt: alt || '' } };
      }
      return { type: 'paragraph', text: inlineText(node.children) };
    case 'list':
      return { type: 'list', ...mapList(node, 1) };
    case 'blockquote':
      return { type: 'quote', text: inlineText(firstOfType(node.children, 'paragraph')?.children ?? []) };
    case 'code':
      return { type: 'code', text: node.value };
    case 'table': {
      const [head, ...rows] = node.children;
      return {
        type: 'table',
        head: head.children.map((cell) => inlineText(cell.children)),
        rows: rows.map((row) => row.children.map((cell) => inlineText(cell.children))),
      };
    }
    case 'thematicBreak':
      return { type: 'separator' };
    default:
      throw new Error(`unmapped markdown construct: ${node.type}`);
  }
}

function mdastToBlocks(body) {
  const tree = parser.parse(body);
  return tree.children.map(mapNode);
}

function roundTrip(markdown) {
  // Parse markdown to blocks
  const blocks = mdastToBlocks(markdown);
  // Convert blocks back to mdast
  const mdast = blocksToMdast(blocks);
  // Stringify back to markdown
  return stringifier.stringify(mdast);
}

test('blocksToMdast — round-trip: heading', () => {
  const markdown = '## A heading\n';
  const result = roundTrip(markdown);
  assert.equal(result, markdown);
});

test('blocksToMdast — round-trip: paragraph with inline formatting', () => {
  const markdown = 'A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).\n';
  const result = roundTrip(markdown);
  assert.equal(result, markdown);
});

test('blocksToMdast — round-trip: unordered list with nesting', () => {
  const markdown = [
    '- first item',
    '  1. nested one',
    '  2. nested two',
    '     - deep',
    '',
  ].join('\n');
  const result = roundTrip(markdown);
  assert.equal(result, markdown);
});

test('blocksToMdast — round-trip: blockquote', () => {
  const markdown = '> A quote.\n';
  const result = roundTrip(markdown);
  assert.equal(result, markdown);
});

test('blocksToMdast — round-trip: seed post body (heading, paragraph, list, quote)', () => {
  const markdown = [
    '## A heading',
    '',
    'A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).',
    '',
    '- first item',
    '  1. nested one',
    '  2. nested two',
    '     - deep',
    '',
    '> A quote.',
    '',
  ].join('\n');
  const result = roundTrip(markdown);
  assert.equal(result, markdown);
});

test('blocksToMdast — round-trip: a fenced code block, marks and angle brackets intact', () => {
  // The fence's contents are PLAIN TEXT. If `blockToMdast` parsed `block.text` for inline
  // nodes the way it parses a paragraph's, `**not bold**` would come back a `strong` node and
  // the sample would be rewritten — so this fixture deliberately carries every mark.
  const markdown = [
    '```',
    'const x = 1;',
    'if (a < b && c > d) { return "**not bold**"; }',
    '- not a list item',
    '```',
    '',
  ].join('\n');
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — round-trip: an EMPTY code block, which is legal', () => {
  const markdown = '```\n```\n';
  assert.deepEqual(mdastToBlocks(markdown), [{ type: 'code', text: '' }]);
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — round-trip: a GFM table, in the canonical padded form', () => {
  const markdown = [
    '| Plan    | Price |',
    '| ------- | ----- |',
    '| Starter | $0    |',
    '| Pro     | $9    |',
    '',
  ].join('\n');
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — round-trip: a table whose cells carry InlineText marks', () => {
  const markdown = [
    '| Plan      | Notes                            |',
    '| --------- | -------------------------------- |',
    '| **Pro**   | see the [docs](https://ex.test/) |',
    '| _Starter_ | `free`                           |',
    '',
  ].join('\n');
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — round-trip: a horizontal rule, as --- and not ***', () => {
  const markdown = 'Above.\n\n---\n\nBelow.\n';
  assert.deepEqual(mdastToBlocks(markdown), [
    { type: 'paragraph', text: 'Above.' },
    { type: 'separator' },
    { type: 'paragraph', text: 'Below.' },
  ]);
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — round-trip: one body carrying all three new types at once', () => {
  const markdown = [
    '## A heading',
    '',
    'Intro paragraph.',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '| Plan    | Price |',
    '| ------- | ----- |',
    '| Starter | $0    |',
    '| Pro     | $9    |',
    '',
    '---',
    '',
    '> A quote.',
    '',
    '```',
    '```',
    '',
    'End.',
    '',
  ].join('\n');
  assert.equal(roundTrip(markdown), markdown);
});

test('blocksToMdast — heading level validation: level 1 throws', () => {
  const blocks = [{ type: 'heading', level: 1, text: 'Invalid' }];
  assert.throws(() => blocksToMdast(blocks), /Heading level must be 2–4/);
});

test('blocksToMdast — heading level validation: level 5 throws', () => {
  const blocks = [{ type: 'heading', level: 5, text: 'Invalid' }];
  assert.throws(() => blocksToMdast(blocks), /Heading level must be 2–4/);
});

// STAYS. `image` really is still unsupported: `content/media/` does not exist, media import
// is out of scope (import.mjs:12), and `MediaRef` requires a path into that directory. This
// is not a scope boundary standing in for a principle — it is the principle, about the one
// core-derived type that has nowhere to put its bytes.
test('blocksToMdast — unsupported block type throws', () => {
  const blocks = [{ type: 'image', media: { ref: 'test.jpg', alt: 'test' } }];
  assert.throws(() => blocksToMdast(blocks), /does not yet support block type/);
});
