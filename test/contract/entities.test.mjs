// Contract test for the six entity schemas and the collection config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Page, Post, Author, Navigation, NavigationItem, Settings, Redirects,
} from '../../src/contract/entities.ts';

const ULID_A = '01J8Z9X2K3M4N5P6Q7R8S9T0V1';
const ULID_B = '01J8Z9GRP00000000000000GRP';
const ULID_C = '01J8Z9GRP00000000000000GRQ';
const MEDIA = { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' };

function envelope(overrides = {}) {
  return {
    id: ULID_A,
    translationOf: ULID_B,
    locale: 'en-US',
    slug: 'pricing',
    title: 'Pricing',
    status: 'published',
    publishedAt: '2026-08-17T09:00:00Z',
    updatedAt: '2026-08-17T14:22:00Z',
    ...overrides,
  };
}

// ---- Page -----------------------------------------------------------------------------------

test('Page extends the envelope with a non-empty block array (11 §3)', () => {
  const ok = Page.safeParse({ ...envelope(), blocks: [{ type: 'separator' }] });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues));
  const empty = Page.safeParse({ ...envelope(), blocks: [] });
  assert.equal(empty.success, false, 'blocks must be non-empty');
});

test('Page still enforces the envelope\'s own rules (publishedAt required when published)', () => {
  const result = Page.safeParse({
    ...envelope({ publishedAt: undefined }), blocks: [{ type: 'separator' }],
  });
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].path[0], 'publishedAt');
});

// ---- Post -----------------------------------------------------------------------------------

test('Post requires an author, referencing a translation group (11 §3)', () => {
  const missing = Post.safeParse(envelope());
  assert.equal(missing.success, false, 'author is required');
  const ok = Post.safeParse({ ...envelope(), author: ULID_C });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues));
});

test('Post.excerpt is optional and bounded to 300 characters', () => {
  const base = { ...envelope(), author: ULID_C };
  assert.equal(Post.safeParse(base).success, true, 'absent excerpt is legal');
  assert.equal(Post.safeParse({ ...base, excerpt: 'x'.repeat(300) }).success, true);
  assert.equal(Post.safeParse({ ...base, excerpt: 'x'.repeat(301) }).success, false);
  assert.equal(Post.safeParse({ ...base, excerpt: '' }).success, false, 'excerpt must be non-empty when present');
});

test('Post.tags is an optional array of Slug, and Post.related an optional array of Ulid', () => {
  const base = { ...envelope(), author: ULID_C };
  assert.equal(Post.safeParse({ ...base, tags: ['launch', 'product'] }).success, true);
  assert.equal(Post.safeParse({ ...base, tags: ['Not A Slug'] }).success, false);
  assert.equal(Post.safeParse({ ...base, related: [ULID_A, ULID_B] }).success, true);
  assert.equal(Post.safeParse({ ...base, related: ['not-a-ulid'] }).success, false);
});

// ---- Author ---------------------------------------------------------------------------------

test('Author requires a non-empty name; role, bio and avatar are optional (11 §3)', () => {
  assert.equal(Author.safeParse(envelope()).success, false, 'name is required');
  const ok = Author.safeParse({ ...envelope(), name: 'Test Author' });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues));
});

test('Author.bio is InlineText, and Author.avatar is a MediaRef', () => {
  const base = { ...envelope(), name: 'Test Author' };
  assert.equal(Author.safeParse({ ...base, bio: 'Builds **things**.' }).success, true);
  assert.equal(Author.safeParse({ ...base, bio: 'Line one\nLine two' }).success, false, 'InlineText rejects a line break');
  assert.equal(Author.safeParse({ ...base, avatar: MEDIA }).success, true);
  assert.equal(Author.safeParse({ ...base, avatar: { ref: 'not-rooted.jpg', alt: 'x' } }).success, false);
});

// ---- Navigation -----------------------------------------------------------------------------

test('a navigation item must carry exactly one of ref, route or href (11 §3)', () => {
  assert.equal(NavigationItem.safeParse({ label: 'Home', ref: ULID_A }).success, true);
  assert.equal(NavigationItem.safeParse({ label: 'Blog', route: 'blog' }).success, true);
  assert.equal(NavigationItem.safeParse({ label: 'Docs', href: 'https://example.org/' }).success, true);

  // Every pair, and all three: exactly-one is not "at least one", and a chained !== would have
  // read two of these as satisfied.
  assert.equal(NavigationItem.safeParse({ label: 'x', ref: ULID_A, href: 'https://example.org/' }).success, false);
  assert.equal(NavigationItem.safeParse({ label: 'x', ref: ULID_A, route: 'blog' }).success, false);
  assert.equal(NavigationItem.safeParse({ label: 'x', route: 'blog', href: 'https://example.org/' }).success, false);
  assert.equal(NavigationItem.safeParse({ label: 'x', ref: ULID_A, route: 'blog', href: 'https://example.org/' }).success, false);
  assert.equal(NavigationItem.safeParse({ label: 'Neither' }).success, false);
});

test('route is a closed set — an unknown route is a schema failure, not a 404 (defs.ts)', () => {
  for (const route of ['blag', 'Blog', 'blog/', '/en-us/blog/', '', 'posts', 'authors', 'tags']) {
    assert.equal(
      NavigationItem.safeParse({ label: 'x', route }).success,
      false,
      `route: ${JSON.stringify(route)} parsed, but INTERNAL_ROUTES is closed — an unknown route `
      + 'has no resolver in src/lib/links.ts and would reach a browser as a broken link',
    );
  }
});

test('a navigation item and its children stay strict — an unknown key is a defect', () => {
  assert.equal(NavigationItem.safeParse({ label: 'x', route: 'blog', target: '_blank' }).success, false);
  assert.equal(
    NavigationItem.safeParse({
      label: 'Products', ref: ULID_A, children: [{ label: 'Blog', route: 'blog', target: '_blank' }],
    }).success,
    false,
  );
});

test('a child may carry any of the three targets, same as a top-level item', () => {
  const withRoute = { label: 'Products', ref: ULID_A, children: [{ label: 'Blog', route: 'blog' }] };
  const parsed = NavigationItem.safeParse(withRoute);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.equal(
    NavigationItem.safeParse({ ...withRoute, children: [{ label: 'x', ref: ULID_B, route: 'blog' }] }).success,
    false,
    'the exactly-one rule is the same rule at both levels — navTarget is shared',
  );
});

test('navigation nests exactly two levels — a grandchild has no field to occupy (11 §3)', () => {
  const oneLevel = { label: 'Products', ref: ULID_A, children: [{ label: 'Pricing', ref: ULID_B }] };
  assert.equal(NavigationItem.safeParse(oneLevel).success, true, JSON.stringify(NavigationItem.safeParse(oneLevel).error?.issues));
  const twoLevels = { ...oneLevel, children: [{ label: 'Pricing', ref: ULID_B, children: [{ label: 'Deep', ref: ULID_C }] }] };
  assert.equal(NavigationItem.safeParse(twoLevels).success, false, 'a child has no children field of its own');
});

test('navigation children are bounded 1..12, same as top-level items', () => {
  const empty = { label: 'Products', ref: ULID_A, children: [] };
  assert.equal(NavigationItem.safeParse(empty).success, false);
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ label: `Item ${i}`, ref: ULID_A }));
  assert.equal(NavigationItem.safeParse({ label: 'Products', ref: ULID_A, children: thirteen }).success, false);
});

test('Navigation extends the envelope with 1..12 top-level items', () => {
  const item = { label: 'Home', ref: ULID_A };
  assert.equal(Navigation.safeParse({ ...envelope(), items: [item] }).success, true);
  assert.equal(Navigation.safeParse({ ...envelope(), items: [] }).success, false);
  const thirteen = Array.from({ length: 13 }, () => item);
  assert.equal(Navigation.safeParse({ ...envelope(), items: thirteen }).success, false);
});

// ---- Settings --------------------------------------------------------------------------------

function settingsBase(overrides = {}) {
  return {
    defaultLocale: 'en-US',
    locales: ['en-US', 'de-DE'],
    siteName: 'Jamground',
    baseUrl: 'https://example.org/',
    ...overrides,
  };
}

test('Settings is locale-neutral — no envelope, no id (11 §3)', () => {
  const ok = Settings.safeParse(settingsBase());
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues));
});

test('Settings.defaultLocale must be a member of Settings.locales', () => {
  const result = Settings.safeParse(settingsBase({ defaultLocale: 'fr-FR' }));
  assert.equal(result.success, false);
});

test('Settings.locales requires at least one entry, and Settings.social maps to ExternalUrl', () => {
  assert.equal(Settings.safeParse(settingsBase({ locales: [] })).success, false);
  assert.equal(
    Settings.safeParse(settingsBase({ social: { twitter: 'https://example.org/handle' } })).success,
    true,
  );
  assert.equal(
    Settings.safeParse(settingsBase({ social: { twitter: 'http://example.org/handle' } })).success,
    false,
    'http: is rejected',
  );
});

// ---- Redirects -------------------------------------------------------------------------------

test('Redirects requires at least one entry, each an absolute lowercase path with a trailing slash (11 §3)', () => {
  const ok = Redirects.safeParse({ redirects: [{ from: '/old/', to: '/new/' }] });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error.issues));
  assert.equal(Redirects.safeParse({ redirects: [] }).success, false);
  assert.equal(Redirects.safeParse({ redirects: [{ from: 'old', to: '/new/' }] }).success, false);
  assert.equal(Redirects.safeParse({ redirects: [{ from: '/old', to: '/new/' }] }).success, false, 'trailing slash is mandatory');
});

test('Redirects.status is an optional closed choice of 301 or 302 — omitted means 301', () => {
  const base = { from: '/old/', to: '/new/' };
  assert.equal(Redirects.safeParse({ redirects: [base] }).success, true, 'status may be absent');
  assert.equal(Redirects.safeParse({ redirects: [{ ...base, status: 301 }] }).success, true);
  assert.equal(Redirects.safeParse({ redirects: [{ ...base, status: 302 }] }).success, true);
  assert.equal(Redirects.safeParse({ redirects: [{ ...base, status: 307 }] }).success, false);
});

test('Redirects entries are .strict() — no unrecognised key', () => {
  const result = Redirects.safeParse({ redirects: [{ from: '/old/', to: '/new/', bogus: true }] });
  assert.equal(result.success, false);
});
