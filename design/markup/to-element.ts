/* The second renderer of the markup contract: a node description as a `createElement` tree.
 *
 * `toHtml` (node.ts) is what the Astro components render for the site; this is what the
 * Gutenberg `edit` components render into the editor canvas. One description, two renderings —
 * which is what ADR-0013 means by agreement holding BY CONSTRUCTION rather than by a diff.
 *
 * `createElement` is a PARAMETER, not an import. design/markup/ imports nothing outside itself
 * (see node.ts), and this file must not be the exception: it is loaded by the Astro test harness
 * as part of the same directory, and inside Playground the editor bundle reads `wp.element` off
 * the global rather than bundling a second React into the page.
 *
 * The two renderings are not byte-identical and are not meant to be. React self-closes void
 * elements (`<img …/>`) where Astro does not, and escapes `<`, `>` and `'` inside attribute
 * values where Astro leaves them raw. Both differences disappear the moment the output is parsed,
 * which is why the fidelity gate compares DOM trees rather than strings (09 §6). */
import type { Attrs, Child, Node } from './node.ts';

type CreateElement = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

/** HTML attribute name -> the React prop that produces it. Only the ones the markup contract
 *  actually uses; anything else (including every `data-*` and `aria-*`) passes through unchanged,
 *  which is what React expects. */
const PROP_NAME: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
};

function toProps(attrs: Attrs): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs)) {
    // Same omissions toHtml makes, so an absent href is absent in both renderings rather than
    // rendering as the string "undefined" in one of them.
    if (value === undefined || value === null || value === false) continue;
    props[PROP_NAME[name] ?? name] = typeof value === 'number' ? String(value) : value;
  }
  return props;
}

export function toElement(node: Node, createElement: CreateElement): unknown {
  const children: unknown[] = [];
  for (const child of node.children) {
    if (child === null || child === undefined || child === false) continue;
    children.push(typeof child === 'string' ? child : toElement(child, createElement));
  }
  // Spread rather than an array: React warns about missing keys on an array of children, and a
  // key would be a React-only attribute inside markup the fidelity gate compares.
  return createElement(node.tag, toProps(node.attrs), ...children);
}

/** Narrower re-export so a consumer can name the child type without reaching into node.ts. */
export type { Child, Node };
