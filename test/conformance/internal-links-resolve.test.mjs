/* Every internal href the build emits must point at a route the build generated.
 *
 * The gap this closes: route-set-equality asserts dist/ holds exactly the routes content/
 * entails, but says nothing about whether any anchor points AT one — a page could pass that
 * check while still linking to a bare, unresolved id that 404s in a browser.
 *
 * deriveExpectedRoutes() is the oracle rather than a listing of dist/, because it is derived
 * independently from content/ on disk; route-set-equality already proves the two agree, so
 * using it here keeps this file honest about what a route IS rather than what the build
 * happened to write. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildToTempDir, listFiles, cleanup } from './lib/build.mjs';
import { deriveExpectedRoutes } from './lib/derive-routes.mjs';
import { extractHrefs, classifyHref, routeFileFor } from './lib/internal-links.mjs';
import { navRefHrefs } from './lib/nav-links.mjs';

/* node --test runs test FILES as separate processes and every conformance file builds its
 * own dist/, so there is no build to share across files — this file builds once, at module
 * scope, and both build-backed tests below read the same output. */
const outDir = await buildToTempDir();
const htmlFiles = listFiles(outDir).filter((f) => f.endsWith('.html'));
const emitted = htmlFiles.map((file) => ({
  file,
  hrefs: extractHrefs(readFileSync(join(outDir, file), 'utf8')),
}));
cleanup(outDir);

test('every internal href in dist/ resolves to a route the build generated', () => {
  const expected = deriveExpectedRoutes();
  const violations = [];

  for (const { file, hrefs } of emitted) {
    for (const href of hrefs) {
      const classified = classifyHref(href);
      if (classified.kind === 'external' || classified.kind === 'fragment') continue;
      if (classified.kind === 'violation') {
        violations.push({ file, href, why: classified.why });
        continue;
      }
      const route = routeFileFor(href);
      if (route.allowed) continue;
      if (route.why) {
        violations.push({ file, href, why: route.why });
        continue;
      }
      if (!expected.has(route.file)) {
        violations.push({ file, href, why: `${route.file} is not a route derived from content/` });
      }
    }
  }

  // deepEqual against [] rather than a length check: one run names every bad link, and the
  // failure output is the list of them.
  assert.deepEqual(violations, []);
});

/* Against a false green. A regex that silently stops matching would make the assertion above
 * pass over nothing at all — the failure mode that makes a gate worse than no gate.
 *
 * Two jobs, deliberately separated, because folding them together is how the first one stopped
 * being true. `all.length > 0` and the hermetic plants below are what prove the EXTRACTOR works;
 * they depend on no content and cannot be edited away. The `ref:`/`route:` assertions prove the
 * whole named-route path end to end: the schema accepted it, links.ts resolved it, SiteHeader
 * rendered it, and it landed on a route that exists.
 *
 * THE `ref:` HALF NAMES NO SLUG AND ALSO DOES NOT GUESS AT ONE. It used to require the literal
 * `/en-us/example/`, which put a fact about the CONTENT repository into a gate in the CODE
 * repository — renaming a page or reordering the menu, editorial acts in a repository this one is
 * deliberately separate from, failed the build here. Asserting the href's SHAPE instead is worse
 * rather than better: `hero.cta` and `cta.link` resolve to exactly the same `/{locale}/{slug}/`
 * shape from inside a page body, so the first CTA pointing at a page would let it pass over a menu
 * with no links in it at all. So navRefHrefs() resolves the navigation through links.ts's own
 * `buildLinkIndex`/`navHref` and this asserts the build emitted each result. */
test('the extractor actually found the seed content\'s internal links', () => {
  const all = emitted.flatMap(({ hrefs }) => hrefs);
  assert.ok(all.length > 0, 'no anchors found in dist/ at all — the extractor is broken');

  const internal = all.filter((href) => classifyHref(href).kind === 'internal');

  // Every `ref:` the navigation declares must appear as an anchor the build actually emitted.
  // navRefHrefs() resolves them through links.ts itself, so this compares the production resolver's
  // answer against the production output rather than restating either. Vacuous only if no
  // navigation declares a ref: at all, which is a legitimate menu and not a silent pass — the
  // extractor's own proof is `all.length > 0` above and the plants below.
  for (const href of navRefHrefs()) {
    assert.ok(
      internal.includes(href),
      `navigation resolves a ref: to ${href}, but no anchor in dist/ points there`,
    );
  }
  assert.ok(internal.includes('/en-us/blog/'), 'primary navigation must link to the blog index');
  assert.ok(internal.includes('/en-us/blog/example-post/'), 'the blog index must link to the example post');
});

/* Hermetic plants — permanent, so the classifier's own contract is asserted rather than
 * merely exercised by whatever the seed content happens to contain today. */
test('a bare translation-group ULID is a violation', () => {
  const classified = classifyHref('01M0BSHSG62QD33PKX3GRRXX5V');
  assert.equal(classified.kind, 'violation');
  assert.match(classified.why, /not a root-relative path/);
});

test('a path with no trailing slash is a violation under trailingSlash: always', () => {
  assert.match(routeFileFor('/en-us/blog/launch').why, /no trailing slash/);
});

test('plaintext http: is a violation; https:, mailto: and tel: are external', () => {
  assert.equal(classifyHref('http://example.org/').kind, 'violation');
  assert.equal(classifyHref('https://example.org/').kind, 'external');
  assert.equal(classifyHref('mailto:someone@example.org').kind, 'external');
  assert.equal(classifyHref('tel:+441234567890').kind, 'external');
});

test('a slashed post path maps to the file deriveExpectedRoutes() names', () => {
  assert.equal(routeFileFor('/en-us/blog/example-post/').file, 'en-us/blog/example-post/index.html');
  assert.ok(deriveExpectedRoutes().has('en-us/blog/example-post/index.html'));
});

test('the root path is allowed — nginx redirects it (05 §Routing)', () => {
  assert.equal(routeFileFor('/').allowed, true);
});

test('/404.html maps to itself rather than being treated as a missing directory', () => {
  assert.equal(routeFileFor('/404.html').file, '404.html');
  assert.ok(deriveExpectedRoutes().has('404.html'));
});

test('extractHrefs reads the attribute off the shipped defect verbatim', () => {
  assert.deepEqual(
    extractHrefs('<a class="jp-cta__link" href="01ARZ3NDEKTSV4RRFFQ69G5FAV">Go</a>'),
    ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
  );
  // Single quotes, unquoted, and an encoded ampersand in a query string.
  assert.deepEqual(extractHrefs("<a href='/en-us/'>x</a>"), ['/en-us/']);
  assert.deepEqual(extractHrefs('<a href=/en-us/>x</a>'), ['/en-us/']);
  assert.deepEqual(extractHrefs('<a href="/s/?a=1&amp;b=2">x</a>'), ['/s/?a=1&b=2']);
});
