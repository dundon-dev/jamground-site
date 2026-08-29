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

test('unordered list maps back with nested items', () => {
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
  assert.deepEqual(wpBlockToContractBlock(block), {
    type: 'list',
    ordered: true,
    items: [{ text: 'top', list: { ordered: false, items: [{ text: 'nested' }] } }],
  });
});

test('a block outside the four in-scope types throws, naming itself', () => {
  const markup = serialize([createBlock('core/code', { content: 'x = 1' })]);
  const [block] = parse(markup);
  assert.throws(() => wpBlockToContractBlock(block), /unmapped block "core\/code"/);
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
// fails, jamground-deploy never flips a failed build, and the editor's only signal is a staging
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
