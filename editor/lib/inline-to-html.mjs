// Canonical InlineText -> the inline HTML a core
// block attribute holds. Import direction only: content/ is the
// trusted source, so this is a converter, not a validator, and it does not
// re-run `inlineTextCheck`'s stringify round trip. It still enforces the
// four-construct allowlist by throwing on anything else, the same discipline
// html-to-inline.mjs uses for the reverse (export) direction — trusting an
// upstream check instead of enforcing the allowlist directly is not safe on its own.
//
// The reverse direction — this HTML back to mdast — is html-to-inline.mjs's export path: it
// needs a DOM and the mark-level allowlist that guards untrusted editor
// output, neither of which belongs here.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);

// CommonMark decodes entity and character references while parsing inline
// content, so a literal `&`, `<` or `>` reaching a text/inlineCode node here
// must be re-encoded on the way out, or it would be read back as markup.
const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ALLOWED = new Set(['text', 'strong', 'emphasis', 'inlineCode', 'link']);

function inlineNodesToHtml(nodes) {
  return nodes.map((n) => {
    if (!ALLOWED.has(n.type)) {
      throw new Error(`Prohibited construct inside InlineText: ${n.type}`);
    }
    switch (n.type) {
      case 'text':
        return enc(n.value);
      case 'strong':
        return `<strong>${inlineNodesToHtml(n.children)}</strong>`;
      case 'emphasis':
        return `<em>${inlineNodesToHtml(n.children)}</em>`;
      case 'inlineCode':
        return `<code>${enc(n.value)}</code>`;
      case 'link':
        return `<a href="${n.url}">${inlineNodesToHtml(n.children)}</a>`;
      default:
        // unreachable: ALLOWED guards every case above
        throw new Error(`Prohibited construct inside InlineText: ${n.type}`);
    }
  }).join('');
}

// value: a canonical InlineText string.
// returns: the inline HTML a core block attribute (e.g. `content`) holds.
export function inlineToHtml(value) {
  const ast = parser.parse(value);
  if (ast.children.length === 0) return '';
  if (ast.children.length !== 1 || ast.children[0].type !== 'paragraph') {
    throw new Error(`Not canonical InlineText (11 §Canonical-InlineText): ${JSON.stringify(value)}`);
  }
  return inlineNodesToHtml(ast.children[0].children);
}
