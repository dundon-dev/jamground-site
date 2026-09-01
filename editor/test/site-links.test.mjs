// site-links.mjs: the addresses wp-admin's own links point at.
//
// The assertion this file exists for is the FIRST one: every path the map holds is equal to
// calling src/lib/links.ts's own helper. That module states that it holds the routing table
// exactly once, and this is what makes the claim testable from the editor side — it fails the
// moment anyone reintroduces path construction in site-links.mjs, in kinds.mjs, or in PHP.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSiteLinks, SITE_LINKS_FILE } from '../lib/site-links.mjs';
import { pathForPage, pathForPost, pathForAuthor, pathForHome } from '../../src/lib/links.ts';

const LOCALE = 'en-US';

// readPosts()-shaped rows: `id` is WordPress's own post id, `slug` is the baseline (on-disk)
// slug, and `frontmatter` carries the envelope the baseline was parsed from.
const row = (id, kind, slug, status = 'published') => ({
  id,
  kind,
  slug,
  content: '',
  frontmatter: { locale: LOCALE, slug, status, title: `entity ${id}` },
  meta: {},
});

const ROWS = [
  row(4, 'page', 'pricing'),
  row(5, 'page', 'home'),
  row(7, 'post', 'launch'),
  row(9, 'author', 'ada-lovelace'),
];

test('every path equals src/lib/links.ts, including the home special case', () => {
  const { byPostId } = buildSiteLinks({ posts: ROWS, origin: 'https://example.com', includeDrafts: false });

  assert.equal(byPostId['4'], pathForPage(LOCALE, 'pricing'));
  assert.equal(byPostId['7'], pathForPost(LOCALE, 'launch'));
  assert.equal(byPostId['9'], pathForAuthor(LOCALE, 'ada-lovelace'));

  // `slug: 'home'` routes to the locale root, and that fact lives in pathForPage — not here,
  // and not in the mu-plugin. Asserted against the helper rather than against a literal so
  // this test cannot become the second place the special case is written down.
  assert.equal(byPostId['5'], pathForPage(LOCALE, 'home'));
  assert.notEqual(pathForPage(LOCALE, 'home'), pathForPage(LOCALE, 'pricing'));
});

test('the front page address comes from pathForHome, and is empty with no rows to ask', () => {
  const withRows = buildSiteLinks({ posts: ROWS, origin: 'https://example.com', includeDrafts: false });
  assert.equal(withRows.homePath, pathForHome(LOCALE));

  // No rows means no locale to ask about; the mu-plugin removes the node rather than guessing.
  const empty = buildSiteLinks({ posts: [], origin: 'https://example.com', includeDrafts: false });
  assert.equal(empty.homePath, '');
  assert.deepEqual(empty.byPostId, {});
});

test('all-draft content still has a front page address', () => {
  // REGRESSION. The locale was read after the draft filter, so a content set with no published
  // entity produced `homePath: ''` — and the mu-plugin reads an empty homePath as "no address",
  // which removed the site name from the admin bar. The front page's address is a function of
  // the locale alone; whether any individual entity is published has nothing to do with it.
  const drafts = [row(4, 'page', 'pricing', 'draft'), row(7, 'post', 'launch', 'draft')];

  const production = buildSiteLinks({ posts: drafts, origin: 'https://example.com', includeDrafts: false });
  assert.equal(production.homePath, pathForHome(LOCALE));
  assert.deepEqual(production.byPostId, {}, 'and still no address for any draft entity itself');
});

test('a draft has an address on a preview and none on the published site', () => {
  const posts = [row(4, 'page', 'pricing'), row(11, 'page', 'unfinished', 'draft')];

  const preview = buildSiteLinks({ posts, origin: 'https://pr-42.preview.example.com', includeDrafts: true });
  assert.equal(preview.byPostId['11'], pathForPage(LOCALE, 'unfinished'));

  // The production build excludes drafts, so there is no address anywhere for this entity and
  // the map must not invent one — the mu-plugin reads an absent entry as "remove the link".
  const production = buildSiteLinks({ posts, origin: 'https://example.com', includeDrafts: false });
  assert.equal(production.byPostId['11'], undefined);
  assert.equal(production.byPostId['4'], pathForPage(LOCALE, 'pricing'));
});

test('the baseline slug is used, never the possibly-unsaved one WordPress holds', () => {
  // readPosts returns both on purpose: `frontmatter.slug` is WordPress's current value, the
  // top-level `slug` is what the file on disk has. The preview serves the latter, so a
  // link built from the former would point at an address that does not answer yet.
  const renamed = {
    ...row(4, 'page', 'pricing'),
    frontmatter: { locale: LOCALE, slug: 'pricing-v2', status: 'published', title: 'Pricing' },
  };
  const { byPostId } = buildSiteLinks({ posts: [renamed], origin: 'https://example.com', includeDrafts: false });
  assert.equal(byPostId['4'], pathForPage(LOCALE, 'pricing'));
});

test('an unknown kind is named rather than silently dropped', () => {
  assert.throws(
    () => buildSiteLinks({ posts: [row(4, 'navigation', 'main')], origin: 'https://example.com', includeDrafts: true }),
    /no kind row for "navigation"/,
  );
});

test('an absent origin throws: there is no relative address out of wp-admin', () => {
  assert.throws(() => buildSiteLinks({ posts: ROWS, origin: '', includeDrafts: false }), /origin is required/);
});

test('what reaches PHP is data with no logic in it', () => {
  const links = buildSiteLinks({ posts: ROWS, origin: 'https://example.com/', includeDrafts: false });
  const parsed = JSON.parse(JSON.stringify(links));

  assert.deepEqual(Object.keys(parsed).sort(), ['byPostId', 'homePath', 'origin']);
  for (const [id, path] of Object.entries(parsed.byPostId)) {
    assert.match(id, /^[0-9]+$/, 'keys are WordPress post ids');
    assert.equal(typeof path, 'string');
    assert.match(path, /^\/.*\/$/, 'a root-relative path with both slashes, as links.ts promises');
  }
  assert.equal(SITE_LINKS_FILE, 'jp-site-links.json');
});
