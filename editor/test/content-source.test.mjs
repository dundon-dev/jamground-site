import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEntities, listPosts } from '../lib/content-source.mjs';
import { CONTENT_BLOB_BASE, CONTENT_BRANCH, CONTENT_REPO, CONTENT_TREE_URL } from '../config.mjs';

/* The two endpoints, derived from the fork's own declaration rather than spelled out — a
 * mock that dispatches on a literal URL stops matching the moment a fork changes its org,
 * and a mock that stops matching answers 404 to everything, which this file's own
 * "throws on tree fetch 404" test would happily go green on. Deriving keeps the mock
 * honest for any fork.
 *
 * Derivation alone would be circular, so the shapes are asserted first, once, below: a
 * config that produced a nonsense URL would otherwise be agreed with by both sides. */
const TREE_URL = CONTENT_TREE_URL;
const blobUrl = (path) => `${CONTENT_BLOB_BASE}/${path}`;

test('the endpoints the content source reads are the two public GitHub ones, for this fork', () => {
  const tree = new URL(TREE_URL);
  assert.equal(tree.protocol, 'https:');
  assert.equal(tree.host, 'api.github.com');
  assert.equal(tree.pathname, `/repos/${CONTENT_REPO}/git/trees/${CONTENT_BRANCH}`);
  assert.equal(tree.searchParams.get('recursive'), '1');

  const blob = new URL(blobUrl('content/posts/en-US/x.md'));
  assert.equal(blob.protocol, 'https:');
  assert.equal(blob.host, 'raw.githubusercontent.com');
  assert.equal(blob.pathname, `/${CONTENT_REPO}/${CONTENT_BRANCH}/content/posts/en-US/x.md`);

  // `org/repo`, both halves non-empty — the one shape a mistyped config gets wrong quietly.
  assert.match(CONTENT_REPO, /^[^/\s]+\/[^/\s]+$/);
});

/* The tree this fork actually has a shape like, with one entry per exclusion the filter is
 * meant to make and one per kind it is meant to admit.
 *
 * Pages used to sit in the excluded half of this fixture — as `content/pages/about.md`, which
 * is not even the extension a page has. That pinned a SCOPE BOUNDARY ("the editor only loads
 * posts") as though it were a principle, and the boundary was the defect: the two pages are
 * most of the live site. What is a principle, and what stays asserted below, is the shape of
 * the exclusions — another locale, a directory no kind claims, a file at the repository root —
 * plus one that only exists once a kind has an extension of its own: the right directory with
 * the wrong extension.
 */
const TREE = [
  { path: 'content/posts/en-US/first-post.md' },     // in: post
  { path: 'content/posts/en-US/second-post.md' },    // in: post
  { path: 'content/pages/en-US/home.yaml' },         // in: page
  { path: 'content/pages/en-US/about.yaml' },        // in: page
  { path: 'content/posts/fr-FR/french-post.md' },    // out: another locale
  { path: 'content/pages/fr-FR/accueil.yaml' },      // out: another locale
  { path: 'content/pages/en-US/notes.md' },          // out: pages are .yaml, not .md
  { path: 'content/posts/en-US/notes.yaml' },        // out: posts are .md, not .yaml
  { path: 'content/authors/en-US/john.yaml' },       // out: no kind claims authors yet
  { path: 'content/navigation/en-US/primary.yaml' }, // out: not a document
  { path: 'content/settings/site.yaml' },            // out: not a document
  { path: 'nav.md' },                                // out: repository root
  { path: 'settings.yml' },                          // out: repository root
  { path: 'README.md' },                             // out: repository root
  { path: 'other.txt' },                             // out: repository root
  { path: 'content/posts/es-ES/spanish-post.md' },   // out: another locale
];

const ADMITTED = [
  ['post', 'content/posts/en-US/first-post.md'],
  ['post', 'content/posts/en-US/second-post.md'],
  ['page', 'content/pages/en-US/home.yaml'],
  ['page', 'content/pages/en-US/about.yaml'],
];

function treeFetch(calls) {
  return (url, opts) => {
    calls.push({ url, opts });

    if (url === TREE_URL) {
      return Promise.resolve({ ok: true, json: async () => ({ tree: TREE }) });
    }

    const hit = ADMITTED.find(([, path]) => url === blobUrl(path));
    if (hit) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(`bytes of ${hit[1]}`),
      });
    }

    // Anything the filter should not have asked for answers 404, so a widened filter fails
    // loudly here rather than quietly fetching more than it should.
    return Promise.resolve({ ok: false, status: 404 });
  };
}

test('listEntities fetches the tree and filters to this locale\'s posts AND pages', async () => {
  const calls = [];
  const result = await listEntities(treeFetch(calls), 'en-US');

  // Tree first, then one blob per admitted entity, in the tree's own order.
  assert.equal(calls[0].url, TREE_URL);
  assert.deepEqual(
    calls.slice(1).map((c) => c.url),
    ADMITTED.map(([, path]) => blobUrl(path)),
  );
  assert.equal(calls.length, ADMITTED.length + 1, 'tree plus exactly one blob per admitted entity');

  // Verify no Authorization header was sent
  calls.forEach((call) => {
    if (call.opts && call.opts.headers) {
      assert(!call.opts.headers.Authorization, 'Authorization header should not be sent');
      assert(!call.opts.headers.authorization, 'authorization header should not be sent');
    }
  });

  // THE KIND COMES OFF THE TREE AND TRAVELS WITH THE BYTES. Nothing downstream re-derives it,
  // so nothing downstream can derive it differently.
  assert.deepEqual(result.map(({ kind, path }) => [kind, path]), ADMITTED);
  result.forEach((entity) => assert.equal(typeof entity.bytes, 'object'));
});

test('listPosts still narrows to posts alone', async () => {
  const calls = [];
  const result = await listPosts(treeFetch(calls), 'en-US');

  assert.deepEqual(
    result.map(({ kind, path }) => [kind, path]),
    ADMITTED.filter(([kind]) => kind === 'post'),
  );
  assert.equal(calls.length, 3, 'tree plus the two posts — no page blob is fetched');
});

test('listPosts throws on tree fetch 404', async () => {
  const mockFetch = (url) => {
    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  await assert.rejects(
    () => listPosts(mockFetch, 'en-US'),
    /404.*https:\/\/api\.github\.com/,
  );
});

test('listPosts throws on blob fetch 404', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [{ path: 'content/posts/en-US/post.md' }],
        }),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  await assert.rejects(
    () => listPosts(mockFetch, 'en-US'),
    /404.*https:\/\/raw\.githubusercontent\.com/,
  );
});
