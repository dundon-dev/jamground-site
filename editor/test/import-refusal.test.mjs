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
