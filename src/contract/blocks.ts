/* The block catalogue. Eleven types, one discriminated union; Page is
 * Envelope.extend({ blocks: z.array(Block).min(1) }), so nothing in the contract renders or
 * exports without this. Adding a twelfth type is a deliberate schema change and costs a
 * Gutenberg block, a markup contract, an attribute allowlist, and round-trip and fidelity
 * fixtures — not just a line here. Shared leaf types (InlineText, MediaRef, Link, Icon) are
 * imported from `./defs.ts`, not re-derived; their own contracts (canonical-form checks,
 * non-emptiness) are exercised by defs.test.mjs, not repeated here. */
import { z } from 'zod';
import { InlineText, MediaRef, Link, Icon } from './defs.ts';

// ---- 4a. Core-derived types ----------------------------------------------------------------

const Paragraph = z.object({ type: z.literal('paragraph'), text: InlineText }).strict();

const Heading = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  text: InlineText,
}).strict();

/** Three levels, explicit rather than recursive. Each level carries its OWN `ordered`,
 *  because Gutenberg nests a whole `core/list` inside a `core/list-item` — anything less is
 *  lossy. The nested key is `list`, not `items`, so `items[].items` cannot be misread. Depth
 *  cap 3 mirrors the h2–h4 three-level constraint; a fourth level fails because `ListL3`'s
 *  item shape is `.strict()` with no `list` field for a fourth level to occupy. Do not type
 *  this as `z.array(z.any())` to sidestep the depth cap — that leaves nested lists entirely
 *  unvalidated and contradicts `.strict()` everywhere else here. */
const ListL3 = z.object({
  ordered: z.boolean().optional(),
  items: z.array(z.object({ text: InlineText }).strict()).min(1),
}).strict();

const ListL2 = z.object({
  ordered: z.boolean().optional(),
  items: z.array(z.object({ text: InlineText, list: ListL3.optional() }).strict()).min(1),
}).strict();

const List = z.object({
  type: z.literal('list'),
  ordered: z.boolean().optional(),
  items: z.array(z.object({ text: InlineText, list: ListL2.optional() }).strict()).min(1),
}).strict();

const Image = z.object({ type: z.literal('image'), media: MediaRef, caption: InlineText.optional() }).strict();

const Quote = z.object({
  type: z.literal('quote'),
  text: InlineText,
  citation: z.string().min(1).optional(),
}).strict();

// `text` has no `.min(1)` — one of two exceptions to the rule that every string field is
// `.min(1)`: an empty code block is meaningful (e.g. a placeholder). No `language` field
// either: `core/code` has no language attribute, so a fence info string round-trips to an
// unlabelled block and the language would be lost — deliberately not supported, rather than
// silently dropped by accident.
const Code = z.object({ type: z.literal('code'), text: z.string() }).strict();

// No merged cells. `head`/`rows` cells are `InlineText`, the shared type — reusing it,
// rather than a fresh unconstrained string, is what makes "Table cells" the other exception
// to "every string field is `.min(1)`": they need no standalone `.min(1)` because they carry
// no such check to begin with, unlike a hand-written `z.string()` field would.
const Table = z.object({
  type: z.literal('table'),
  head: z.array(InlineText).min(1),
  rows: z.array(z.array(InlineText)).min(1),
}).strict();

const Separator = z.object({ type: z.literal('separator') }).strict();

// ---- 4b. Custom jamground/* types -----------------------------------------------------------
// All three are dynamic — `save()` returns null, so the persisted form is a single
// self-closing delimiter carrying only attributes. There is no HTML to mismatch, so block
// validation cannot fail for them, and the mapping is close to an identity function.

const Hero = z.object({
  type: z.literal('hero'),
  heading: z.string().min(1),
  body: InlineText.optional(),
  media: MediaRef.optional(),
  cta: Link.optional(),
}).strict();

// The inner item shape is deliberately not `.strict()`, unlike every other block shape here
// — do not tighten it to match; the looseness is intentional, not an oversight.
const FeatureGrid = z.object({
  type: z.literal('featureGrid'),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  items: z.array(z.object({
    heading: z.string().min(1), body: InlineText, icon: Icon.optional(),
  })).min(2).max(12),
}).strict();

const Cta = z.object({
  type: z.literal('cta'),
  heading: z.string().min(1),
  body: InlineText.optional(),
  link: Link,
}).strict();

/** The discriminated union over all eleven block types. `.strict()` on every member
 *  object is deliberate: an unknown key is a defect, not something to ignore. No member
 *  schema carries a `.default()` anywhere — Zod materialises a default at parse time, and the
 *  canonical writer would then emit it, turning every unordered list in the repo into a
 *  spurious diff against its own canonical form. `.optional()` is used throughout instead, so
 *  absence stays absence; enforced by blocks.test.mjs, which walks this union and asserts no
 *  `ZodDefault` node is reachable. */
export const Block = z.discriminatedUnion('type', [
  Paragraph, Heading, List, Image, Quote, Code, Table, Separator, Hero, FeatureGrid, Cta,
]);
