// Negative test: invalid content refuses to boot
// The import pipeline validates all posts before importing any.
// A single invalid post causes the entire import to fail (wholesale rejection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePost } from '../lib/entity.mjs';
import { listPosts } from '../lib/content-source.mjs';
import { CONTENT_BLOB_BASE, CONTENT_TREE_URL } from '../config.mjs';

/* Every `url === …` below is MOCK DISPATCH, not an assertion: it decides which canned
 * response the fake fetch hands back. Derived from the fork's own configuration rather
 * than written out, because a dispatch that no longer matches what content-source.mjs
 * actually requests falls through to the 404 branch — and a 404 for everything is a state
 * several tests in this file are written to accept, so a stale literal here would not fail
 * loudly. It would just stop testing the thing it names. */
const TREE_URL = CONTENT_TREE_URL;
const blobUrl = (path) => `${CONTENT_BLOB_BASE}/${path}`;

// Valid seed posts
const VALID_POST_1 = `---
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

const VALID_POST_2 = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JF
translationOf: 01M0BSHSG62QD33PKX3GRRXX5X
locale: en-US
slug: test-post-2
title: Test Post 2
status: draft
updatedAt: '2026-08-02T10:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1D
excerpt: A brief excerpt
tags:
  - technology
  - testing
related:
  - 01M0BSHNK661FD6Y2JPMH75A1E
---

Another test post with more content.
This one has tags and a related post.
`;

// Invalid post: missing required author field
const INVALID_POST_NO_AUTHOR = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JG
translationOf: 01M0BSHSG62QD33PKX3GRRXX5Y
locale: en-US
slug: test-post-3
title: Test Post 3
status: published
publishedAt: '2026-08-03T09:00:00Z'
updatedAt: '2026-08-03T09:00:00Z'
---

Content without author.
`;

// Invalid post: published status without publishedAt
const INVALID_POST_NO_PUBLISHED_AT = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JH
translationOf: 01M0BSHSG62QD33PKX3GRRXX5Z
locale: en-US
slug: test-post-4
title: Test Post 4
status: published
updatedAt: '2026-08-04T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1E
---

Content without publishedAt.
`;

// Invalid post: missing frontmatter fence
const INVALID_POST_NO_FENCE = `id: 01M0BSHTFEWS6VYC4XBR52R3JI
translationOf: 01M0BSHSG62QD33PKX3GRRXX6A
locale: en-US
slug: test-post-5
title: Test Post 5
---

Content with missing opening fence.
`;

/**
 * Import posts using listPosts and parsePost.
 * Validates all posts before importing any.
 * Refuses to import if any post is invalid (wholesale rejection).
 *
 * @param {Function} fetchImpl - Injected fetch implementation
 * @param {string} locale - Locale code
 * @returns {Promise<Array>} - Array of validated posts
 * @throws {Error} - If any post is invalid or fetch fails
 */
async function importPosts(fetchImpl, locale) {
  const posts = await listPosts(fetchImpl, locale);

  // Validate all posts first before importing any
  const validated = [];
  for (const post of posts) {
    const decoder = new TextDecoder();
    const content = decoder.decode(post.bytes);
    // Parse and validate - will throw if invalid
    const parsed = parsePost(post.path, content);
    validated.push(parsed);
  }

  // Only return validated posts if all were valid
  return validated;
}

test('importPosts validates control posts successfully', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/post1.md' },
            { path: 'content/posts/en-US/post2.md' },
          ],
        }),
      });
    }

    if (url === blobUrl('content/posts/en-US/post1.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_1),
      });
    }

    if (url === blobUrl('content/posts/en-US/post2.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_2),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  const result = await importPosts(mockFetch, 'en-US');

  assert.equal(result.length, 2);
  assert.equal(result[0].frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JE');
  assert.equal(result[1].frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JF');
});

test('importPosts throws when post lacks required author field', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/valid.md' },
            { path: 'content/posts/en-US/invalid.md' },
          ],
        }),
      });
    }

    if (url === blobUrl('content/posts/en-US/valid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_1),
      });
    }

    if (url === blobUrl('content/posts/en-US/invalid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(INVALID_POST_NO_AUTHOR),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  await assert.rejects(
    () => importPosts(mockFetch, 'en-US'),
    /content\/posts\/en-US\/invalid\.md/
  );
});

test('importPosts throws when published post lacks publishedAt', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/valid.md' },
            { path: 'content/posts/en-US/invalid.md' },
          ],
        }),
      });
    }

    if (url === blobUrl('content/posts/en-US/valid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_1),
      });
    }

    if (url === blobUrl('content/posts/en-US/invalid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(INVALID_POST_NO_PUBLISHED_AT),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  await assert.rejects(
    () => importPosts(mockFetch, 'en-US'),
    /content\/posts\/en-US\/invalid\.md/
  );
});

test('importPosts throws when frontmatter fence is missing', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/valid.md' },
            { path: 'content/posts/en-US/invalid.md' },
          ],
        }),
      });
    }

    if (url === blobUrl('content/posts/en-US/valid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_1),
      });
    }

    if (url === blobUrl('content/posts/en-US/invalid.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(INVALID_POST_NO_FENCE),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  await assert.rejects(
    () => importPosts(mockFetch, 'en-US'),
    /content\/posts\/en-US\/invalid\.md/
  );
});

test('importPosts refuses to boot when any entity is invalid (wholesale rejection)', async () => {
  const mockFetch = (url) => {
    if (url === TREE_URL) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'content/posts/en-US/post1.md' },
            { path: 'content/posts/en-US/post2.md' },
            { path: 'content/posts/en-US/post3.md' },
          ],
        }),
      });
    }

    if (url === blobUrl('content/posts/en-US/post1.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_1),
      });
    }

    if (url === blobUrl('content/posts/en-US/post2.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(VALID_POST_2),
      });
    }

    if (url === blobUrl('content/posts/en-US/post3.md')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(INVALID_POST_NO_AUTHOR),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
    });
  };

  // Should throw before any posts are imported
  await assert.rejects(
    () => importPosts(mockFetch, 'en-US'),
    /content\/posts\/en-US\/post3\.md/
  );
});
