// Test read-posts: the reverse of import.mjs's client.run({ code }) round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPosts } from '../lib/read-posts.mjs';

const SOURCE_1 = `---
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

Original content.
`;

// A page: a whole YAML document with no fence, whose `blocks` field IS the contract block
// list. Everything below that reads a row has to work for this as well as for the post above,
// with no second code path — that is what the uniform entity shape buys.
const SOURCE_PAGE = `id: 01M0BSHTFEWS6VYC4XBR52R3JG
translationOf: 01M0BSHSG62QD33PKX3GRRXX5Y
locale: en-US
slug: about
title: About
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
blocks:
  - type: paragraph
    text: Original content.
`;

// Every fixture below carries the four meta values import.mjs writes plus WordPress's own
// post_type, because readPosts now cross-checks three of them against each other. A fixture
// that omitted one would be asserting against a row import.mjs could not have produced.
const postRow = (over = {}) => ({
  id: 7,
  content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
  title: 'Test Post 1',
  slug: 'test-post-1',
  postType: 'post',
  ...over,
  meta: {
    _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JE',
    _jamground_source: SOURCE_1,
    _jamground_path: 'content/posts/en-US/test-post-1.md',
    _jamground_kind: 'post',
    ...(over.meta || {}),
  },
});

// A fake Playground client: writeFile records what was written, run records the code it was
// asked to execute and answers with the fixture rows below, the same shape a real
// `get_posts()` + `get_post_meta()` PHP script would echo as JSON.
function fakeClient(rows) {
  const calls = { writeFile: [], run: [] };
  return {
    calls,
    documentRoot: Promise.resolve('/wordpress'),
    async writeFile(path, content) {
      calls.writeFile.push({ path, content });
    },
    async run({ code }) {
      calls.run.push(code);
      return { text: JSON.stringify(rows) };
    },
  };
}

test('readPosts writes the post types and the PHP reader, then runs it, in that order', async () => {
  const client = fakeClient([]);
  await readPosts({ client });
  assert.equal(client.calls.writeFile.length, 2);

  // The post types travel as DATA, exactly as import.mjs's own values do — nothing composes
  // PHP around a value here.
  assert.equal(client.calls.writeFile[0].path, '/wordpress/jp-read-posts-types.json');
  assert.deepEqual(JSON.parse(client.calls.writeFile[0].content), ['post', 'page']);

  assert.equal(client.calls.writeFile[1].path, '/wordpress/jp-read-posts.php');
  assert.match(client.calls.writeFile[1].content, /get_posts/);

  // Never 'any': that would sweep in WordPress's own registered types and its revisions.
  assert.doesNotMatch(client.calls.writeFile[1].content, /'post_type'\s*=>\s*'any'/);
  // And the meta_query is still the filter that keeps non-Jamground rows out — it is now the
  // ONLY one, since `page` is a type WordPress seeds content into as well.
  assert.match(client.calls.writeFile[1].content, /_jamground_id/);

  assert.equal(client.calls.run.length, 1);
  assert.match(client.calls.run[0], /jp-read-posts\.php/);
});

test('readPosts shapes each row for changed-files.mjs / change.mjs', async () => {
  const client = fakeClient([postRow()]);

  const posts = await readPosts({ client });
  assert.equal(posts.length, 1);
  const [post] = posts;

  assert.equal(post.id, 7);
  assert.equal(post.content, '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->');
  // The top-level `slug` is the BASELINE's, never `row.slug` — changed-files.mjs / change.mjs
  // pass it on as `previousSlug`, "the slug the file on disk currently has" (export.mjs).
  assert.equal(post.slug, 'test-post-1');
  assert.equal(post.meta._jamground_id, '01M0BSHTFEWS6VYC4XBR52R3JE');
  assert.equal(post.meta._jamground_source, SOURCE_1);

  // Most of frontmatter is reconstructed from the stored baseline, not re-derived or left
  // absent — getChangedFiles throws without it.
  assert.equal(post.frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JE');
  assert.equal(post.frontmatter.status, 'published');
  assert.equal(post.frontmatter.author, '01M0BSHNK661FD6Y2JPMH75A1C');

  // The kind rides on the row, so changed-files.mjs / change.mjs choose a serialiser by it
  // rather than re-deriving one from the path they are about to write to.
  assert.equal(post.kind, 'post');
});

test('readPosts carries title from post_title, never the stored baseline', async () => {
  const client = fakeClient([postRow({ title: 'A New Headline' })]);

  const [post] = await readPosts({ client });

  // SOURCE_1's baseline title is 'Test Post 1'; wp-admin's post_title has diverged from it,
  // and the frontmatter handed to export must carry the typed headline, not the baseline's.
  assert.equal(post.frontmatter.title, 'A New Headline');
});

test('readPosts carries slug from post_name for export, but keeps the baseline slug at the top level', async () => {
  const client = fakeClient([postRow({ slug: 'a-new-slug' })]);

  const [post] = await readPosts({ client });

  // frontmatter.slug is the NEW value export.mjs writes; the top-level slug stays the
  // baseline's so changed-files.mjs / change.mjs can pass it on as `previousSlug` and let
  // export.mjs's own comparison decide whether `slugHistory` grows.
  assert.equal(post.frontmatter.slug, 'a-new-slug');
  assert.equal(post.slug, 'test-post-1');
});

test('readPosts throws naming the post when _jamground_source is missing', async () => {
  const client = fakeClient([
    {
      id: 9,
      content: '<!-- wp:paragraph --><p>No baseline.</p><!-- /wp:paragraph -->',
      slug: 'no-baseline',
      meta: { _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JF', _jamground_source: '' },
    },
  ]);

  await assert.rejects(
    () => readPosts({ client }),
    /post 9.*lacks _jamground_source/s
  );
});

test('readPosts returns an empty array when nothing has been imported', async () => {
  const client = fakeClient([]);
  const posts = await readPosts({ client });
  assert.deepEqual(posts, []);
});

// --- pages ------------------------------------------------------------------------------
//
// The same code path, over a row whose baseline is a whole YAML document rather than a fenced
// markdown file. `post_title` and `post_name` are laid over the envelope identically; the
// `blocks` field is NOT part of the envelope, because the blocks that get written are the ones
// the editor just produced, never the ones on disk.

test('readPosts shapes a page row the same way, with the envelope only', async () => {
  const client = fakeClient([{
    id: 11,
    content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
    title: 'About',
    slug: 'about',
    postType: 'page',
    meta: {
      _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JG',
      _jamground_source: SOURCE_PAGE,
      _jamground_path: 'content/pages/en-US/about.yaml',
      _jamground_kind: 'page',
    },
  }]);

  const [page] = await readPosts({ client });

  assert.equal(page.kind, 'page');
  assert.equal(page.id, 11);
  assert.equal(page.slug, 'about');
  assert.equal(page.frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JG');
  assert.equal(page.frontmatter.title, 'About');
  assert.equal(page.frontmatter.status, 'published');
  assert.equal(
    page.frontmatter.blocks, undefined,
    'the envelope handed to export must NOT carry the blocks on disk — export writes the ones the editor produced',
  );
});

test('readPosts carries a page title from post_title too, with no second code path', async () => {
  const client = fakeClient([{
    id: 11,
    content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
    title: 'A New Page Headline',
    slug: 'a-new-page-slug',
    postType: 'page',
    meta: {
      _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JG',
      _jamground_source: SOURCE_PAGE,
      _jamground_path: 'content/pages/en-US/about.yaml',
      _jamground_kind: 'page',
    },
  }]);

  const [page] = await readPosts({ client });
  assert.equal(page.frontmatter.title, 'A New Page Headline');
  assert.equal(page.frontmatter.slug, 'a-new-page-slug');
  assert.equal(page.slug, 'about', 'the top-level slug stays the baseline\'s, for previousSlug');
});

// --- the three-way cross-check ------------------------------------------------------------
//
// `_jamground_kind` (declared at import), the kind the `_jamground_path` implies, and the kind
// WordPress's own `post_type` maps to must all agree. Any disagreement means the next step
// would pick a serialiser by one of them while the file on disk is the other — a page written
// back out as fenced markdown, which destroys it. Same shape as the `_jamground_source` guard,
// and for the same reason: there is no safe way to proceed on a guess.

test('readPosts throws when _jamground_kind disagrees with the path', async () => {
  const client = fakeClient([{
    id: 11,
    content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
    title: 'About',
    slug: 'about',
    postType: 'page',
    meta: {
      _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JG',
      _jamground_source: SOURCE_PAGE,
      _jamground_path: 'content/pages/en-US/about.yaml',
      _jamground_kind: 'post',
    },
  }]);

  await assert.rejects(() => readPosts({ client }), (err) => {
    assert.match(err.message, /post 11/);
    assert.match(err.message, /_jamground_kind says "post"/);
    assert.match(err.message, /_jamground_path .*implies "page"/);
    assert.match(err.message, /post_type "page" implies "page"/);
    return true;
  }, 'all three readings must be named, not just the one that lost');
});

test('readPosts throws when WordPress post_type disagrees with the declared kind', async () => {
  const client = fakeClient([postRow({ postType: 'page' })]);

  await assert.rejects(() => readPosts({ client }), (err) => {
    assert.match(err.message, /_jamground_kind says "post"/);
    assert.match(err.message, /post_type "page" implies "page"/);
    return true;
  });
});

test('readPosts throws when _jamground_kind is missing altogether', async () => {
  const client = fakeClient([postRow({ meta: { _jamground_kind: '' } })]);

  await assert.rejects(
    () => readPosts({ client }),
    /_jamground_kind says ""/,
    'a row with no declared kind is not silently inferred from its path',
  );
});
