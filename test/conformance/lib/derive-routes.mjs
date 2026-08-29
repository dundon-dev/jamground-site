/* Independent route derivation: the routes derivable from content/
 * must equal the HTML files in dist/. Deliberately does not import src/pages/**'s own
 * getStaticPaths — the whole point of the assertion is to catch a route file that has
 * silently diverged from what content/ actually says, so this walks content/ on disk and
 * validates every entry through the same schemas the build itself uses (src/contract), not
 * through the routes that are being checked. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveContentRoot } from '../../../src/contract/env.ts';
import { Page, Post, Author, Settings } from '../../../src/contract/entities.ts';
import { localeToSegment } from '../../../src/contract/defs.ts';

// Matches tools/check-seed-canonical.mjs's own frontmatter delimiter — only the envelope
// between the `---` fences is YAML; the rest of a post file is its markdown body.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function readEntries(contentRoot, collection) {
  const base = join(contentRoot, collection);
  const entries = [];
  if (!existsSync(base)) return entries;
  for (const localeEntry of readdirSync(base, { withFileTypes: true })) {
    if (!localeEntry.isDirectory()) continue;
    const localeDir = join(base, localeEntry.name);
    for (const file of readdirSync(localeDir)) {
      const raw = readFileSync(join(localeDir, file), 'utf8');
      const yamlSource = file.endsWith('.md') ? raw.match(FRONTMATTER)?.[1] : raw;
      if (yamlSource === undefined) {
        throw new Error(`${collection}/${localeEntry.name}/${file}: no frontmatter delimiters found`);
      }
      entries.push(parseYaml(yamlSource));
    }
  }
  return entries;
}

/** The set of HTML paths (relative to dist/, forward-slashed) that content/ and settings/
 *  entail, given production defaults — drafts excluded, the same default the build itself
 *  uses unless JAMGROUND_INCLUDE_DRAFTS is set. Two routes per locale are settings-derived
 *  rather than entity-derived, and are included for that reason rather than smuggled in: the
 *  per-locale 404 page and, once only, the root-level 404.html fallback. */
export function deriveExpectedRoutes() {
  const contentRoot = resolveContentRoot();
  const settings = Settings.parse(parseYaml(readFileSync(join(contentRoot, 'settings/site.yaml'), 'utf8')));

  const pages = readEntries(contentRoot, 'pages').map((d) => Page.parse(d));
  const posts = readEntries(contentRoot, 'posts').map((d) => Post.parse(d));
  const authors = readEntries(contentRoot, 'authors').map((d) => Author.parse(d));

  const routes = new Set(['404.html']);

  for (const locale of settings.locales) {
    const seg = localeToSegment(locale);
    routes.add(`${seg}/404/index.html`);

    const published = (list) => list.filter((entry) => entry.locale === locale && entry.status !== 'draft');

    for (const page of published(pages)) {
      routes.add(page.slug === 'home' ? `${seg}/index.html` : `${seg}/${page.slug}/index.html`);
    }

    const localePosts = published(posts);
    if (localePosts.length > 0) routes.add(`${seg}/blog/index.html`);
    for (const post of localePosts) routes.add(`${seg}/blog/${post.slug}/index.html`);

    for (const author of published(authors)) routes.add(`${seg}/authors/${author.slug}/index.html`);

    const tags = new Set();
    for (const post of localePosts) for (const tag of post.tags ?? []) tags.add(tag);
    for (const tag of tags) routes.add(`${seg}/tags/${tag}/index.html`);
  }

  return routes;
}
