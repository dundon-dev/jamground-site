// The inline HTML a core block attribute holds -> canonical InlineText mdast nodes.
// Export direction: WordPress content is untrusted, so this is the second of three
// allowlist layers — the mark-level allowlist — and it throws, naming the offending tag or
// node type, on anything outside the four constructs even though the surrounding block
// already parsed `isValid: true`. `isValid` says nothing about mark allowlist membership:
// `<span style>` and `<script>` both parse valid, so the allowlist below is what actually
// catches them, never a trust in Gutenberg's own validation.
//
// `inline-to-html.mjs` (the forward direction) says why this returns mdast nodes rather than a
// stringified value: the caller (`blocks-to-mdast.mjs`) assembles a whole document tree
// and stringifies it once, so remark-stringify decides table-cell pipe escaping and list-item
// indentation with the real surrounding context, instead of this module deciding it piecemeal
// per inline fragment.

// A private document for parsing, loaded from globalThis in the browser or via jsdom under Node.
// It never touches `window` at module scope and shares no state with `domshim.cjs`, which
// exists for the different reason of loading @wordpress packages.
let document;

function getDocument() {
  if (document !== undefined) {
    return document;
  }
  if (typeof globalThis.document !== 'undefined') {
    document = globalThis.document;
    return document;
  }

  // Lazy-load jsdom only when a real DOM is not available (under Node.js).
  // In a browser bundle (esbuild), globalThis.document always exists, so this path never runs.
  // Using getBuiltinModule avoids static resolution by esbuild.
  // eslint-disable-next-line import/no-extraneous-dependencies
  const mod = globalThis.process.getBuiltinModule('module');
  const createRequire = mod.createRequire;
  const require = createRequire(import.meta.url);
  const { JSDOM } = require('jsdom');
  document = new JSDOM('').window.document;
  return document;
}

function walkChildren(el) {
  return [...el.childNodes].flatMap((n) => walkNode(n));
}

function walkNode(n) {
  if (n.nodeType === 3) {
    // Text node — jsdom has already decoded any entity/character references.
    return n.nodeValue ? [{ type: 'text', value: n.nodeValue }] : [];
  }
  if (n.nodeType !== 1) {
    // Not an element either (a comment, etc.) — raw HTML is prohibited inside InlineText.
    throw new Error(`Prohibited construct inside InlineText: node type ${n.nodeType}`);
  }
  const tag = n.tagName.toLowerCase();
  switch (tag) {
    case 'strong':
    case 'b':
      return [{ type: 'strong', children: walkChildren(n) }];
    case 'em':
    case 'i':
      return [{ type: 'emphasis', children: walkChildren(n) }];
    case 'code':
      return [{ type: 'inlineCode', value: n.textContent }];
    case 'a':
      return [{ type: 'link', url: n.getAttribute('href') || '', children: walkChildren(n) }];
    default:
      throw new Error(`Prohibited mark inside InlineText: <${tag}>`);
  }
}

/** html: the inline HTML a core block attribute (e.g. `content`) holds.
 *  returns: the mdast inline nodes it corresponds to — a `paragraph`'s `children`, constrained
 *  to the four canonical constructs (strong, emphasis, inlineCode,
 *  link, plus plain text). Anything else throws, naming the offending tag or node type. */
export function htmlToInline(html) {
  const doc = getDocument();
  const div = doc.createElement('div');
  div.innerHTML = html;
  return walkChildren(div);
}
