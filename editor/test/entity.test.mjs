// Test entity parsing and validation
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePost } from '../lib/entity.mjs';

// Valid seed post 1
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

// Valid seed post 2 (draft with optional publishedAt)
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

test('parsePost returns frontmatter, body, and unchanged source', () => {
  const result = parsePost('/content/posts/en-US/test.md', VALID_POST_1);
  assert.deepEqual(result.frontmatter, {
    id: '01M0BSHTFEWS6VYC4XBR52R3JE',
    translationOf: '01M0BSHSG62QD33PKX3GRRXX5W',
    locale: 'en-US',
    slug: 'test-post-1',
    title: 'Test Post 1',
    status: 'published',
    publishedAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-01T09:00:00Z',
    author: '01M0BSHNK661FD6Y2JPMH75A1C',
  });
  assert.equal(result.body, 'Test content for post 1.\n');
  assert.equal(result.source, VALID_POST_1);
});

test('parsePost handles seed post 1 with all required fields', () => {
  const result = parsePost('/content/posts/en-US/post1.md', VALID_POST_1);
  assert(result.frontmatter);
  assert.equal(result.frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JE');
  assert.equal(result.frontmatter.status, 'published');
  assert.equal(result.frontmatter.author, '01M0BSHNK661FD6Y2JPMH75A1C');
});

test('parsePost handles seed post 2 with optional fields', () => {
  const result = parsePost('/content/posts/en-US/post2.md', VALID_POST_2);
  assert(result.frontmatter);
  assert.equal(result.frontmatter.id, '01M0BSHTFEWS6VYC4XBR52R3JF');
  assert.equal(result.frontmatter.status, 'draft');
  assert.equal(result.frontmatter.excerpt, 'A brief excerpt');
  assert.deepEqual(result.frontmatter.tags, ['technology', 'testing']);
  assert.deepEqual(result.frontmatter.related, ['01M0BSHNK661FD6Y2JPMH75A1E']);
});

test('parsePost throws on missing opening fence', () => {
  const nofence = `id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
---

Body content`;
  assert.throws(
    () => parsePost('/content/posts/en-US/nofence.md', nofence),
    /Missing frontmatter fence/
  );
});

test('parsePost throws on missing closing fence', () => {
  const unclosed = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test
title: Test

Body without closing fence`;
  assert.throws(
    () => parsePost('/content/posts/en-US/unclosed.md', unclosed),
    /Missing closing frontmatter fence/
  );
});

test('parsePost throws on invalid YAML in frontmatter', () => {
  const badYaml = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: [unclosed bracket
---

Body content`;
  assert.throws(
    () => parsePost('/content/posts/en-US/badyaml.md', badYaml),
    /Invalid YAML/
  );
});

test('parsePost throws on schema validation failure: missing required author field', () => {
  const noAuthor = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test
title: Test Post
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
---

Body without author`;
  assert.throws(
    () => parsePost('/content/posts/en-US/noauthor.md', noAuthor),
    /Schema validation failed/
  );
});

test('parsePost throws on schema validation failure: published without publishedAt', () => {
  const noPublishedAt = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test
title: Test Post
status: published
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
---

Body without publishedAt`;
  assert.throws(
    () => parsePost('/content/posts/en-US/nopublishedat.md', noPublishedAt),
    /Schema validation failed/
  );
});

test('parsePost throws on schema validation failure: invalid status value', () => {
  const badStatus = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test
title: Test Post
status: archived
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
---

Body with invalid status`;
  assert.throws(
    () => parsePost('/content/posts/en-US/badstatus.md', badStatus),
    /Schema validation failed/
  );
});

test('parsePost includes path in error message on validation failure', () => {
  const noAuthor = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test
title: Test
status: draft
updatedAt: '2026-08-01T09:00:00Z'
---

No author field`;
  const path = '/content/posts/en-US/specific-file.md';
  assert.throws(
    () => parsePost(path, noAuthor),
    new RegExp(path)
  );
});
