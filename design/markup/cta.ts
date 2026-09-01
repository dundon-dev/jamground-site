/* jamground/cta — the markup contract (11 §4c): jp-cta, __heading, __body, __link.
 * See node.ts for why this directory imports nothing. */
import { el, type Node } from './node.ts';
import type { MarkupLink } from './hero.ts';

export interface CtaProps {
  heading: string;
  body?: string;
  link: MarkupLink;
}

export function cta(props: CtaProps): Node {
  const { heading, body, link } = props;
  return el('section', { class: 'jp-cta' }, [
    el('h2', { class: 'jp-cta__heading' }, [heading]),
    body ? el('p', { class: 'jp-cta__body' }, [body]) : null,
    el('a', { class: 'jp-cta__link', href: link.href }, [link.label]),
  ]);
}
