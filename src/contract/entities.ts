/* The six entity schemas. Every non-block collection extends the shared Envelope
 * (envelope.ts); Page is the one exception that also pulls in the block catalogue
 * (blocks.ts) rather than deriving its body shape here. Imported by relative
 * .ts path, exactly as envelope.ts imports defs.ts — nothing here is re-derived. */
import { z } from 'zod';
import { Ulid, Locale, Slug, InlineText, MediaRef, ExternalUrl } from './defs.ts';
import { Envelope } from './envelope.ts';
import { Block } from './blocks.ts';

export const Page = Envelope.extend({ blocks: z.array(Block).min(1) });

export const Post = Envelope.extend({
  author:   Ulid,                          // -> an author's translation group; REQUIRED
  excerpt:  z.string().min(1).max(300).optional(),
  tags:     z.array(Slug).optional(),
  related:  z.array(Ulid).optional(),      // -> translation groups
  // body is markdown following the frontmatter, not a schema field
});

export const Author = Envelope.extend({
  name:    z.string().min(1),
  role:    z.string().min(1).optional(),
  bio:     InlineText.optional(),
  avatar:  MediaRef.optional(),
});

/** Two levels, capped BY CONSTRUCTION rather than by a numeric refinement — an array-length
 *  cap on the item list bounds breadth, not depth, so the depth cap comes from having no
 *  further recursive field for a third level to occupy, not from a number. */
const navTarget = {
  label: z.string().min(1),
  ref:   Ulid.optional(),          // internal: a translation group
  href:  ExternalUrl.optional(),   // external only; internal absolute URLs are not allowed here
};
const oneTarget = (v: { ref?: string; href?: string }) => !!v.ref !== !!v.href;

const NavChild = z.object(navTarget).strict().refine(oneTarget, 'exactly one of ref or href');

export const NavigationItem = z.object({
  ...navTarget,
  children: z.array(NavChild).min(1).max(12).optional(),
}).strict().refine(oneTarget, 'exactly one of ref or href');

export const Navigation = Envelope.extend({ items: z.array(NavigationItem).min(1).max(12) });

/** Locale-neutral. One file, content/settings/site.yaml — no locale directory. */
export const Settings = z.object({
  defaultLocale: Locale,
  locales:       z.array(Locale).min(1),
  siteName:      z.string().min(1),
  baseUrl:       z.string().url(),
  social:        z.record(z.string(), ExternalUrl).optional(),
}).refine(v => v.locales.includes(v.defaultLocale), 'defaultLocale must be one of locales');

/** Locale-neutral. content/settings/redirects.yaml — vanity, campaign, legacy paths.
 *  OPTIONAL: absent means no vanity redirects, consistent with "empty collections are
 *  omitted". Trailing slash is mandatory, matching the generated map. */
export const RedirectPath = z.string()
  .regex(/^\/[a-z0-9]+(?:[-/][a-z0-9]+)*\/$/, 'must be an absolute lowercase path with a trailing slash');

export const Redirects = z.object({
  redirects: z.array(z.object({
    from:   RedirectPath,
    to:     RedirectPath,
    status: z.union([z.literal(301), z.literal(302)]).optional(),   // omitted means 301
  }).strict()).min(1),
}).strict();
