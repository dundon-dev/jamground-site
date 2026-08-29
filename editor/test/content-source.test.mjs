import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPosts } from '../lib/content-source.mjs';
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

test('listPosts fetches tree and filters to locale posts', async () => {
  const calls = [];

  // Mock fetch that records calls and returns tree and blob responses
  const mockFetch = (url, opts) => {
    calls.push({ url, opts });

    // Tree endpoint
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/first-post.md' },
            { path: 'content/posts/en-US/second-post.md' },
            { path: 'content/posts/fr-FR/french-post.md' },
            { path: 'content/pages/about.md' },
            { path: 'content/authors/john.md' },
            { path: 'nav.md' },
            { path: 'settings.yml' },
            { path: 'README.md' },
            { path: 'other.txt' },
            { path: 'content/posts/es-ES/spanish-post.md' },
          ],
        }),
      });
    }

    // Blob endpoint for first post
    if (url === blobUrl('content/posts/en-US/first-post.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('# First Post\n\nContent here.'),
      });
    }

    // Blob endpoint for second post
    if (url === blobUrl('content/posts/en-US/second-post.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('# Second Post\n\nMore content.'),
      });
    }

    // Unknown URL
    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  const result = await listPosts(mockFetch, 'en-US');

  // Should have called tree endpoint first
  assert.equal(calls[0].url, TREE_URL);

  // Should have called blob endpoints for the two en-US posts
  assert.equal(calls[1].url, blobUrl('content/posts/en-US/first-post.md'));
  assert.equal(calls[2].url, blobUrl('content/posts/en-US/second-post.md'));

  // Should have exactly 3 calls (tree + 2 blobs)
  assert.equal(calls.length, 3);

  // Verify no Authorization header was sent
  calls.forEach((call) => {
    if (call.opts && call.opts.headers) {
      assert(!call.opts.headers.Authorization, 'Authorization header should not be sent');
      assert(!call.opts.headers.authorization, 'authorization header should not be sent');
    }
  });

  // Result should have 2 posts with path and bytes
  assert.equal(result.length, 2);
  assert.equal(result[0].path, 'content/posts/en-US/first-post.md');
  assert.equal(typeof result[0].bytes, 'object');
  assert.equal(result[1].path, 'content/posts/en-US/second-post.md');
  assert.equal(typeof result[1].bytes, 'object');
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
