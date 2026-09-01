// Test the export path: block markup -> a contract post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — see blocks-to-wp.test.mjs for why.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const {
  wpBlockToContractBlock, markupToContractBlocks, markupToBody, exportPost, exportEntity,
} = await import('../lib/export.mjs');
const { VOCAB } = await import('../lib/vocabulary.mjs');

const api = { createBlock, serialize, parse, getBlockType };

const FRONTMATTER = {
  id: '01M0BSHTFEWS6VYC4XBR52R3JE',
  translationOf: '01M0BSHSG62QD33PKX3GRRXX5W',
  locale: 'en-US',
  slug: 'test-post-1',
  title: 'Test Post 1',
  status: 'published',
  publishedAt: '2026-08-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
  author: '01M0BSHNK661FD6Y2JPMH75A1C',
};

test('paragraph block maps back to a contract paragraph', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'A paragraph with <strong>bold</strong>.' })]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'paragraph', text: 'A paragraph with **bold**.' });
});

test('heading block carries its level', () => {
  const markup = serialize([createBlock('core/heading', { level: 3, content: 'A heading' })]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'heading', level: 3, text: 'A heading' });
});

test('quote block carries text and citation, HTML-unescaped', () => {
  const markup = serialize([
    createBlock('core/quote', { citation: 'Sales &amp; Marketing &lt;team&gt;' }, [
      createBlock('core/paragraph', { content: 'A quoted line.' }),
    ]),
  ]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), {
    type: 'quote', text: 'A quoted line.', citation: 'Sales & Marketing <team>',
  });
});

test('quote block with no citation omits the field', () => {
  const markup = serialize([
    createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'A quoted line.' })]),
  ]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'quote', text: 'A quoted line.' });
});

// The nested list is the interesting half: it OMITS `ordered` rather than carrying `false`.
// `List.ordered` is `.optional()` and `false` is core/list's registered default, so writing the
// key would materialise an absent optional and the page would fail import.mjs's byte comparison —
// see the three-form fixtures in roundtrip.test.mjs. The outer list keeps `ordered: true`, which
// is information.
test('a list maps back with nested items, and an unordered one omits `ordered` entirely', () => {
  const markup = serialize([
    createBlock('core/list', { ordered: true }, [
      createBlock('core/list-item', { content: 'top' }, [
        createBlock('core/list', {}, [
          createBlock('core/list-item', { content: 'nested' }),
        ]),
      ]),
    ]),
  ]);
  const [block] = parse(markup);
  const mapped = wpBlockToContractBlock(block);
  assert.deepEqual(mapped, {
    type: 'list',
    ordered: true,
    items: [{ text: 'top', list: { items: [{ text: 'nested' }] } }],
  });
  // deepEqual would pass on an `ordered: undefined` key, which the canonical writer treats
  // differently from an absent one. Assert the key is not there at all.
  assert.equal('ordered' in mapped.items[0].list, false);
});

test('code block maps back to PLAIN TEXT — the marks in a sample are not read as marks', () => {
  // THE TRAP. `Code.text` is a bare `z.string()`, and `core/code`'s `content` is HTML-escaped
  // plain text. Sending it through `htmlAttrToText` (the InlineText path every other content
  // attribute takes) would read `<strong>` as a mark and hand back `**bold**` — the sample
  // rewritten. It goes through `unescHtml` instead, which is the exact reverse of what
  // `blocks-to-wp.mjs` applied.
  const sample = 'if (a < b && c) { return "**not bold**"; }';
  const esc = sample
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const markup = serialize([createBlock('core/code', { content: esc })]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'code', text: sample });
});

test('code block containing real inline HTML keeps it as text, not as marks', () => {
  // A code sample that IS `<strong>bold</strong>`. Through `htmlAttrToText` this would come
  // back as `**bold**`; through `unescHtml` it stays the four-tag sample it is.
  const markup = serialize([
    createBlock('core/code', { content: '&lt;strong&gt;bold&lt;/strong&gt;' }),
  ]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'code', text: '<strong>bold</strong>' });
});

test('an empty code block maps back to an empty string, not a dropped block', () => {
  const markup = serialize([createBlock('core/code', { content: '' })]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'code', text: '' });
});

test('table block maps back, one head row flattened to cells and the body to rows', () => {
  const markup = serialize([createBlock('core/table', {
    head: [{ cells: [{ content: 'Plan', tag: 'th' }, { content: 'Price', tag: 'th' }] }],
    body: [
      { cells: [{ content: 'Starter', tag: 'td' }, { content: '$0', tag: 'td' }] },
      { cells: [{ content: '<strong>Pro</strong>', tag: 'td' }, { content: '$9', tag: 'td' }] },
    ],
  })]);
  const [block] = parse(markup);
  // `htmlAttrToText` runs PER CELL, so a cell's marks come back as canonical InlineText.
  assert.deepEqual(wpBlockToContractBlock(block), {
    type: 'table',
    head: ['Plan', 'Price'],
    rows: [['Starter', '$0'], ['**Pro**', '$9']],
  });
});

test('a table with no header row is refused, not given an empty one', () => {
  const markup = serialize([createBlock('core/table', {
    head: [], body: [{ cells: [{ content: 'a', tag: 'td' }] }],
  })]);
  const [block] = parse(markup);
  assert.throws(() => wpBlockToContractBlock(block), /exactly one header row, found 0/);
});

test('a table with two header rows is refused rather than flattened into one', () => {
  const markup = serialize([createBlock('core/table', {
    head: [
      { cells: [{ content: 'a', tag: 'th' }] },
      { cells: [{ content: 'b', tag: 'th' }] },
    ],
    body: [{ cells: [{ content: 'c', tag: 'td' }] }],
  })]);
  const [block] = parse(markup);
  assert.throws(() => wpBlockToContractBlock(block), /exactly one header row, found 2/);
});

test('a table with no body rows is refused — Table.rows is .min(1)', () => {
  const markup = serialize([createBlock('core/table', {
    head: [{ cells: [{ content: 'a', tag: 'th' }] }], body: [],
  })]);
  const [block] = parse(markup);
  assert.throws(() => wpBlockToContractBlock(block), /at least one body row/);
});

test('separator block maps back to the bare contract separator', () => {
  const markup = serialize([createBlock('core/separator', {})]);
  const [block] = parse(markup);
  assert.deepEqual(wpBlockToContractBlock(block), { type: 'separator' });
});

// The `default:` arm, asserted with a block that is permanently outside the allowlist —
// `core/columns` has no contract representation and is not going to acquire one — so that
// finishing another block type cannot invalidate this test the way finishing `core/code`
// invalidated its previous form. What is being asserted is the arm, not the example.
test('a block outside the in-scope types throws, naming itself', () => {
  const markup = serialize([createBlock('core/columns', {})]);
  const [block] = parse(markup);
  assert.throws(() => wpBlockToContractBlock(block), /unmapped block "core\/columns"/);
});

test('markupToBody emits a fence, a table and a rule in canonical markdown', () => {
  const markup = serialize([
    createBlock('core/code', { content: 'const x = 1;' }),
    createBlock('core/table', {
      head: [{ cells: [{ content: 'Plan', tag: 'th' }, { content: 'Price', tag: 'th' }] }],
      body: [{ cells: [{ content: 'Starter', tag: 'td' }, { content: '$0', tag: 'td' }] }],
    }),
    createBlock('core/separator', {}),
    createBlock('core/paragraph', { content: 'After.' }),
  ]);
  assert.equal(markupToBody(api, markup), [
    '```',
    'const x = 1;',
    '```',
    '',
    '| Plan    | Price |',
    '| ------- | ----- |',
    '| Starter | $0    |',
    '',
    '---',
    '',
    'After.',
    '',
  ].join('\n'));
});

test('markupToContractBlocks refuses a non-contract attribute before mapping runs', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'hi', textColor: 'vivid-red' })]);
  assert.throws(() => markupToContractBlocks(api, markup), /textColor/);
});

test('markupToContractBlocks maps a whole tree of in-scope blocks', () => {
  const markup = serialize([
    createBlock('core/heading', { level: 2, content: 'A heading' }),
    createBlock('core/paragraph', { content: 'A paragraph.' }),
  ]);
  assert.deepEqual(markupToContractBlocks(api, markup), [
    { type: 'heading', level: 2, text: 'A heading' },
    { type: 'paragraph', text: 'A paragraph.' },
  ]);
});

test('markupToBody produces canonical markdown for the seed-post shape', () => {
  const markup = serialize([
    createBlock('core/heading', { level: 2, content: 'A heading' }),
    createBlock('core/paragraph', { content: 'A paragraph with <strong>bold</strong> and <em>italic</em>.' }),
    createBlock('core/quote', {}, [createBlock('core/paragraph', { content: 'A quote.' })]),
  ]);
  const body = markupToBody(api, markup);
  assert.equal(body, [
    '## A heading',
    '',
    'A paragraph with **bold** and _italic_.',
    '',
    '> A quote.',
    '',
  ].join('\n'));
});

test('exportPost preserves id, stamps updatedAt, and appends slugHistory on a slug change', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Updated body.' })]);
  const file = exportPost({
    api, markup,
    frontmatter: { ...FRONTMATTER, slug: 'test-post-1-renamed' },
    previousSlug: 'test-post-1',
    updatedAt: '2026-08-20T12:00:00Z',
  });

  assert.match(file, /^---\n/);
  assert.match(file, /id: 01M0BSHTFEWS6VYC4XBR52R3JE\n/);
  assert.match(file, /slug: test-post-1-renamed\n/);
  assert.match(file, /slugHistory:\n\s+- test-post-1\n/);
  assert.match(file, /updatedAt: '2026-08-20T12:00:00Z'\n/);
  assert.match(file, /---\n\nUpdated body\.\n$/);
});

test('exportPost omits slugHistory when the slug is unchanged', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Body.' })]);
  const file = exportPost({
    api, markup,
    frontmatter: FRONTMATTER,
    previousSlug: 'test-post-1',
    updatedAt: '2026-08-20T12:00:00Z',
  });

  assert.doesNotMatch(file, /slugHistory/);
});

test('exportPost carries forward a pre-existing slugHistory and appends to it', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Body.' })]);
  const file = exportPost({
    api, markup,
    frontmatter: { ...FRONTMATTER, slug: 'third-slug', slugHistory: ['first-slug'] },
    previousSlug: 'second-slug',
    updatedAt: '2026-08-20T12:00:00Z',
  });

  assert.match(file, /slugHistory:\n\s+- first-slug\n\s+- second-slug\n/);
});

test('exportPost throws on a block the attribute guard refuses, before writing anything', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'hi', align: 'wide' })]);
  assert.throws(() => exportPost({
    api, markup, frontmatter: FRONTMATTER, previousSlug: FRONTMATTER.slug,
    updatedAt: '2026-08-20T12:00:00Z',
  }), /align/);
});

// --- pages -------------------------------------------------------------------------------

const PAGE_FRONTMATTER = {
  id: '01M143VEG04JRXAX5JYES4JXZ0',
  translationOf: '01M143VFF8TN0D6FNX3S6M5T49',
  locale: 'en-US',
  slug: 'home',
  title: 'Home',
  status: 'published',
  publishedAt: '2026-08-28T12:00:00Z',
  updatedAt: '2026-08-28T12:00:00Z',
};

test('exportEntity refuses an unknown kind rather than defaulting to post', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Body.' })]);
  assert.throws(
    () => exportEntity({
      kind: undefined, api, markup, frontmatter: FRONTMATTER,
      previousSlug: FRONTMATTER.slug, updatedAt: '2026-08-20T12:00:00Z',
    }),
    /unknown content kind undefined/,
    'a lost kind must stop here — guessing "post" would write a page out as fenced markdown',
  );
});

test('exportEntity writes a page as a whole YAML document, with blocks last and no fence', () => {
  const markup = serialize([
    createBlock('core/heading', { level: 2, content: 'Welcome' }),
    createBlock('core/paragraph', { content: 'Hello.' }),
  ]);
  const file = exportEntity({
    kind: 'page', api, markup,
    frontmatter: PAGE_FRONTMATTER,
    previousSlug: 'home',
    updatedAt: '2026-08-28T12:00:00Z',
  });

  assert.equal(file.startsWith('---'), false, 'a page carries no frontmatter fence');
  assert.equal(file, [
    'id: 01M143VEG04JRXAX5JYES4JXZ0',
    'translationOf: 01M143VFF8TN0D6FNX3S6M5T49',
    'locale: en-US',
    'slug: home',
    'title: Home',
    'status: published',
    "publishedAt: '2026-08-28T12:00:00Z'",
    "updatedAt: '2026-08-28T12:00:00Z'",
    'blocks:',
    '  - type: heading',
    '    level: 2',
    '    text: Welcome',
    '  - type: paragraph',
    '    text: Hello.',
    '',
  ].join('\n'));
});

// THE HOMEPAGE HAZARD. `src/pages/[locale]/index.astro` selects the front page by
// `slug === 'home'` and `[slug].astro` excludes that slug from the ordinary routes, so renaming
// the home page in wp-admin does not move the homepage — it REMOVES it. read-posts.mjs takes
// the slug straight from `post_name`, so the rename reaches export intact; the build then
// fails, jamground-deploy never flips a failed build, and the editor's only signal is a preview
// site that never appears. Refusing here is where they can see it.
test('exportEntity refuses to rename the home page, in editorial language', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Hello.' })]);
  assert.throws(
    () => exportEntity({
      kind: 'page', api, markup,
      frontmatter: { ...PAGE_FRONTMATTER, slug: 'welcome' },
      previousSlug: 'home',
      updatedAt: '2026-08-28T12:00:00Z',
    }),
    (err) => {
      assert.equal(err.message, VOCAB.homePageAddressFixed);
      assert.equal(err.editorial, true, 'marked so the shell says it instead of "please try again"');
      assert.doesNotMatch(err.message, /branch|commit|merge|rebase|pull request/i);
      return true;
    },
  );
});

test('exportEntity allows renaming any OTHER page', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Hello.' })]);
  const file = exportEntity({
    kind: 'page', api, markup,
    frontmatter: { ...PAGE_FRONTMATTER, slug: 'about-us' },
    previousSlug: 'about',
    updatedAt: '2026-08-28T12:00:00Z',
  });
  assert.match(file, /slug: about-us\n/);
  assert.match(file, /slugHistory:\n\s+- about\n/);
});

test('exportEntity allows a page that is ALREADY not the home page to keep its slug', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Hello.' })]);
  const file = exportEntity({
    kind: 'page', api, markup,
    frontmatter: { ...PAGE_FRONTMATTER, slug: 'about' },
    previousSlug: 'about',
    updatedAt: '2026-08-28T12:00:00Z',
  });
  assert.match(file, /slug: about\n/);
});

// `Page.blocks` is `.min(1)`. Without this, deleting every block on a page reaches the
// canonical writer as `Too small`, surfaces as "save did not complete — please try again", and
// never works however many times they try.
test('exportEntity refuses an emptied page with something true and actionable', () => {
  assert.throws(
    () => exportEntity({
      kind: 'page', api, markup: '',
      frontmatter: PAGE_FRONTMATTER,
      previousSlug: 'home',
      updatedAt: '2026-08-28T12:00:00Z',
    }),
    (err) => {
      assert.equal(err.message, VOCAB.pageNeedsContent);
      assert.equal(err.editorial, true);
      assert.doesNotMatch(err.message, /Too small/, 'never the schema library\'s own wording');
      return true;
    },
  );
});
