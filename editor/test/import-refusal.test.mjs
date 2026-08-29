// A post whose blocks do not survive the round trip is held back, by name, and the rest still
// import. Before this existed the same condition threw out of importPosts, was caught in
// entry.mjs, logged to the console, and boot continued to jamgroundReady — so an ordinary post
// containing a code fence produced a fully-working, completely EMPTY wp-admin with no explanation.
//
// The refusal is enforced by ABSENCE: a held-back entity never reaches wp_insert_post, so it has
// no _jamground_id, so read-posts.mjs's meta_query cannot see it, so save cannot write it. These
// tests assert the absence, not a flag.
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const { importPosts } = await import('../lib/import.mjs');
const { exportEntity } = await import('../lib/export.mjs');
const { blocksToMarkup } = await import('../lib/blocks-to-wp.mjs');
const { parseEntity } = await import('../lib/entity.mjs');
const api = { createBlock, serialize, parse, getBlockType };

const envelope = (id, slug, title) => [
  '---',
  `id: ${id}`,
  'translationOf: 01M16P85G0EWFHCEP57ZD9ZTNF',
  'locale: en-US',
  `slug: ${slug}`,
  `title: ${title}`,
  'status: published',
  "publishedAt: '2026-08-28T12:00:00Z'",
  "updatedAt: '2026-08-28T12:00:00Z'",
  'author: 01M16P86F841TCW9P3TQWBBXFM',
  '---',
  '',
  '',
].join('\n');

const PLAIN = envelope('01M16P87EGDWE51YHVFG9H24VP', 'plain', 'A plain post') + 'Just a paragraph.\n';
// A fenced code block: mdast-to-blocks maps it to a `code` block, which blocks-to-wp does not yet
// build. This is not hypothetical — it is what ships today.
const FENCED = envelope('01M16P88DR31ZM6TH700HGVPMV', 'fenced', 'A post with code') + 'Intro.\n\n```\nconst x = 1;\n```\n';

function harness(files) {
  const written = {};
  const client = {
    documentRoot: Promise.resolve('/wordpress'),
    writeFile: async (p, c) => { written[p] = c; },
    run: async () => {
      const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
      return { text: JSON.stringify(Object.fromEntries(entries.map((e, i) => [e.contractId, 100 + i]))) };
    },
  };
  const fetchImpl = async (url) => {
    if (url.includes('/git/trees/')) {
      return { ok: true, json: async () => ({ tree: files.map(([path]) => ({ path })) }) };
    }
    const hit = files.find(([path]) => url.endsWith(path));
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(hit[1]).buffer };
  };
  return { client, fetchImpl, written };
}

test('a post that does not survive the round trip is held back, and the rest still import', async () => {
  const { client, fetchImpl, written } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/posts/en-US/fenced.md', FENCED],
  ]);

  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });

  assert.equal(result.refused.length, 1, 'exactly the unsupported post is held back');
  assert.equal(result.refused[0].path, 'content/posts/en-US/fenced.md');
  assert.equal(result.refused[0].title, 'A post with code', 'the editor is told WHICH content, by its title');
  assert.match(result.refused[0].reason, /code/, 'and why, naming the block type');

  // Enforced by absence: the refused entity is not in what WordPress is asked to create.
  const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
  assert.deepEqual(entries.map((e) => e.slug), ['plain'],
    'a held-back entity must never reach wp_insert_post — that absence is what stops save writing it');
  assert.equal(Object.keys(result.map).length, 1, 'and it gets no id in the session map');
});

test('when everything round-trips, nothing is held back', async () => {
  const { client, fetchImpl } = harness([['content/posts/en-US/plain.md', PLAIN]]);
  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });
  assert.deepEqual(result.refused, [], 'a clean import refuses nothing');
  assert.equal(Object.keys(result.map).length, 1);
});

test('a schema-invalid entity still refuses WHOLESALE — a broken repository is not a held-back file', async () => {
  const BROKEN = '---\nid: not-a-ulid\n---\n\nBody.\n';
  const { client, fetchImpl } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/posts/en-US/broken.md', BROKEN],
  ]);
  await assert.rejects(
    () => importPosts({ client, api, fetchImpl, locale: 'en-US' }),
    /broken\.md/,
    'schema-invalid means the content itself is wrong; that must not degrade to a per-entity skip',
  );
});

// --- pages -------------------------------------------------------------------------------
//
// The admission check is per KIND as well as per entity: a page's blocks are the contract's
// already, so it is exported through `write(x, Page)` and compared against a whole YAML
// document with no fence. Running the check through the post kind would compare a page against
// fenced markdown and refuse every page there is — which would look exactly like the mappers
// being unfinished, and be a defect in this file instead.

const pageEnvelope = (id, slug, title) => [
  `id: ${id}`,
  'translationOf: 01M16P85G0EWFHCEP57ZD9ZTNF',
  'locale: en-US',
  `slug: ${slug}`,
  `title: ${title}`,
  'status: published',
  "publishedAt: '2026-08-28T12:00:00Z'",
  "updatedAt: '2026-08-28T12:00:00Z'",
  'blocks:',
  '',
].join('\n');

const PLAIN_PAGE = pageEnvelope('01M16P89CTGH1B6R7ZP0K1QYVX', 'about', 'An ordinary page')
  + '  - type: heading\n    level: 2\n    text: About us\n  - type: paragraph\n    text: Some words.\n';

// A separator: a contract block type blocks-to-wp.mjs does not yet build. Held back for the
// same reason a post with a code fence is, and by the same machinery.
const RULED_PAGE = pageEnvelope('01M16P8ABGP5X0MFHZ2QW8N4TR', 'ruled', 'A page with a rule')
  + '  - type: paragraph\n    text: Above.\n  - type: separator\n  - type: paragraph\n    text: Below.\n';

test('a page that round-trips is imported, as a page', async () => {
  const { client, fetchImpl, written } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/pages/en-US/about.yaml', PLAIN_PAGE],
  ]);

  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });

  assert.deepEqual(result.refused, [], 'a page of heading and paragraph survives its own round trip');
  assert.equal(Object.keys(result.map).length, 2, 'both the post and the page get a WordPress row');

  const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
  const bySlug = Object.fromEntries(entries.map((e) => [e.slug, e]));

  // The post type and the declared kind travel as DATA in the JSON file, never interpolated
  // into the PHP — and they are the page's own, not the post's.
  assert.equal(bySlug.about.kind, 'page');
  assert.equal(bySlug.about.postType, 'page');
  assert.equal(bySlug.about.path, 'content/pages/en-US/about.yaml');
  assert.equal(bySlug.plain.kind, 'post');
  assert.equal(bySlug.plain.postType, 'post');

  // `_jamground_source` is the fetched bytes verbatim — for a page, a fenceless YAML document.
  assert.equal(bySlug.about.source, PLAIN_PAGE);
  assert.equal(bySlug.about.source.startsWith('---'), false);

  // The importer reads both values out of the entry rather than composing PHP around them.
  const php = written['/wordpress/jp-import.php'];
  assert.match(php, /'post_type'\s*=>\s*\$entry\['postType'\]/);
  assert.match(php, /'_jamground_kind'\s*=>\s*\$entry\['kind'\]/);
});

test('a page whose blocks do not survive the round trip is held back, and the rest still import', async () => {
  const { client, fetchImpl, written } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/pages/en-US/about.yaml', PLAIN_PAGE],
    ['content/pages/en-US/ruled.yaml', RULED_PAGE],
  ]);

  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });

  assert.equal(result.refused.length, 1, 'exactly the page with an unsupported block is held back');
  assert.equal(result.refused[0].path, 'content/pages/en-US/ruled.yaml');
  assert.equal(result.refused[0].title, 'A page with a rule', 'the editor is told WHICH content, by its title');
  assert.match(result.refused[0].reason, /separator/, 'and why, naming the block type');

  // Enforced by absence, exactly as for a post: no row, so no _jamground_id, so read-posts
  // cannot see it, so save cannot write it.
  const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
  assert.deepEqual(entries.map((e) => e.slug).sort(), ['about', 'plain']);
  assert.equal(Object.keys(result.map).length, 2);
});


// --- authors -----------------------------------------------------------------------------
//
// A third kind through the same admission check, and the first one that is not a document at
// all. `Author` has no `blocks` field, so the whole file is the envelope, `toBlocks` is `[]`
// and the row's `post_content` is the empty string. The check is unchanged; what it compares
// against is `write(frontmatter, Author)`.

const authorFile = (id, slug, title, extra = '') => [
  `id: ${id}`,
  'translationOf: 01M16P85G0EWFHCEP57ZD9ZTNF',
  'locale: en-US',
  `slug: ${slug}`,
  `title: ${title}`,
  'status: published',
  "publishedAt: '2026-08-28T12:00:00Z'",
  "updatedAt: '2026-08-28T12:00:00Z'",
  `name: ${title}`,
  'role: Editor',
  'bio: Writes the example content.',
].join('\n') + '\n' + extra;

const PLAIN_AUTHOR = authorFile('01M16P8BF5ZQ2W7DTKX6M3RNH4', 'example-author', 'Example Author');

// The same author, carrying a body. `Author` is not `.strict()`, so zod STRIPS the unknown
// `blocks` key and the file parses — which is exactly the silent-loss shape this whole check
// exists for: nothing complains, and the first save writes the file back without it. The
// round trip is what notices, because the bytes it produces no longer match the bytes it read.
const BODIED_AUTHOR = authorFile('01M16P8CDPBQ8V1KYNW3T5FJ2Z', 'bodied-author', 'A Bodied Author',
  'blocks:\n  - type: paragraph\n    text: Nowhere to keep this.\n');

test('an author imports as an author, and its body is empty', async () => {
  const { client, fetchImpl, written } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/authors/en-US/example.yaml', PLAIN_AUTHOR],
  ]);

  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });

  assert.deepEqual(result.refused, [], 'an author with no blocks survives its own round trip');
  assert.equal(Object.keys(result.map).length, 2);

  const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
  const bySlug = Object.fromEntries(entries.map((e) => [e.slug, e]));

  assert.equal(bySlug['example-author'].kind, 'author');
  assert.equal(bySlug['example-author'].postType, 'jamground_author',
    'an author is filed under its own WordPress type, which is what puts it in its own menu');
  assert.equal(bySlug['example-author'].path, 'content/authors/en-US/example.yaml');
  assert.equal(bySlug['example-author'].title, 'Example Author');

  // THE POINT OF THE KIND: no body. `blocksToMarkup(api, [])` is the empty string, so the row
  // WordPress is asked to create carries no `post_content` at all.
  assert.equal(bySlug['example-author'].content, '',
    'an author is not a document — its post_content must be empty, not a canvas of blocks');

  // And the fetched bytes verbatim, fenceless, as for a page.
  assert.equal(bySlug['example-author'].source, PLAIN_AUTHOR);
  assert.equal(bySlug['example-author'].source.startsWith('---'), false);
});

test('an author carrying a body is held back by name, and the rest still import', async () => {
  const { client, fetchImpl, written } = harness([
    ['content/posts/en-US/plain.md', PLAIN],
    ['content/authors/en-US/example.yaml', PLAIN_AUTHOR],
    ['content/authors/en-US/bodied.yaml', BODIED_AUTHOR],
  ]);

  const result = await importPosts({ client, api, fetchImpl, locale: 'en-US' });

  assert.equal(result.refused.length, 1, 'exactly the author whose file would be rewritten is held back');
  assert.equal(result.refused[0].path, 'content/authors/en-US/bodied.yaml');
  assert.equal(result.refused[0].title, 'A Bodied Author', 'the editor is told WHICH person, by name');
  assert.match(result.refused[0].reason, /read and written back unchanged/,
    'and why: importing it would silently drop what the file carries');

  // Enforced by absence: no row, so no _jamground_id, so read-posts cannot see it, so save
  // cannot write it — which is what stops the body being deleted from the repository.
  const entries = JSON.parse(written['/wordpress/jp-import-data.json']);
  assert.deepEqual(entries.map((e) => e.slug).sort(), ['example-author', 'plain']);
  assert.equal(Object.keys(result.map).length, 2);
});

test('an author whose post_content is not empty is refused at export, naming the person', async () => {
  // The other end of the same fact, on the SAVE path. Nothing in wp-admin can put a block on
  // an author this stage — the post type supports `title` alone — but the serialiser is the
  // last thing between a body and the file, and `write(frontmatter, Author)` has nowhere to
  // put one. Dropping it would be the silent loss; refusing names the person instead.
  const { frontmatter } = parseEntity('author', 'content/authors/en-US/example.yaml', PLAIN_AUTHOR);
  const markup = blocksToMarkup(api, [{ type: 'paragraph', text: 'Typed onto the canvas.' }]);
  assert.notEqual(markup, '', 'the fixture must actually carry a body, or this asserts nothing');

  assert.throws(
    () => exportEntity({
      kind: 'author',
      api,
      markup,
      frontmatter,
      previousSlug: frontmatter.slug,
      updatedAt: frontmatter.updatedAt,
    }),
    (err) => {
      assert.match(err.message, /Example Author/, 'the refusal must name WHICH person');
      assert.equal(err.editorial, true, 'said as itself, not replaced by "please try again"');
      return true;
    },
  );
});
