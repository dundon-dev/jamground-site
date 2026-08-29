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

test('readPosts writes the PHP reader then runs it, in that order', async () => {
  const client = fakeClient([]);
  await readPosts({ client });
  assert.equal(client.calls.writeFile.length, 1);
  assert.equal(client.calls.writeFile[0].path, '/wordpress/jp-read-posts.php');
  assert.match(client.calls.writeFile[0].content, /get_posts/);
  assert.equal(client.calls.run.length, 1);
  assert.match(client.calls.run[0], /jp-read-posts\.php/);
});

test('readPosts shapes each row for changed-files.mjs / change.mjs', async () => {
  const client = fakeClient([
    {
      id: 7,
      content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
      title: 'Test Post 1',
      slug: 'test-post-1',
      meta: { _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JE', _jamground_source: SOURCE_1 },
    },
  ]);

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
});

test('readPosts carries title from post_title, never the stored baseline', async () => {
  const client = fakeClient([
    {
      id: 7,
      content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
      title: 'A New Headline',
      slug: 'test-post-1',
      meta: { _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JE', _jamground_source: SOURCE_1 },
    },
  ]);

  const [post] = await readPosts({ client });

  // SOURCE_1's baseline title is 'Test Post 1'; wp-admin's post_title has diverged from it,
  // and the frontmatter handed to export must carry the typed headline, not the baseline's.
  assert.equal(post.frontmatter.title, 'A New Headline');
});

test('readPosts carries slug from post_name for export, but keeps the baseline slug at the top level', async () => {
  const client = fakeClient([
    {
      id: 7,
      content: '<!-- wp:paragraph --><p>Original content.</p><!-- /wp:paragraph -->',
      title: 'Test Post 1',
      slug: 'a-new-slug',
      meta: { _jamground_id: '01M0BSHTFEWS6VYC4XBR52R3JE', _jamground_source: SOURCE_1 },
    },
  ]);

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
