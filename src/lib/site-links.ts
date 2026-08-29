/* The one place `astro:content` meets the pure resolver in ./links.ts.
 *
 * Split out rather than folded in so that links.ts imports nothing virtual and stays
 * loadable by plain Node — test/contract/links.test.mjs imports it directly, with object
 * literals for fixtures. This file is imported only by .astro files, so the `astro:content`
 * specifier never reaches a plain-Node test runner. */
import { getCollection } from 'astro:content';
import { buildLinkIndex } from './links.ts';
import type { LinkIndex } from './links.ts';

/** Builds the (group, locale) index over every entity that can be a link target.
 *
 *  DELIBERATELY NOT MEMOIZED at module scope. test/gates/drafts.test.mjs and
 *  test/gates/schema-violation.test.mjs each run three builds inside ONE process against
 *  three different JAMGROUND_CONTENT_DIR values; a module-scope cache would serve the first
 *  build's content to the second and third, and the failure would look like a content bug
 *  rather than a caching one. Betting correctness on Vite re-instantiating this module per
 *  build is exactly the kind of implicit assumption this repo writes comments to forbid.
 *  `getCollection` is itself cached per build and this site has seven routes, so the cost is
 *  noise. */
export async function loadLinkIndex(): Promise<LinkIndex> {
  const [pages, posts, authors] = await Promise.all([
    getCollection('pages'),
    getCollection('posts'),
    getCollection('authors'),
  ]);
  const target = (entry: { data: Record<string, unknown> }) => ({
    id: entry.data.id as string,
    translationOf: entry.data.translationOf as string,
    locale: entry.data.locale as string,
    slug: entry.data.slug as string,
    status: entry.data.status as 'draft' | 'published',
  });
  return buildLinkIndex({
    pages: pages.map(target),
    posts: posts.map(target),
    authors: authors.map(target),
  });
}
