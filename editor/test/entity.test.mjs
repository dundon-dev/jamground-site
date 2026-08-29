// Test entity parsing and validation
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntity, parsePost } from '../lib/entity.mjs';

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

// The next two are facts about the POST FORMAT — a `.md` file whose envelope is fenced — and
// must never become facts about content in general. A page has no fence to miss; see the page
// companions at the end of this file.
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

// --- pages -------------------------------------------------------------------------------
//
// A page is a whole YAML document: no fence, no body, and its `blocks` field IS the contract
// block list. The fence splitter above is now the post kind's own parser and is unreachable
// from here, which is the point — "Missing frontmatter fence" was never true of a page, and
// while one parser served every kind there was no way to say so.

const VALID_PAGE = `id: 01M0BSHTFEWS6VYC4XBR52R3JG
translationOf: 01M0BSHSG62QD33PKX3GRRXX5Y
locale: en-US
slug: about
title: About
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
blocks:
  - type: heading
    level: 2
    text: About us
  - type: paragraph
    text: Some words.
`;

test('parseEntity parses a fenceless .yaml page', () => {
  const result = parseEntity('page', '/content/pages/en-US/about.yaml', VALID_PAGE);
  assert.equal(result.kind, 'page');
  assert.equal(result.body, '', 'a page has no body following its envelope');
  assert.equal(result.source, VALID_PAGE);
});

test('parseEntity lifts a page\'s blocks out of the envelope', () => {
  const result = parseEntity('page', '/content/pages/en-US/about.yaml', VALID_PAGE);

  // `frontmatter` means the same thing for both kinds — the envelope, and only the envelope —
  // which is what lets read-posts.mjs lay post_title/post_name over it with one code path.
  assert.deepEqual(result.frontmatter, {
    id: '01M0BSHTFEWS6VYC4XBR52R3JG',
    translationOf: '01M0BSHSG62QD33PKX3GRRXX5Y',
    locale: 'en-US',
    slug: 'about',
    title: 'About',
    status: 'published',
    publishedAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-01T09:00:00Z',
  });
  assert.deepEqual(result.blocks, [
    { type: 'heading', level: 2, text: 'About us' },
    { type: 'paragraph', text: 'Some words.' },
  ]);
});

test('parseEntity refuses a page with no blocks, naming the file', () => {
  const empty = VALID_PAGE.replace(/blocks:[\s\S]*$/, 'blocks: []\n');
  assert.throws(
    () => parseEntity('page', '/content/pages/en-US/empty.yaml', empty),
    /Schema validation failed for \/content\/pages\/en-US\/empty\.yaml.*blocks/s,
  );
});

// --- authors -----------------------------------------------------------------------------
//
// An author is a whole YAML document like a page, and NOT a document like a page: `Author` has
// no `blocks` field, so `parseEntity`'s `const { blocks, ...frontmatter }` finds nothing to
// lift and the whole file is the envelope plus the author's own fields. Nothing here is a new
// code path — that is the claim being made.

const VALID_AUTHOR = `id: 01M143VMBG3P9TE12W2BQ3SWX8
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

test('parseEntity parses a fenceless .yaml author, and never asks it for a fence', () => {
  const result = parseEntity('author', '/content/authors/en-US/example.yaml', VALID_AUTHOR);

  assert.equal(result.kind, 'author');
  assert.equal(result.body, '', 'an author has no body following its envelope');
  assert.equal(result.source, VALID_AUTHOR);

  // The fence splitter is the POST kind's parser and is unreachable from here. Asserted as
  // the absence of that specific error rather than merely "it did not throw", because
  // "Missing frontmatter fence" is exactly what a single shared parser used to say about
  // every `.yaml` file it was handed.
  assert.doesNotThrow(() => parseEntity('author', '/content/authors/en-US/example.yaml', VALID_AUTHOR));
});

test('parseEntity gives an author no blocks at all, and keeps its own fields on the envelope', () => {
  const result = parseEntity('author', '/content/authors/en-US/example.yaml', VALID_AUTHOR);

  // `Author` has no `blocks` field, so the destructure finds none — the same `undefined` a
  // post gets, and the reason `toBlocks: () => []` is the whole of an author's canvas.
  assert.equal(result.blocks, undefined, 'an author is not a document and carries no blocks');

  // `name`, `role` and `bio` are not edited in wp-admin yet. They stay on the frontmatter,
  // which is what export writes back out untouched — a field dropped here would be a field
  // deleted from the repository on the first save.
  assert.deepEqual(result.frontmatter, {
    id: '01M143VMBG3P9TE12W2BQ3SWX8',
    translationOf: '01M143VNARFS53GN4MRZ48TMJ9',
    locale: 'en-US',
    slug: 'example-author',
    title: 'Example Author',
    status: 'published',
    publishedAt: '2026-08-28T12:00:00Z',
    updatedAt: '2026-08-28T12:00:00Z',
    name: 'Example Author',
    role: 'Editor',
    bio: 'Writes and edits the example content used to demonstrate this repository.',
  });
});

test('parseEntity refuses an author with no name, naming the file', () => {
  const nameless = VALID_AUTHOR.replace(/^name: .*$/m, 'name: \'\'');
  assert.throws(
    () => parseEntity('author', '/content/authors/en-US/nameless.yaml', nameless),
    /Schema validation failed for \/content\/authors\/en-US\/nameless\.yaml.*name/s,
  );
});

test('parseEntity refuses an unknown kind rather than guessing one', () => {
  // The unknown kind used to be spelled 'author', which stopped being unknown the moment
  // authors were added — the assertion is about a kind NOBODY declared, so it needs a name
  // no row claims. `navigation` is the next thing in the content repository that has no kind,
  // and if a row ever claims it this test says so instead of passing on a stale example.
  assert.throws(
    () => parseEntity('navigation', '/content/navigation/en-US/primary.yaml', VALID_PAGE),
    /unknown content kind "navigation"/,
  );
});
