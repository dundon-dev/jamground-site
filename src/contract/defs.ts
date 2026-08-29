/* Shared definitions. Every entity and block schema in this contract imports these rather
 * than repeating a regex, so a Locale or a Slug is defined exactly once. InlineText's
 * canonical-form check lives here too, because InlineText is a leaf type with no entity
 * schema of its own to attach the check to. */
import { z } from 'zod';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

/** ULID — Crockford base32, 26 chars, no I/L/O/U. */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID');

/** The jamground locale form: ISO 639-1 language, '-', ISO 3166-1 alpha-2 region.
 *  A strict SUBSET of BCP 47, not BCP 47 itself — `de`, `es-419` and `zh-Hans-CN` are
 *  deliberately rejected. The 2-2 shape is load-bearing: it is the directory
 *  name and, lowercased, the URL segment, which is what makes the directory <-> URL
 *  transform total and reversible. Membership of Settings.locales is checked by the
 *  validator, not here — a Zod schema cannot read another file. */
export const Locale = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, 'must be a locale of the form xx-XX');

/** The only permitted locale <-> URL-segment transform. Ad-hoc .toLowerCase() on a path
 *  that also contains a slug is the bug these exist to prevent. Mutually
 *  inverse over the domain fixed by Locale above. */
export const localeToSegment = (locale: string): string => locale.toLowerCase(); // 'en-US' -> 'en-us'
export const segmentToLocale = (segment: string): string =>
  segment.slice(0, 2) + '-' + segment.slice(3).toUpperCase(); // 'en-us' -> 'en-US'

/** URL-facing, lowercase, no leading or trailing hyphen. Unique per (collection, locale).
 *  `/` is forbidden, so nested URL paths are not expressible — a deliberate v1
 *  product constraint, not an oversight. */
export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a slug');

/** ISO 8601, always UTC, always second precision.
 *  NOT `z.string().datetime({ offset: false })` — that accepts `...T09:00:00.123Z`, and
 *  millisecond precision is byte-unstable across a round trip (a writer may add or drop
 *  `.000`). The regex pins precision; the refinement rejects
 *  a well-shaped non-instant such as `2026-02-30T00:00:00Z`. */
export const Timestamp = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'must be an ISO 8601 UTC timestamp to second precision')
  .refine(v => new Date(v).toISOString().replace('.000Z', 'Z') === v, 'must be a real instant');

/** Rooted at content/. A leading './' is prohibited — it resolves wrong.
 *  Lowercase-kebab and ASCII-only, which makes the NFC-vs-NFD filename problem
 *  UNREPRESENTABLE rather than merely detected: macOS/APFS hands out NFD filenames, so a
 *  non-ASCII media name committed from a Mac would not match its NFC-normalised reference.
 *  Six extensions, one spelling each — `jpeg` is not accepted, so no normalisation step
 *  exists to get wrong. No subdirectories. */
export const MediaPath = z.string().regex(
  /^media\/[a-z0-9]+(?:-[a-z0-9]+)*\.(jpg|png|webp|avif|gif|svg)$/,
  'must be media/<lowercase-kebab-name>.<jpg|png|webp|avif|gif|svg>',
);

/** The remark pipeline InlineText is checked against — one shared instance, not rebuilt per
 *  validation. Parsing and stringifying MUST run through the same library on both sides of
 *  the round trip: a value the parser accepts and a different
 *  serialiser writes back differently would pass assertion 3 by accident. `emphasis: '_'` is
 *  set explicitly because remark-stringify's default is `*`; `strong: '*'` is already the
 *  default and is named here only so the option is not a silent implicit. `resourceLink:
 *  true` disables mdast-util-to-markdown's autolink shorthand — without it, a link whose
 *  label equals its href (which is exactly what `<https://example.org/>` parses to) is
 *  written back AS an autolink, so assertion 3 would accept the very construct the
 *  prohibited-constructs list rejects by name. */
const inlineParser = unified().use(remarkParse).use(remarkGfm);
const inlineStringifier = unified()
  .use(remarkStringify, { emphasis: '_', strong: '*', resourceLink: true })
  .use(remarkGfm);

/** The node types InlineText permits, at any depth. Most of the prohibited constructs —
 *  images, footnotes, strikethrough, raw HTML, hard breaks (`break`), reference-style links
 *  — parse to a node type outside this set and are excluded BY CONSTRUCTION: a new
 *  remark-gfm node type has to be added here deliberately, rather than a blocklist missing
 *  it by omission. Autolinks are the exception — `<https://x/>` parses to the same `link`
 *  type as `[x](https://x/)` — so that one is caught by the canonical-form assertion below,
 *  not by this allowlist. */
const ALLOWED_INLINE_NODE_TYPES = new Set(['paragraph', 'text', 'strong', 'emphasis', 'inlineCode', 'link']);

interface MdastNode {
  type: string;
  children?: MdastNode[];
}

function collectNodeTypes(node: MdastNode, out: string[]): void {
  out.push(node.type);
  for (const child of node.children ?? []) collectNodeTypes(child, out);
}

/** The three assertions that make inline markdown canonical, in order, plus one guard the
 *  AST cannot express: a bare `\n` inside a single paragraph is CommonMark whitespace, folded
 *  into the surrounding `text` node's value rather than parsed as a node of its own, so no
 *  node-type check can catch it — it is rejected directly against the raw string instead.
 *  Each check returns on failure rather than accumulating: a value that fails assertion 1
 *  has no paragraph node for assertion 2 to walk, and a value that fails assertion 2 may
 *  contain a node type the stringifier does not know how to print, so assertion 3 must not
 *  run against it. */
export function inlineTextCheck(value: string, ctx: z.RefinementCtx): void {
  if (value.includes('\n')) {
    ctx.addIssue('must not contain a line break');
    return;
  }

  const ast = inlineParser.parse(value) as unknown as MdastNode;
  const children = ast.children ?? [];
  if (children.length !== 1 || children[0].type !== 'paragraph') {
    ctx.addIssue('must be exactly one paragraph of inline content');
    return;
  }

  const types: string[] = [];
  collectNodeTypes(children[0], types);
  const stray = types.find(t => !ALLOWED_INLINE_NODE_TYPES.has(t));
  if (stray) {
    ctx.addIssue(`disallowed inline construct: ${stray}`);
    return;
  }

  const canonical = inlineStringifier.stringify(ast as never).trimEnd();
  if (canonical !== value) {
    ctx.addIssue(
      'must be canonical inline markdown — e.g. **bold**, _italic_, `code`, [label](https://example.org/)',
    );
  }
}

/** Inline markdown, restricted marks only: bold, italic, inline code, external link.
 *  A real validator, not a bare string — inlineTextCheck carries the node allowlist and the
 *  canonical-form assertion that makes `**bold**` vs `*bold*` decidable without enumerating
 *  cases. */
export const InlineText = z.string().superRefine(inlineTextCheck);

/** Icons are DESIGN, not content — they never live in content/media/. The enum is closed,
 *  and the validator asserts it equals the `design/icons/*.svg` listing in BOTH directions,
 *  so adding a thirteenth is a deliberate two-part change rather than a silent one. */
export const ICONS = [
  'bolt', 'shield', 'globe', 'clock', 'chart', 'lock',
  'sparkle', 'check', 'cloud', 'code', 'heart', 'users',
] as const;
export const Icon = z.enum(ICONS);

/** An outbound URL. `http:` is rejected outright — a marketing site linking over plaintext
 *  is a defect, and excluding it removes a case the validator would otherwise have to check
 *  for. Whether a URL is internal-absolute (and so not allowed here) is decided by the
 *  validator against Settings.baseUrl; a schema cannot see Settings. */
export const ExternalUrl = z.string().url()
  .refine(u => ['https:', 'mailto:', 'tel:'].includes(new URL(u).protocol),
    'must be https, mailto or tel');

/**
 * A media reference. `alt` lives here rather than on the asset, because the asset is
 * locale-neutral and alt text is content that must be translated.
 * Decorative images are declared, never signalled by an empty string.
 */
export const MediaRef = z.union([
  z.object({ ref: MediaPath, alt: z.string().min(1), decorative: z.literal(false).optional() }),
  z.object({ ref: MediaPath, decorative: z.literal(true) }).strict(),
]);

/** An internal link. Targets a translation GROUP, never an entity id. Resolution to the
 *  referring entity's locale happens in src/lib/links.ts, which throws rather than
 *  producing a broken link. */
export const Link = z.object({ label: z.string().min(1), ref: Ulid });
