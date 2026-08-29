// Test the round trip: export of an unmodified import is byte-identical
// Parse post -> blocks -> markup -> blocks -> mdast -> markdown -> export
// Assert the final bytes match the input bytes exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const {
  markupToContractBlocks, exportPost,
} = await import('../lib/export.mjs');
const { blocksToMarkup } = await import('../lib/blocks-to-wp.mjs');
const { parsePost } = await import('../lib/entity.mjs');
const { blocksToMdast } = await import('../lib/blocks-to-mdast.mjs');

const api = { createBlock, serialize, parse, getBlockType };

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

// Parser for converting markdown to blocks
const mdastParser = unified().use(remarkParse).use(remarkGfm);

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
      return { type: 'paragraph', text: inlineText(node.children) };
    case 'list':
      return { type: 'list', ...mapList(node, 1) };
    case 'blockquote':
      return { type: 'quote', text: inlineText(firstOfType(node.children, 'paragraph')?.children ?? []) };
    default:
      throw new Error(`unmapped markdown construct: ${node.type}`);
  }
}

function mdastToBlocks(body) {
  const tree = mdastParser.parse(body);
  return tree.children.map(mapNode);
}

// Helper to report the first differing byte offset
function findFirstDiff(original, exported) {
  const minLen = Math.min(original.length, exported.length);
  for (let i = 0; i < minLen; i++) {
    if (original[i] !== exported[i]) {
      return i;
    }
  }
  if (original.length !== exported.length) {
    return minLen;
  }
  return -1;
}

// Seed post 1: published with all required fields
const SEED_POST_1 = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test-post-1
title: Test Post 1
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
---

Test content for post 1.
`;

// Seed post 2: draft with optional fields absent
const SEED_POST_2 = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JF
translationOf: 01M0BSHSG62QD33PKX3GRRXX5X
locale: en-US
slug: test-post-2
title: Test Post 2
status: draft
updatedAt: '2026-08-02T10:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1D
---

Another test post content.
`;

test('round trip: seed post 1 (published, all fields) is byte-identical', () => {
  // Parse to entity
  const parsed = parsePost('/content/posts/en-US/test1.md', SEED_POST_1);

  // Convert markdown body to blocks
  const blocks = mdastToBlocks(parsed.body);

  // Convert blocks to markup
  const markup = blocksToMarkup(api, blocks);

  // Convert markup back to blocks
  const importedBlocks = markupToContractBlocks(api, markup);

  // Convert back to mdast and stringify
  const mdast = blocksToMdast(importedBlocks);
  const body = stringifier.stringify(mdast);

  // Export the post (updatedAt preserved, no slug change)
  const exported = exportPost({
    api, markup,
    frontmatter: parsed.frontmatter,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: parsed.frontmatter.updatedAt,
  });

  // Compare bytes
  const diffOffset = findFirstDiff(SEED_POST_1, exported);
  assert.equal(
    diffOffset, -1,
    diffOffset >= 0
      ? `First differing byte at offset ${diffOffset}: original=${JSON.stringify(SEED_POST_1[diffOffset])} vs exported=${JSON.stringify(exported[diffOffset])}`
      : 'bytes should be identical'
  );
  assert.equal(exported, SEED_POST_1);
});

test('round trip: seed post 2 (draft, minimal fields) is byte-identical', () => {
  // Parse to entity
  const parsed = parsePost('/content/posts/en-US/test2.md', SEED_POST_2);

  // Convert markdown body to blocks
  const blocks = mdastToBlocks(parsed.body);

  // Convert blocks to markup
  const markup = blocksToMarkup(api, blocks);

  // Convert markup back to blocks
  const importedBlocks = markupToContractBlocks(api, markup);

  // Convert back to mdast and stringify
  const mdast = blocksToMdast(importedBlocks);
  const body = stringifier.stringify(mdast);

  // Export the post (updatedAt preserved, no slug change)
  const exported = exportPost({
    api, markup,
    frontmatter: parsed.frontmatter,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: parsed.frontmatter.updatedAt,
  });

  // Compare bytes
  const diffOffset = findFirstDiff(SEED_POST_2, exported);
  assert.equal(
    diffOffset, -1,
    diffOffset >= 0
      ? `First differing byte at offset ${diffOffset}: original=${JSON.stringify(SEED_POST_2[diffOffset])} vs exported=${JSON.stringify(exported[diffOffset])}`
      : 'bytes should be identical'
  );
  assert.equal(exported, SEED_POST_2);
});
