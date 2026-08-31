// What Gutenberg itself writes back, which nothing else here tests.
//
// Every other test in this directory builds its markup the way the IMPORT path does — with
// `createBlock()` and `serialize()`, against the host page's own block registry — or writes it
// through `client.run`. That markup byte-matches the registered `save()` by construction, so it
// exercises exactly the one case that is never in doubt.
//
// A person editing in wp-admin produces something different, and the difference is not
// cosmetic. The mu-plugin strips `className` support inside WordPress, so the editor re-saves a
// heading as `<h2>Welcome</h2>`; the host registry that wrote the import has that support, so it
// wrote `<h2 class="wp-block-heading">Welcome</h2>`. Markup that does not byte-match the
// registered `save()` parses with the WHOLE attribute schema materialised — every key the block
// declares, valued `undefined` — instead of only the sourced ones.
//
// The markup below was captured from a real Playground session: the seed home page, opened in
// wp-admin, typed into, and saved with WordPress's own Update button. It is pasted rather than
// generated precisely so that it cannot drift back into being host-serialised markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const { exportEntity } = await import('../lib/export.mjs');
const { guardBlockAttributes } = await import('../lib/attribute-guard.mjs');

const api = { createBlock, serialize, parse, getBlockType };

const GUTENBERG_PERSISTED = [
  '<!-- wp:heading -->',
  '<h2>Welcome</h2>',
  '<!-- /wp:heading -->',
  '',
  '<!-- wp:paragraph -->',
  '<p>This site demonstrates the shape of the content in this repository: one page, one post, one author and Edited by hand. one navigation menu.</p>',
  '<!-- /wp:paragraph -->',
].join('\n');

const FRONTMATTER = {
  id: '01M143VEG04JRXAX5JYES4JXZ0',
  translationOf: '01M143VFF8TN0D6FNX3S6M5T49',
  locale: 'en-US',
  slug: 'home',
  title: 'Home',
  status: 'published',
  publishedAt: '2026-08-28T12:00:00Z',
  updatedAt: '2026-08-28T12:00:00Z',
};

test('the whole attribute schema really is materialised — the premise of the test below', () => {
  const [heading] = parse(GUTENBERG_PERSISTED);
  const keys = Object.keys(heading.attributes);

  // If this ever stops holding, the regression test below stops testing anything, so it is
  // asserted rather than assumed.
  assert.ok(keys.includes('textAlign'), `expected the full schema, got: ${keys.join(', ')}`);
  assert.equal(heading.attributes.textAlign, undefined, 'and nobody set it');
  assert.ok(keys.length > 5, `expected more than the sourced attributes, got: ${keys.join(', ')}`);
});

test('a page opened and edited in wp-admin exports rather than refusing itself', () => {
  // REGRESSION. This threw `INV-5b layer 3: attribute "textAlign" on block "core/heading" has
  // no contract representation` — as a plain Error, so the shell reported "save did not
  // complete — please try again" about a save that could never complete however many times it
  // was tried. Every save of a page a person had merely opened failed this way.
  const out = exportEntity({
    kind: 'page',
    frontmatter: FRONTMATTER,
    markup: GUTENBERG_PERSISTED,
    api,
    previousSlug: 'home',
    updatedAt: '2026-08-31T23:00:00Z',
  });

  assert.match(out, /type: heading/);
  assert.match(out, /text: Welcome/);
  assert.match(out, /Edited by hand\./);
  // The undefined attributes are gone from the contract file, not carried into it.
  assert.doesNotMatch(out, /textAlign/);
  assert.doesNotMatch(out, /fontSize/);
});

test('an attribute a person actually set is still refused, naming itself', () => {
  // The guard's job is unchanged: `undefined` is not a value, but `center` is.
  assert.throws(
    () => guardBlockAttributes(api, {
      name: 'core/heading',
      attributes: { content: 'Welcome', level: 2, textAlign: 'center' },
    }),
    /attribute "textAlign" on block "core\/heading"/,
  );
});

test('a defaulted attribute is still skipped, and a changed one still refused', () => {
  // dropCap defaults to false and rides along on every parsed paragraph.
  assert.doesNotThrow(() => guardBlockAttributes(api, {
    name: 'core/paragraph',
    attributes: { content: 'x', dropCap: false },
  }));
  assert.throws(
    () => guardBlockAttributes(api, {
      name: 'core/paragraph',
      attributes: { content: 'x', dropCap: true },
    }),
    /attribute "dropCap" on block "core\/paragraph"/,
  );
});
