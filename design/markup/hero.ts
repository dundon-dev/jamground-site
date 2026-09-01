/* jamground/hero — the markup contract (11 §4c): jp-hero, __heading, __body, __media, __cta.
 * Rendered to HTML by src/components/blocks/Hero.astro and through createElement by the block's
 * `edit`. See node.ts for why this directory imports nothing. */
import { el, type Node } from './node.ts';

/** A link that has been resolved. `Link.ref` is a translation-group id, not a URL, and it becomes
 *  an href only at build time (src/lib/links.ts). Astro always has one; the editor never does, so
 *  `href` is optional here and an absent one omits the attribute rather than inventing a target.
 *  09 §7 names build-resolved data as explicitly outside what the editor claims to show. */
export interface MarkupLink {
  label: string;
  href?: string;
}

export interface HeroProps {
  heading: string;
  body?: string;
  media?: { ref: string; alt?: string; decorative?: boolean };
  cta?: MarkupLink;
}

export function hero(props: HeroProps): Node {
  const { heading, body, media, cta } = props;
  return el('section', { class: 'jp-hero' }, [
    el('h2', { class: 'jp-hero__heading' }, [heading]),
    body ? el('p', { class: 'jp-hero__body' }, [body]) : null,
    media
      ? el('img', {
          class: 'jp-hero__media',
          src: media.ref,
          // Decorative is DECLARED, never signalled by an empty string (OD-22) — but an empty
          // `alt` is what a decorative image must render, and Astro emits that as a bare `alt`.
          alt: media.decorative ? '' : media.alt,
        })
      : null,
    cta ? el('a', { class: 'jp-hero__cta', href: cta.href }, [cta.label]) : null,
  ]);
}
