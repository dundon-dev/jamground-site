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
  markupToContractBlocks, exportPost, exportEntity,
} = await import('../lib/export.mjs');
const { blocksToMarkup } = await import('../lib/blocks-to-wp.mjs');
const { parseEntity, parsePost } = await import('../lib/entity.mjs');
const { KINDS } = await import('../lib/kinds.mjs');
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

// --- pages -------------------------------------------------------------------------------
//
// The same property, through a different serialiser. A page has no markdown step at all: its
// blocks go to Gutenberg and come back, and the whole file is `write({…envelope, blocks},
// Page)` with no frontmatter fence. If those bytes are not identical, `_jamground_source`
// differs from the export with NO EDIT AT ALL, and the first save writes that difference into
// the person's own repository inside a change they believe is theirs.
//
// This fixture pins the two things a page's own writer has to get right and a post's never
// exercised: the `blocks` key sits last (canonical.ts derives key order from the schema's
// shape, and `Page = Envelope.extend({ blocks })` puts it there by construction), and a text
// containing a colon is quoted by the canonical writer and comes back unquoted through the
// block round trip.

const SEED_PAGE = `id: 01M143VEG04JRXAX5JYES4JXZ0
translationOf: 01M143VFF8TN0D6FNX3S6M5T49
locale: en-US
slug: home
title: Home
status: published
publishedAt: '2026-08-28T12:00:00Z'
updatedAt: '2026-08-28T12:00:00Z'
blocks:
  - type: heading
    level: 2
    text: Welcome
  - type: paragraph
    text: 'This site demonstrates the shape of the content in this repository: one page, one post, one author and one navigation menu.'
`;

test('round trip: a seed page is byte-identical through write(x, Page)', () => {
  const parsed = parseEntity('page', '/content/pages/en-US/home.yaml', SEED_PAGE);

  // No mdastToBlocks step: `Page.blocks` IS the contract block list blocksToMarkup consumes.
  const markup = blocksToMarkup(api, parsed.blocks);

  const exported = exportEntity({
    kind: 'page',
    api,
    markup,
    frontmatter: parsed.frontmatter,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: parsed.frontmatter.updatedAt,
  });

  const diffOffset = findFirstDiff(SEED_PAGE, exported);
  assert.equal(
    diffOffset, -1,
    diffOffset >= 0
      ? `First differing byte at offset ${diffOffset}: original=${JSON.stringify(SEED_PAGE[diffOffset])} vs exported=${JSON.stringify(exported[diffOffset])}`
      : 'bytes should be identical'
  );
  assert.equal(exported, SEED_PAGE);
  assert.equal(exported.startsWith('---'), false, 'a page carries no frontmatter fence');
});

test('round trip: the post serialiser cannot reproduce a page', () => {
  const parsed = parseEntity('page', '/content/pages/en-US/home.yaml', SEED_PAGE);
  const markup = blocksToMarkup(api, parsed.blocks);

  // The same envelope and the same markup, exported as a post. This particular page fails
  // loudly, because `Post` requires an `author` a page's envelope has not got — but that is
  // luck, not the guarantee: an envelope that satisfied both schemas would emit fenced
  // markdown and overwrite the YAML document with it, with nothing complaining. The guarantee
  // is read-posts.mjs's three-way cross-check, which stops before export is ever reached, and
  // exportEntity's refusal to default a missing kind (export.test.mjs).
  assert.throws(() => exportPost({
    api,
    markup,
    frontmatter: parsed.frontmatter,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: parsed.frontmatter.updatedAt,
  }), /author/);
});


// --- authors -----------------------------------------------------------------------------
//
// The same property again, through the third serialiser, and this time with NO blocks in the
// middle of it at all. An author is a person: `Author` has no `blocks` field, `toBlocks`
// returns `[]`, `blocksToMarkup(api, [])` is the empty string, and the file that comes back
// out is `write(frontmatter, Author)`.
//
// These are the real bytes of `content/authors/en-US/example.yaml` — the one author the site
// actually serves, and the file import.mjs's admission check runs this exact comparison
// against on every boot. If they are not identical, `_jamground_source` differs from the
// export with NO EDIT AT ALL, and the first save writes `name`, `role` or `bio` out of the
// person's own repository inside a change they believe is theirs.

const SEED_AUTHOR = `id: 01M143VMBG3P9TE12W2BQ3SWX8
translationOf: 01M143VNARFS53GN4MRZ48TMJ9
locale: en-US
slug: example-author
title: Example Author
status: published
publishedAt: '2026-08-28T12:00:00Z'
updatedAt: '2026-08-28T12:00:00Z'
name: Example Author
role: Editor
bio: Writes and edits the example content used to demonstrate this repository.
`;

test('round trip: the seed author is byte-identical through write(x, Author)', () => {
  const parsed = parseEntity('author', '/content/authors/en-US/example.yaml', SEED_AUTHOR);

  // Through the kind table's own `toBlocks`, not a literal `[]` written here — the claim is
  // that the table says an author has no blocks, and a table that said otherwise must fail.
  const blocks = KINDS.author.toBlocks(parsed);
  assert.deepEqual(blocks, [], 'an author has no blocks to put on a canvas');

  const markup = blocksToMarkup(api, blocks);
  assert.equal(markup, '', 'and therefore no block markup, so post_content is empty');

  const exported = exportEntity({
    kind: 'author',
    api,
    markup,
    frontmatter: parsed.frontmatter,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: parsed.frontmatter.updatedAt,
  });

  const diffOffset = findFirstDiff(SEED_AUTHOR, exported);
  assert.equal(
    diffOffset, -1,
    diffOffset >= 0
      ? `First differing byte at offset ${diffOffset}: original=${JSON.stringify(SEED_AUTHOR[diffOffset])} vs exported=${JSON.stringify(exported[diffOffset])}`
      : 'bytes should be identical'
  );
  assert.equal(exported, SEED_AUTHOR);
  assert.equal(exported.startsWith('---'), false, 'an author carries no frontmatter fence');

  // The three fields nothing in wp-admin can edit this stage survive the trip untouched.
  // They are carried, never named, by the serialiser — so this is what would catch a writer
  // that started enumerating fields instead.
  assert.match(exported, /^name: Example Author$/m);
  assert.match(exported, /^role: Editor$/m);
  assert.match(exported, /^bio: Writes and edits the example content used to demonstrate this repository\.$/m);
});

test('round trip: a title and slug typed in wp-admin reach an author\'s bytes, and nothing else moves', () => {
  const parsed = parseEntity('author', '/content/authors/en-US/example.yaml', SEED_AUTHOR);

  // Exactly what read-posts.mjs lays over the baseline envelope: post_title and post_name.
  const edited = { ...parsed.frontmatter, title: 'Renamed Person', slug: 'renamed-person' };

  const exported = exportEntity({
    kind: 'author',
    api,
    markup: '',
    frontmatter: edited,
    previousSlug: parsed.frontmatter.slug,
    updatedAt: '2026-08-29T09:00:00Z',
  });

  assert.match(exported, /^title: Renamed Person$/m);
  assert.match(exported, /^slug: renamed-person$/m);
  // An author's address is not the homepage, so renaming one is allowed and grows the history
  // that drives the site's redirects — the same envelope rule pages and posts follow.
  assert.match(exported, /^slugHistory:\n {2}- example-author$/m);
  assert.match(exported, /^updatedAt: '2026-08-29T09:00:00Z'$/m);
  // Untouched, and still present.
  assert.match(exported, /^name: Example Author$/m);
  assert.match(exported, /^role: Editor$/m);
});

test('round trip: an author refuses a body rather than dropping it, and says whose', () => {
  const parsed = parseEntity('author', '/content/authors/en-US/example.yaml', SEED_AUTHOR);
  const markup = blocksToMarkup(api, [{ type: 'paragraph', text: 'Typed onto the canvas.' }]);

  assert.throws(
    () => exportEntity({
      kind: 'author',
      api,
      markup,
      frontmatter: parsed.frontmatter,
      previousSlug: parsed.frontmatter.slug,
      updatedAt: parsed.frontmatter.updatedAt,
    }),
    (err) => {
      assert.match(err.message, /Example Author/, 'the refusal must name WHICH person');
      assert.equal(err.editorial, true, 'and be said as itself, not replaced by "please try again"');
      return true;
    },
  );
});
