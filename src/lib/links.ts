/* Reference resolution.
 *
 * `Link.ref` (defs.ts) targets a translation GROUP id, not a URL. This module resolves that
 * id to a real href.
 *
 * Three design choices are load-bearing and should not be undone casually:
 *
 * 1. It is PURE. No `astro:content`, no `node:fs`, no env reads — `buildLinkIndex` takes
 *    three named plain arrays and the caller states which collection each is. That is what
 *    makes it unit-testable from plain Node with object literals as fixtures, the same way
 *    test/conformance/lib/derive-routes.mjs imports src/contract/env.ts. Every relative
 *    import carries an explicit `.ts` extension for the same reason, and the syntax is
 *    erasable-only (no enum, no namespace, no parameter properties).
 *
 * 2. `resolveBlockLinks` REPLACES `ref` with `href` rather than adding one alongside. After
 *    resolution a raw group ULID is not representable in the renderer's input at all — the
 *    same "unrepresentable, not merely detected" move defs.ts makes for NFC filenames. A
 *    renderer cannot accidentally fall back to the un-resolved value because it is gone.
 *
 * 3. It THROWS. Never a fallback href, never an inert link. An unresolvable ref is a build
 *    failure, and a published entity linking to a draft is an error in preview and
 *    production alike, so the two can never disagree. This is the render-time check that
 *    runs on every build.
 *
 * The six pathFor* helpers below express the routing table exactly once. Every href in src/
 * goes through them — including the ones that are currently hand-built and happen to be
 * correct — so the table has exactly one home. */
import { localeToSegment } from '../contract/defs.ts';
import type { z } from 'zod';
import type { Block } from '../contract/blocks.ts';

/** Which collection a target lives in. Decides the route shape, and is stated by the
 *  caller rather than inferred: nothing in an envelope says "I am a post". */
export type LinkKind = 'page' | 'post' | 'author';

/** The subset of an envelope this module needs. Deliberately NOT Astro's CollectionEntry —
 *  a plain object literal has to be a valid fixture (see note 1 above). */
export interface LinkTarget {
  kind: LinkKind;
  id: string;
  translationOf: string;
  locale: string;
  slug: string;
  status: 'draft' | 'published';
}

/** Key is `${translationOf}\u0000${locale}` — a group is resolved *in the referring
 *  entity's locale*, so the locale is part of the identity, not a filter applied after. */
export type LinkIndex = ReadonlyMap<string, LinkTarget>;

/** The referring entity. Resolution is stated in terms of it ("in the referring entity's
 *  locale"), and the draft-link check turns on its status, so both travel with the lookup
 *  rather than being passed ad hoc. It is also what makes an error message name a file a
 *  person can open. */
export interface Referrer {
  collection: 'pages' | 'posts' | 'authors' | 'navigation';
  id: string;
  slug: string;
  locale: string;
  status: 'draft' | 'published';
}

export interface LinkContext {
  index: LinkIndex;
  from: Referrer;
  /** From resolveDraftFlag(), supplied by the caller — this module reads no env. */
  includeDrafts: boolean;
}

/** A Link after resolution. `ref` is absent by construction (note 2). */
export interface ResolvedLink {
  label: string;
  href: string;
}

export class LinkResolutionError extends Error {
  override name = 'LinkResolutionError';
}

type AnyBlock = z.infer<typeof Block>;
type BlockOf<T extends AnyBlock['type']> = Extract<AnyBlock, { type: T }>;

export type ResolvedHero = Omit<BlockOf<'hero'>, 'cta'> & { cta?: ResolvedLink };
export type ResolvedCta = Omit<BlockOf<'cta'>, 'link'> & { link: ResolvedLink };
export type ResolvedBlock =
  | Exclude<AnyBlock, { type: 'hero' | 'cta' }>
  | ResolvedHero
  | ResolvedCta;

// ---- The routing table, in code, exactly once -------------------------------------------
// Every helper returns a ROOT-RELATIVE path with a leading and a trailing slash:
// `trailingSlash: 'always'` with `build.format: 'directory'` (astro.config.mjs), and internal
// absolute URLs are banned, so `site:` never appears in an href — it is for canonicals and
// sitemaps. localeToSegment is the only lowercasing anywhere in this module.

export function pathForHome(locale: string): string {
  return `/${localeToSegment(locale)}/`;
}

/** The `slug: 'home'` special case lives here, with the routing table, rather than in the
 *  index — a home page is an ordinary `pages` entity that happens to route to the root. */
export function pathForPage(locale: string, slug: string): string {
  return slug === 'home' ? pathForHome(locale) : `/${localeToSegment(locale)}/${slug}/`;
}

export function pathForBlogIndex(locale: string): string {
  return `/${localeToSegment(locale)}/blog/`;
}

export function pathForPost(locale: string, slug: string): string {
  return `/${localeToSegment(locale)}/blog/${slug}/`;
}

export function pathForAuthor(locale: string, slug: string): string {
  return `/${localeToSegment(locale)}/authors/${slug}/`;
}

export function pathForTag(locale: string, tag: string): string {
  return `/${localeToSegment(locale)}/tags/${tag}/`;
}

// ---- The index ------------------------------------------------------------------------

const key = (group: string, locale: string): string => `${group}\u0000${locale}`;

type TargetInput = Omit<LinkTarget, 'kind'>;

/** Builds the (group, locale) -> entity index. TOTAL over the input, drafts included, with
 *  `status` carried through: whether a draft is linkable is answered at lookup time, where
 *  the referrer is known, not here. Building a filtered index instead would make a draft
 *  target and a nonexistent one indistinguishable, and they need different messages.
 *
 *  A duplicate (translationOf, locale) throws rather than last-write-wins: two entities in
 *  one group and one locale is invalid data, and silently keeping one of them would make the
 *  resolved href depend on directory iteration order, which reproducibility.test.mjs would
 *  eventually catch as a mystery. */
export function buildLinkIndex(input: {
  pages: readonly TargetInput[];
  posts: readonly TargetInput[];
  authors: readonly TargetInput[];
}): LinkIndex {
  const index = new Map<string, LinkTarget>();
  const add = (kind: LinkKind, entries: readonly TargetInput[]): void => {
    for (const entry of entries) {
      const k = key(entry.translationOf, entry.locale);
      const existing = index.get(k);
      if (existing) {
        throw new LinkResolutionError(
          `INV-12: translation group ${entry.translationOf} has two members in locale ` +
            `${entry.locale} — ${existing.kind} ${existing.id} (${existing.slug}) and ` +
            `${kind} ${entry.id} (${entry.slug})`,
        );
      }
      index.set(k, { kind, ...entry });
    }
  };
  add('page', input.pages);
  add('post', input.posts);
  add('author', input.authors);
  return index;
}

export function linkContext(index: LinkIndex, from: Referrer, includeDrafts: boolean): LinkContext {
  return { index, from, includeDrafts };
}

const describeReferrer = (from: Referrer): string =>
  `${from.collection}/${from.locale}/${from.slug} (id ${from.id})`;

/** Group id -> href, in the referring entity's locale. Throws on every failure; see note 3.
 *  The order of the checks is the order of the messages a person needs: does the group exist
 *  at all, does it exist here, is it publishable, and only then what its route is. */
export function hrefFor(ctx: LinkContext, ref: string): string {
  const target = ctx.index.get(key(ref, ctx.from.locale));

  if (!target) {
    const elsewhere: string[] = [];
    for (const candidate of ctx.index.values()) {
      if (candidate.translationOf === ref) elsewhere.push(candidate.locale);
    }
    if (elsewhere.length === 0) {
      throw new LinkResolutionError(
        `INV-11: ${describeReferrer(ctx.from)} links to translation group ${ref}, ` +
          `which no entity declares`,
      );
    }
    throw new LinkResolutionError(
      `INV-11: ${describeReferrer(ctx.from)} links to translation group ${ref}, which has ` +
        `no member in locale ${ctx.from.locale} (members: ${elsewhere.sort().join(', ')})`,
    );
  }

  if (target.status === 'draft') {
    if (!ctx.includeDrafts) {
      throw new LinkResolutionError(
        `INV-11: ${describeReferrer(ctx.from)} links to ${target.kind} ${target.id} ` +
          `(${target.slug}), which is a draft and has no route in this build (OD-28)`,
      );
    }
    // Drafts ARE rendered here, so the target resolves — but a PUBLISHED referrer linking to
    // a draft is an error always, in both builds, precisely so preview and production never
    // disagree. A draft linking to a draft is not forbidden, and is what previews exist to
    // support: a set of pages being written alongside each other.
    if (ctx.from.status === 'published') {
      throw new LinkResolutionError(
        `INV-11: ${describeReferrer(ctx.from)} is published and links to ${target.kind} ` +
          `${target.id} (${target.slug}), which is a draft — a published entity may not ` +
          `link to a draft, in preview or in production (OD-28)`,
      );
    }
  }

  switch (target.kind) {
    case 'page':
      return pathForPage(target.locale, target.slug);
    case 'post':
      return pathForPost(target.locale, target.slug);
    case 'author':
      return pathForAuthor(target.locale, target.slug);
  }
}

export function resolveLink(ctx: LinkContext, link: { label: string; ref: string }): ResolvedLink {
  return { label: link.label, href: hrefFor(ctx, link.ref) };
}

/** NavigationItem carries exactly one of `ref` (internal group) or `href` (external,
 *  already ExternalUrl-validated, so it passes through untouched). The schema's `oneTarget`
 *  refinement enforces the exclusivity; this re-states it because a nav item that reached
 *  here with both or neither would otherwise silently render the wrong thing. */
export function navHref(ctx: LinkContext, item: { ref?: string; href?: string }): string {
  const hasRef = typeof item.ref === 'string';
  const hasHref = typeof item.href === 'string';
  if (hasRef === hasHref) {
    throw new LinkResolutionError(
      `navigation item in ${describeReferrer(ctx.from)} must carry exactly one of ref or ` +
        `href (got ${hasRef ? 'both' : 'neither'})`,
    );
  }
  return hasHref ? (item.href as string) : hrefFor(ctx, item.ref as string);
}

/** Rewrites the only two link-bearing block types. Flat by construction — no block nests
 *  another, so there is no recursion to get wrong. Every other block passes through by
 *  reference, unchanged. */
export function resolveBlockLinks(
  blocks: readonly AnyBlock[],
  ctx: LinkContext,
): ResolvedBlock[] {
  return blocks.map((block): ResolvedBlock => {
    if (block.type === 'hero') {
      const { cta, ...rest } = block;
      return cta ? { ...rest, type: 'hero', cta: resolveLink(ctx, cta) } : { ...rest, type: 'hero' };
    }
    if (block.type === 'cta') {
      const { link, ...rest } = block;
      return { ...rest, type: 'cta', link: resolveLink(ctx, link) };
    }
    return block;
  });
}
