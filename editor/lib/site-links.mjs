// The addresses wp-admin's own links should point at.
//
// WordPress resolves "View Page", "Preview" and the admin bar's site name through
// `home_url()`, which in Playground is the scoped WASM origin with plain `?p=` permalinks.
// Those addresses are not the site: they render this instance's own theme, and the site is
// built by Astro from the content repository. This module produces the real ones and writes
// them where the mu-plugin's section 13 can look them up.
//
// THREE PROPERTIES ARE LOAD-BEARING.
//
// 1. NO ROUTE IS BUILT HERE. `src/lib/links.ts` holds the routing table exactly once, and
//    each kind's helper is a field on its KINDS row (`sitePath`), so this module never learns
//    what a page's path looks like — it calls the helper and stores the answer. The
//    `slug === 'home'` special case is `pathForPage`'s, and is never restated.
//
// 2. THE MAP TRAVELS AS DATA, NOT AS PHP. Same discipline read-posts.mjs states for the
//    post-type list: nothing composes PHP around a value, ever, so there is no case in which
//    a slug could break out of a string. What lands on disk is a JSON object of post id to
//    path, and the mu-plugin does a lookup with no arithmetic.
//
// 3. IT IS BUILT FROM THE SAVED STATE, ON PURPOSE. Every path uses each row's TOP-LEVEL
//    `slug` — read-posts.mjs's "the slug the file on disk currently has" — never
//    `frontmatter.slug`, which is whatever WordPress currently holds and may be an unsaved
//    edit. The staging site serves what the last save wrote, so a map built from the unsaved
//    value would link to an address that does not answer. Being one save behind is not a
//    limitation here; it is agreement with the site being linked to.
import { KINDS } from './kinds.mjs';
import { pathForHome } from '../../src/lib/links.ts';

/** Where the mu-plugin reads it from: `ABSPATH . 'jp-site-links.json'`, the `jp-`-prefixed
 *  sibling of read-posts.mjs's own data file, in the document root. */
export const SITE_LINKS_FILE = 'jp-site-links.json';

/**
 * WHICH ENTITIES GET AN ADDRESS, AND WHY IT DEPENDS ON THE ORIGIN.
 *
 * A staging site is built with `JAMGROUND_INCLUDE_DRAFTS=1` and renders drafts; the production
 * build excludes them. So while a change is open every entity has an address, and while none
 * is open a draft has one nowhere in the world. An entity with no address gets no entry, and
 * the mu-plugin removes the link rather than pointing it somewhere untrue.
 *
 * An entity created during this session is covered by the same rule without a case of its own:
 * no save has written it, so it is not in the rows this is built from.
 */
export function buildSiteLinks({ posts, origin, includeDrafts }) {
  if (!origin) {
    throw new Error('buildSiteLinks: an origin is required — there is no relative address for a link out of wp-admin');
  }

  const byPostId = {};
  let locale = null;

  for (const post of posts) {
    const spec = KINDS[post.kind];
    if (!spec) {
      // Naming it rather than dropping it: a kind with no row is a kinds.mjs omission, and a
      // silently missing link would read as "this entity is not on the site yet".
      throw new Error(`buildSiteLinks: no kind row for "${post.kind}" (post ${post.id})`);
    }
    if (!spec.sitePath) {
      throw new Error(`buildSiteLinks: kind "${post.kind}" declares no sitePath`);
    }

    const { locale: entityLocale, status } = post.frontmatter;
    // BEFORE the draft filter, deliberately. The front page's address is a function of the
    // locale alone, so it does not depend on any one entity being published — and taken after
    // the filter it was empty for a content set that happened to be all drafts, which removed
    // the site name from the admin bar for no reason connected to the front page.
    if (locale === null) locale = entityLocale;

    if (!includeDrafts && status !== 'published') {
      continue;
    }
    // The baseline slug, never frontmatter.slug — see property 3 in the header.
    byPostId[String(post.id)] = spec.sitePath(entityLocale, post.slug);
  }

  return {
    origin,
    // The site name in the admin bar links to the front page, which belongs to no entity's
    // row — `pathForHome` is the routing table's answer for it. With no rows at all there is
    // no locale to ask about, and the node is removed instead.
    homePath: locale === null ? '' : pathForHome(locale),
    byPostId,
  };
}

/**
 * Write the map into the WASM filesystem's document root.
 *
 * `client.writeFile` works at any time after boot, which is what lets the origin change when a
 * change opens and change back when it is published. PHP here is per-request, so the next page
 * load picks this up.
 */
export async function writeSiteLinks({ client, posts, origin, includeDrafts }) {
  const links = buildSiteLinks({ posts, origin, includeDrafts });
  const root = await client.documentRoot;
  await client.writeFile(`${root}/${SITE_LINKS_FILE}`, JSON.stringify(links));
  return links;
}
