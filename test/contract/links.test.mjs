// Contract test for reference resolution (src/lib/links.ts).
//
// The defect this module exists to fix shipped live: the homepage emitted
// `<a class="jp-cta__link" href="01M0BSHSG62QD33PKX3GRRXX5V">`, a bare translation-group
// ULID, which the browser resolved against /en-us/ and 404'd. Everything below is either the
// routing table it now goes through, or one of the ways resolution is required to fail loudly
// rather than emit something a browser will quietly mis-resolve.
//
// No build, no Astro, no content on disk — buildLinkIndex takes plain arrays on purpose, so
// every fixture here is an object literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLinkIndex,
  linkContext,
  hrefFor,
  resolveLink,
  resolveBlockLinks,
  navHref,
  hrefForRoute,
  pathForHome,
  pathForPage,
  pathForBlogIndex,
  pathForPost,
  pathForAuthor,
  pathForTag,
  LinkResolutionError,
} from '../../src/lib/links.ts';

const GROUP_HOME = '01J8Z9GRP0000000000000HOME';
const GROUP_PRICING = '01J8Z9GRP00000000000PRICING';
const GROUP_POST = '01J8Z9GRP0000000000000POST';
// Two more POSTS, in groups of their own. Reusing GROUP_POST for either would change what
// 'a group with no member in the referring locale' reports as `members:` and break it from a
// distance — the group is the key, so a second member is never a free addition.
const GROUP_POST_DE = '01J8Z9GRP00000000000POSTDE';
const GROUP_POST_FR = '01J8Z9GRP00000000000POSTFR';
const GROUP_AUTHOR = '01J8Z9GRP000000000000AUTH0';
const GROUP_DRAFT = '01J8Z9GRP00000000000DRAFT0';
const GROUP_ABSENT = '01J8Z9GRP000000000000NONE0';

const entity = (over) => ({
  id: '01J8Z9X2K3M4N5P6Q7R8S9T0V1',
  translationOf: GROUP_HOME,
  locale: 'en-US',
  slug: 'home',
  status: 'published',
  ...over,
});

function fixture() {
  return buildLinkIndex({
    pages: [
      entity({ translationOf: GROUP_HOME, slug: 'home', id: '01J8Z9PAGE000000000000HOME' }),
      entity({ translationOf: GROUP_PRICING, slug: 'pricing', id: '01J8Z9PAGE00000000000PRIC' }),
      entity({
        translationOf: GROUP_DRAFT,
        slug: 'roadmap',
        status: 'draft',
        id: '01J8Z9PAGE0000000000DRAFT',
      }),
      // The same pricing group in a second locale, to prove the locale is part of the key.
      entity({
        translationOf: GROUP_PRICING,
        slug: 'preise',
        locale: 'de-DE',
        id: '01J8Z9PAGE00000000000DEDE',
      }),
    ],
    posts: [
      entity({ translationOf: GROUP_POST, slug: 'launch', id: '01J8Z9POST000000000000LNCH' }),
      // A published post in a second locale, so the blog index exists there too.
      entity({
        translationOf: GROUP_POST_DE,
        slug: 'start',
        locale: 'de-DE',
        id: '01J8Z9POST000000000000DEDE',
      }),
      // A locale whose ONLY post is a draft: its blog index exists in a preview build and does
      // not exist in production, which is the whole of the route-target drafts policy.
      entity({
        translationOf: GROUP_POST_FR,
        slug: 'brouillon',
        locale: 'fr-FR',
        status: 'draft',
        id: '01J8Z9POST000000000000FRFR',
      }),
    ],
    authors: [
      entity({ translationOf: GROUP_AUTHOR, slug: 'example-author', id: '01J8Z9AUTH00000000000SDUN' }),
    ],
  });
}

const from = (over = {}) => ({
  collection: 'pages',
  id: '01J8Z9PAGE000000000000HOME',
  slug: 'home',
  locale: 'en-US',
  status: 'published',
  ...over,
});

const ctx = (over = {}, includeDrafts = false) => linkContext(fixture(), from(over), includeDrafts);

// ---- The normative routing table -------------------------------------------------------

test('the six route shapes match 05 §Routing', () => {
  assert.equal(pathForHome('en-US'), '/en-us/');
  assert.equal(pathForPage('en-US', 'pricing'), '/en-us/pricing/');
  assert.equal(pathForBlogIndex('en-US'), '/en-us/blog/');
  assert.equal(pathForPost('en-US', 'launch'), '/en-us/blog/launch/');
  assert.equal(pathForAuthor('en-US', 'example-author'), '/en-us/authors/example-author/');
  assert.equal(pathForTag('en-US', 'launch'), '/en-us/tags/launch/');
});

test("a page with slug 'home' routes to the locale root, not /home/", () => {
  assert.equal(pathForPage('en-US', 'home'), '/en-us/');
});

test('every path is root-relative and ends in a slash (trailingSlash: always)', () => {
  const all = [
    pathForHome('en-US'),
    pathForPage('en-US', 'pricing'),
    pathForPage('en-US', 'home'),
    pathForBlogIndex('en-US'),
    pathForPost('en-US', 'launch'),
    pathForAuthor('en-US', 'example-author'),
    pathForTag('en-US', 'launch'),
  ];
  for (const path of all) {
    assert.ok(path.startsWith('/'), `${path} must be root-relative`);
    assert.ok(path.endsWith('/'), `${path} must end in a slash`);
    // The shipped defect was a path with neither.
    assert.ok(!/^[0-9A-HJKMNP-TV-Z]{26}/.test(path.slice(1)), `${path} looks like a bare ULID`);
  }
});

test('the locale segment goes through localeToSegment, not a bare toLowerCase', () => {
  assert.equal(pathForPost('de-DE', 'start'), '/de-de/blog/start/');
  // A slug is never lowercased in passing: only the locale is transformed.
  assert.equal(pathForPage('de-DE', 'preise'), '/de-de/preise/');
});

// ---- Resolution ------------------------------------------------------------------------

test('a ref resolves to its group member in the referring locale', () => {
  assert.equal(hrefFor(ctx(), GROUP_PRICING), '/en-us/pricing/');
  assert.equal(hrefFor(ctx(), GROUP_POST), '/en-us/blog/launch/');
  assert.equal(hrefFor(ctx(), GROUP_AUTHOR), '/en-us/authors/example-author/');
  assert.equal(hrefFor(ctx(), GROUP_HOME), '/en-us/');
});

test('resolution is per-locale: the same group resolves differently from a de-DE referrer', () => {
  assert.equal(hrefFor(ctx({ locale: 'en-US' }), GROUP_PRICING), '/en-us/pricing/');
  assert.equal(
    hrefFor(ctx({ locale: 'de-DE', slug: 'startseite' }), GROUP_PRICING),
    '/de-de/preise/',
  );
});

test('a group no entity declares throws, naming the ref and the referring entity', () => {
  assert.throws(
    () => hrefFor(ctx(), GROUP_ABSENT),
    (err) => {
      assert.ok(err instanceof LinkResolutionError);
      assert.match(err.message, /INV-11/);
      assert.match(err.message, new RegExp(GROUP_ABSENT));
      assert.match(err.message, /no entity declares/);
      assert.match(err.message, /pages\/en-US\/home/);
      return true;
    },
  );
});

test('a group with no member in the referring locale throws, listing the locales it has', () => {
  assert.throws(
    () => hrefFor(ctx({ locale: 'fr-FR', slug: 'accueil' }), GROUP_POST),
    (err) => {
      assert.match(err.message, /INV-11/);
      assert.match(err.message, /no member in locale fr-FR/);
      assert.match(err.message, /members: en-US/);
      return true;
    },
  );
});

test('a draft target throws when drafts are excluded from the build', () => {
  assert.throws(
    () => hrefFor(ctx({}, false), GROUP_DRAFT),
    (err) => {
      assert.match(err.message, /is a draft and has no route in this build \(OD-28\)/);
      return true;
    },
  );
});

test('OD-28(a): a published referrer may not link to a draft even when drafts are rendered', () => {
  assert.throws(
    () => hrefFor(ctx({ status: 'published' }, true), GROUP_DRAFT),
    (err) => {
      assert.match(err.message, /OD-28/);
      assert.match(err.message, /published .*may not[\s\S]*link to a draft/);
      return true;
    },
  );
});

test('OD-28 does not forbid draft -> draft in a preview build', () => {
  assert.equal(hrefFor(ctx({ status: 'draft' }, true), GROUP_DRAFT), '/en-us/roadmap/');
});

test('two members of one group in one locale throw, naming both', () => {
  assert.throws(
    () =>
      buildLinkIndex({
        pages: [
          entity({ translationOf: GROUP_PRICING, slug: 'pricing', id: '01J8Z9PAGE0000000000000A' }),
          entity({ translationOf: GROUP_PRICING, slug: 'plans', id: '01J8Z9PAGE0000000000000B' }),
        ],
        posts: [],
        authors: [],
      }),
    (err) => {
      assert.ok(err instanceof LinkResolutionError);
      assert.match(err.message, /INV-12/);
      assert.match(err.message, /01J8Z9PAGE0000000000000A/);
      assert.match(err.message, /01J8Z9PAGE0000000000000B/);
      return true;
    },
  );
});

// ---- Navigation -------------------------------------------------------------------------

const nav = (over = {}, includeDrafts = false) =>
  linkContext(fixture(), from({ collection: 'navigation', slug: 'primary', ...over }), includeDrafts);

test('navHref passes an external href through and resolves an internal ref or route', () => {
  const c = nav();
  assert.equal(navHref(c, { label: 'Docs', href: 'https://example.org/docs' }), 'https://example.org/docs');
  assert.equal(navHref(c, { label: 'Pricing', ref: GROUP_PRICING }), '/en-us/pricing/');
  assert.equal(navHref(c, { label: 'Blog', route: 'blog' }), '/en-us/blog/');
});

test('navHref rejects an item carrying two targets or none, naming the ones it found', () => {
  const c = nav();
  assert.throws(() => navHref(c, { label: 'x' }), /exactly one of ref, route or href \(got none\)/);
  assert.throws(
    () => navHref(c, { label: 'x', ref: GROUP_PRICING, href: 'https://example.org/' }),
    /exactly one of ref, route or href \(got ref and href\)/,
  );
  assert.throws(
    () => navHref(c, { label: 'x', ref: GROUP_PRICING, route: 'blog' }),
    /exactly one of ref, route or href \(got ref and route\)/,
  );
  assert.throws(
    () => navHref(c, { label: 'x', route: 'blog', href: 'https://example.org/' }),
    /exactly one of ref, route or href \(got route and href\)/,
  );
  assert.throws(
    () => navHref(c, { label: 'x', ref: GROUP_PRICING, route: 'blog', href: 'https://example.org/' }),
    /exactly one of ref, route or href \(got ref and route and href\)/,
  );
});

// ---- Named internal routes --------------------------------------------------------------
// The blog index has no entity and therefore no translation group, so `ref` cannot reach it and
// ExternalUrl will not carry an internal path. These are the cases where the route the content
// names is not the route the build generates.

test('route: blog resolves through pathForBlogIndex, in the referring locale', () => {
  assert.equal(hrefForRoute(nav(), 'blog'), '/en-us/blog/');
  assert.equal(hrefForRoute(nav({ locale: 'de-DE', slug: 'haupt' }), 'blog'), '/de-de/blog/');
  // Not merely equal to the literal: equal to what the routing table itself produces, so the two
  // cannot drift.
  assert.equal(hrefForRoute(nav(), 'blog'), pathForBlogIndex('en-US'));
});

test('a locale with no post has no blog index, so targeting it fails the build', () => {
  assert.throws(
    () => hrefForRoute(nav({ locale: 'it-IT', slug: 'principale' }), 'blog'),
    (err) => {
      assert.ok(err instanceof LinkResolutionError);
      assert.match(err.message, /INV-11/);
      assert.match(err.message, /no post this build renders/);
      assert.match(err.message, /\(0 published, 0 draft\)/);
      assert.match(err.message, /it-IT/);
      assert.match(err.message, /\/it-it\/blog\//);
      return true;
    },
  );
});

test('a draft-only locale has no blog index when the build excludes drafts', () => {
  assert.throws(
    () => hrefForRoute(nav({ locale: 'fr-FR', slug: 'principale' }, false), 'blog'),
    (err) => {
      assert.match(err.message, /no post this build renders/);
      assert.match(err.message, /\(0 published, 1 draft\)/);
      return true;
    },
  );
});

test('OD-28: a published entity may not target a blog index only drafts create', () => {
  assert.throws(
    () => hrefForRoute(nav({ locale: 'fr-FR', slug: 'principale', status: 'published' }, true), 'blog'),
    (err) => {
      assert.match(err.message, /OD-28/);
      assert.match(err.message, /may not depend on a draft/);
      return true;
    },
  );
});

test('OD-28 allows a draft entity to target a draft-only blog index in a preview build', () => {
  assert.equal(
    hrefForRoute(nav({ locale: 'fr-FR', slug: 'principale', status: 'draft' }, true), 'blog'),
    '/fr-fr/blog/',
  );
});

test('an unknown route name throws rather than emitting href="undefined"', () => {
  assert.throws(
    () => hrefForRoute(nav(), 'tags'),
    (err) => {
      assert.ok(err instanceof LinkResolutionError);
      assert.match(err.message, /unknown internal route 'tags'/);
      assert.match(err.message, /known routes: blog/);
      return true;
    },
  );
  // A name that would reach a prototype method under a bare property lookup.
  assert.throws(() => hrefForRoute(nav(), 'constructor'), /unknown internal route 'constructor'/);
});

// ---- Block rewriting --------------------------------------------------------------------

test('resolveBlockLinks replaces ref with href on hero and cta, and drops ref entirely', () => {
  const blocks = [
    { type: 'hero', heading: 'H', cta: { label: 'See pricing', ref: GROUP_PRICING } },
    { type: 'cta', heading: 'C', link: { label: 'Read the launch post', ref: GROUP_POST } },
  ];
  const [hero, cta] = resolveBlockLinks(blocks, ctx());

  assert.deepEqual(hero, {
    type: 'hero',
    heading: 'H',
    cta: { label: 'See pricing', href: '/en-us/pricing/' },
  });
  assert.deepEqual(cta, {
    type: 'cta',
    heading: 'C',
    link: { label: 'Read the launch post', href: '/en-us/blog/launch/' },
  });
  // The point of replacing rather than augmenting: a raw group id is not representable
  // downstream, so no renderer can fall back to it.
  assert.ok(!('ref' in hero.cta));
  assert.ok(!('ref' in cta.link));
});

test('a hero with no cta survives resolution unchanged', () => {
  const [hero] = resolveBlockLinks([{ type: 'hero', heading: 'H' }], ctx());
  assert.deepEqual(hero, { type: 'hero', heading: 'H' });
  assert.ok(!('cta' in hero));
});

test('the other nine block types pass through byte-identical', () => {
  const others = [
    { type: 'paragraph', text: 'Some copy.' },
    { type: 'heading', level: 2, text: 'A heading' },
    { type: 'list', ordered: false, items: [{ text: 'One' }] },
    { type: 'image', media: { ref: 'content/media/a.jpg', alt: 'Alt' } },
    { type: 'quote', text: 'Quoted.', cite: 'Someone' },
    { type: 'code', text: 'const x = 1;' },
    { type: 'table', head: ['Plan'], rows: [['Free']] },
    { type: 'separator' },
    { type: 'featureGrid', columns: 3, items: [{ heading: 'A', body: 'a' }, { heading: 'B', body: 'b' }] },
  ];
  const out = resolveBlockLinks(others, ctx());
  assert.deepEqual(out, others);
  // Not merely equal — the same objects, so resolution cannot perturb a block it does not own.
  out.forEach((block, i) => assert.equal(block, others[i]));
});

test('resolveLink surfaces the referring entity when a block link is broken', () => {
  assert.throws(
    () => resolveBlockLinks([{ type: 'cta', heading: 'C', link: { label: 'x', ref: GROUP_ABSENT } }], ctx()),
    /INV-11.*pages\/en-US\/home/,
  );
});
