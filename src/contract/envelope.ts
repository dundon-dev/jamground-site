/* The shared frontmatter envelope. Every content entity in both body formats carries this
 * metadata, serialised in exactly this key order — the canonical writer derives key order
 * from schema shape at every depth, so the declaration below IS the order of record; there
 * is no second list to drift. */
import { z } from 'zod';
import { Ulid, Locale, Slug, Timestamp, MediaRef } from './defs.ts';

export const Envelope = z.object({
  id:            Ulid,                             // immutable; never a URL; never the filename
  translationOf: Ulid,                             // the translation group; shared across locales
  locale:        Locale,                           // must match the containing directory
  slug:          Slug,                             // mutable, URL-facing, unique per locale
  slugHistory:   z.array(Slug).optional(),         // every previous slug; drives 301s
  title:         z.string().min(1),
  status:        z.enum(['draft', 'published']),   // per locale
  publishedAt:   Timestamp.optional(),
  updatedAt:     Timestamp,
  seo: z.object({
    title:       z.string().max(70).optional(),
    description: z.string().max(160).optional(),
    ogImage:     MediaRef.optional(),
    noindex:     z.boolean().optional(),
  }).optional(),
  /** Set on a translation when it is created; compared to the source to detect drift. */
  sourceHash:    z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).superRefine((v, ctx) => {
  // A published entity without a date leaves post ordering and sitemap lastmod undefined.
  // Legal on a draft, where it is the scheduling date.
  if (v.status === 'published' && !v.publishedAt)
    ctx.addIssue({ code: 'custom', path: ['publishedAt'],
                   message: 'publishedAt is required when status is published' });
});
