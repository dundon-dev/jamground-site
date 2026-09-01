// THE FIDELITY GATE (ADR-0013, 09 §6): normalise(astro_html) == normalise(editor_dom).
//
// The markup contract is produced twice — `toHtml` renders it for the site, `toElement` renders it
// through createElement for the editor canvas — and one stylesheet only works if both produce the
// same structure. design/markup/ makes that true by construction; this is the backstop against
// someone bypassing the module, and against the two renderers drifting for a reason neither file
// can see.
//
// IT COMPARES PARSED DOM, NOT STRINGS, and that is not fastidiousness. Measured against the real
// renderers, the same node description comes out as:
//
//   toHtml     <img class="jp-hero__media" src="x.jpg" alt="a &amp; b < c">
//   toElement  <img class="jp-hero__media" src="x.jpg" alt="a &amp; b &lt; c"/>
//
// React self-closes void elements and escapes three more characters inside attribute values. Both
// differences are invisible once parsed and neither is drift. A string-level normaliser would have
// to be widened until it could not see a real difference either — 09 §6's own note that the
// normaliser "must skip comment nodes" is the tell that a DOM walk was always what was meant.
//
// The other half of the transitive chain lives in test/blocks/custom.test.mjs, which renders the
// real .astro files and asserts they equal the module's HTML. Astro == module-as-string there,
// module-as-string == module-as-React here, so Astro == editor DOM — and neither package tree
// grows a dependency it does not already have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

const { JSDOM } = require('jsdom');
const { createElement, renderToString } = require('@wordpress/element');

const { toHtml } = await import('../../design/markup/node.ts');
const { toElement } = await import('../../design/markup/to-element.ts');
const { hero } = await import('../../design/markup/hero.ts');
const { featureGrid } = await import('../../design/markup/feature-grid.ts');
const { cta } = await import('../../design/markup/cta.ts');

/* Editor-only, and narrowly. Everything not named here — element names, nesting, our own `jp-*`
 * classes, `href`, `src`, `alt`, `data-columns` — is compared exactly. A wider list is how this
 * gate would stop being one. */
const EDITOR_ONLY_ATTRS = new Set([
  'data-block', 'data-type', 'data-title', 'contenteditable', 'role', 'tabindex',
  'aria-multiline', 'aria-label', 'spellcheck', 'style',
]);
const EDITOR_ONLY_CLASS = /^(block-editor-|components-|is-selected$|is-hovered$|wp-block$)/;

/** One element as `tag|attr=value,…|` plus its children, with editor chrome removed. Comment
 *  nodes are skipped — block delimiters are comments and appear inside save output (PoC-2b found
 *  this crashing the comparison). Whitespace-only text between elements is dropped; text that
 *  carries content is compared. */
function normaliseNode(node, out) {
  if (node.nodeType === 8) return;                       // comment
  if (node.nodeType === 3) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (text) out.push(`#text:${text}`);
    return;
  }
  if (node.nodeType !== 1) return;

  const attrs = [];
  for (const attr of [...node.attributes].sort((a, b) => a.name.localeCompare(b.name))) {
    if (EDITOR_ONLY_ATTRS.has(attr.name)) continue;
    if (attr.name === 'class') {
      const kept = attr.value.split(/\s+/).filter((c) => c && !EDITOR_ONLY_CLASS.test(c));
      if (kept.length) attrs.push(`class=${kept.sort().join(' ')}`);
      continue;
    }
    attrs.push(`${attr.name}=${attr.value}`);
  }

  out.push(`<${node.nodeName.toLowerCase()}|${attrs.join(',')}>`);
  for (const child of node.childNodes) normaliseNode(child, out);
  out.push(`</${node.nodeName.toLowerCase()}>`);
}

export function normalise(html) {
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  const out = [];
  for (const child of body.childNodes) normaliseNode(child, out);
  return out.join('');
}

const HOSTILE = ['a', '&', 'b', '<', 'c', '>', 'd', '"', 'e', String.fromCharCode(39), 'f'].join(' ');

/* One fixture set, fed to BOTH renderers. The link fixtures carry a resolved `href` because that
 * is what Astro always has; the editor-only case below asserts the absent-href path separately,
 * so the omission is pinned rather than incidental (09 §7 — build-resolved data is explicitly
 * outside what the editor claims to show). */
const FIXTURES = [
  ['hero — every optional present', () => hero({
    heading: 'Pricing & plans', body: 'No setup fees.',
    media: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' },
    cta: { label: 'Get started', href: '/en-us/pricing/' },
  })],
  ['hero — heading only', () => hero({ heading: 'Sales & Marketing' })],
  ['hero — decorative media, which renders an empty alt', () => hero({
    heading: 'H', media: { ref: 'media/x.jpg', decorative: true },
  })],
  ['hero — hostile characters in every text position', () => hero({
    heading: HOSTILE, body: HOSTILE,
    media: { ref: 'media/x.jpg', alt: HOSTILE },
    cta: { label: HOSTILE, href: '/p/?a=1&b=2' },
  })],
  ['featureGrid — two columns', () => featureGrid({
    columns: 2, items: [{ heading: 'A & B', body: 'b1' }, { heading: 'C', body: 'b2' }],
  })],
  ['featureGrid — an icon renders in neither', () => featureGrid({
    columns: 4, items: [{ heading: 'A', body: 'b', icon: 'bolt' }, { heading: 'C', body: 'd', icon: 'shield' }],
  })],
  ['cta — body present', () => cta({ heading: 'H & H', body: 'B', link: { label: 'L & L', href: '/x/' } })],
  ['cta — body absent', () => cta({ heading: 'H', link: { label: 'L', href: '/x/' } })],
];

for (const [name, build] of FIXTURES) {
  test(`fidelity: ${name}`, () => {
    const node = build();
    assert.equal(
      normalise(renderToString(toElement(node, createElement))),
      normalise(toHtml(node)),
    );
  });
}

test('the normaliser is narrow enough to catch a renamed class', () => {
  // 09 §The-gate: PoC-2 asserted both halves. A gate that never fails is not a gate, so the two
  // one-sided changes it named are asserted to FAIL here rather than described in a comment.
  const a = '<section class="jp-hero"><h2 class="jp-hero__heading">H</h2></section>';
  const b = '<section class="jp-hero"><h2 class="jp-hero__title">H</h2></section>';
  assert.notEqual(normalise(a), normalise(b));
});

test('the normaliser is narrow enough to catch a changed element', () => {
  const a = '<section class="jp-hero"><h2 class="jp-hero__heading">H</h2></section>';
  const b = '<section class="jp-hero"><h3 class="jp-hero__heading">H</h3></section>';
  assert.notEqual(normalise(a), normalise(b));
});

test('the normaliser ignores genuine editor chrome, and nothing else', () => {
  const bare = '<section class="jp-hero"><h2 class="jp-hero__heading">H</h2></section>';
  const dressed =
    '<section class="jp-hero block-editor-block-list__block is-selected" data-block="abc" ' +
    'data-type="jamground/hero" tabindex="0">' +
    '<!-- a block delimiter is a comment node, and skipping them is why PoC-2b existed -->' +
    '<h2 class="jp-hero__heading" contenteditable="true" role="textbox" aria-multiline="false">H</h2>' +
    '</section>';
  assert.equal(normalise(dressed), normalise(bare));

  // …and a real difference still shows through the chrome, so the strip rules are not a blanket.
  const dressedAndWrong = dressed.replace('jp-hero__heading', 'jp-hero__title');
  assert.notEqual(normalise(dressedAndWrong), normalise(bare));
});

test('an href the editor cannot resolve is omitted, not invented', () => {
  // The editor has no link resolver — `ref` becomes an href only at build time. Rendering `#` or
  // the raw ULID would be a target that goes somewhere wrong; the anchor is styled by its class,
  // so it still looks right with none.
  const node = hero({ heading: 'H', cta: { label: 'Go' } });
  const html = toHtml(node);
  assert.match(html, /<a class="jp-hero__cta">Go<\/a>/);
  assert.equal(html.includes('href'), false);
  assert.equal(normalise(renderToString(toElement(node, createElement))), normalise(html));
});
