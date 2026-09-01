// THE NORMALISER THE TWO MARKUP GATES SHARE: one element tree as a comparable string.
//
// Extracted from fidelity.test.mjs when a second gate needed the same comparison.
// editor/test/core-markup.test.mjs holds WordPress's own save() output to the record in
// design/markup/core.ts, and that comparison has to be as narrow as the custom blocks' one or the
// two gates would mean different things by "the same markup". One definition, imported twice —
// the same argument design/markup/ makes about the markup itself.
//
// A plain module rather than an export from the test file it came from: importing a node:test file
// registers its tests in the importing file's process too, so the suite would run twice and a
// failure would name the wrong file.
//
// The narrowness is asserted, not asserted-about. fidelity.test.mjs keeps the three tests that
// pin it — a renamed class and a changed element must both survive normalisation as differences,
// and genuine editor chrome must not.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

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
