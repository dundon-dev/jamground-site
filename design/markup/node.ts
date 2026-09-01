/* The markup contract's node description, and the one function that turns it into HTML.
 *
 * ADR-0013 makes the element structure and class names of every allowlisted block a specified
 * artifact, binding on every renderer, because markup is produced TWICE — once by the Astro
 * component that renders the site, once by the Gutenberg `edit` component that renders the editor
 * canvas — and one stylesheet only works if both produce the same structure. Writing it twice and
 * diffing the results makes the CI gate the only line of defence. Writing it once, here, and
 * rendering that one description two ways makes agreement hold BY CONSTRUCTION, and leaves the
 * gate as a backstop against someone bypassing the module.
 *
 * ZERO IMPORTS, AND ERASABLE TYPES ONLY. test/blocks/custom.test.mjs compiles one .astro file with
 * @astrojs/compiler-rs into a temp directory with no Vite and no module graph of its own, so every
 * runtime import a component gains is a specifier that harness has to rewrite. One rewrite rule
 * covers this whole directory only because nothing in it imports anything else.
 *
 * WHY toHtml RATHER THAN LETTING ASTRO ESCAPE. The Astro components render this description
 * through `set:html`, so these functions — not Astro's template engine — are what stands between
 * a contract value and the bytes of the site. The escaping below is therefore not a convenience:
 * it is the same job PostBody's ban on authored HTML does, one layer down. It reproduces Astro's
 * own behaviour exactly, including the two places Astro is surprising, both measured rather than
 * assumed:
 *
 *   - TEXT escapes five characters (& < > " '); ATTRIBUTES escape only two (& and ").
 *     `alt="a &amp; b < c > d &quot; e ' f"` is what Astro emits, raw angle brackets and all.
 *   - An EMPTY attribute value renders as the bare attribute name: `alt=""` comes out as `alt`.
 *     That is the decorative-image case (OD-22), so it is on the main path, not an edge.
 *
 * A React `createElement` tree of the same description escapes differently and self-closes void
 * elements. Those differences are invisible once parsed, which is why the fidelity gate compares
 * DOM trees rather than strings (09 §6). */

export type AttrValue = string | number | undefined | null | false;
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | null | undefined | false;

export interface Node {
  tag: string;
  attrs: Attrs;
  children: Child[];
}

/** The HTML void elements — no closing tag, and Astro emits no self-closing slash either. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

export function el(tag: string, attrs: Attrs = {}, children: Child[] = []): Node {
  return { tag, attrs, children };
}

/** Text content. Five characters, matching Astro's own interpolation. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Attribute values. TWO characters, matching Astro — a double-quoted value cannot be escaped
 *  out of by an angle bracket, and Astro leaves them raw. Deliberately not "more escaping to be
 *  safe": the point of this function is to be indistinguishable from what it replaced. */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function attrsToHtml(attrs: Attrs): string {
  let out = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    const text = typeof value === 'number' ? String(value) : value;
    // The bare-attribute case. Astro renders `alt=""` as `alt`, and a decorative image is
    // exactly that, so this is the contract's own path rather than a curiosity.
    out += text === '' ? ` ${name}` : ` ${name}="${escapeAttr(text)}"`;
  }
  return out;
}

/** The node description as HTML, byte-for-byte as the Astro components used to emit it. */
export function toHtml(node: Node): string {
  const open = `<${node.tag}${attrsToHtml(node.attrs)}>`;
  if (VOID.has(node.tag)) return open;
  let inner = '';
  for (const child of node.children) {
    if (child === null || child === undefined || child === false) continue;
    inner += typeof child === 'string' ? escapeText(child) : toHtml(child);
  }
  return `${open}${inner}</${node.tag}>`;
}
