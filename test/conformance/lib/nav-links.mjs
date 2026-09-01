/* Every href the primary navigation's `ref:` items resolve to, computed by the SAME resolver the
 * build uses.
 *
 * Why this exists rather than a literal in a test: `internal-links-resolve.test.mjs` needs to prove
 * that a `ref:` in navigation reached a real page route end to end — schema accepted it, links.ts
 * resolved it, SiteHeader rendered it, and it landed on a route that exists. Naming a slug to prove
 * that put a fact about the CONTENT repository into a gate in the CODE repository: renaming a page
 * or reordering the menu, which are editorial acts in a repository this one is deliberately
 * separate from, failed the build here. Asserting the SHAPE of an href instead is worse, not
 * better — `hero.cta` and `cta.link` resolve to exactly the same `/{locale}/{slug}/` shape from a
 * page body, so the moment those blocks are usable the assertion passes with an empty menu.
 *
 * So this reads the navigation as data and resolves it through `buildLinkIndex`/`navHref` — the
 * production functions, not a second implementation of them. It names no slug and survives any
 * editorial change; what it cannot survive is a `ref:` that stops resolving, which is the point.
 *
 * It returns an empty array when no navigation declares a `ref:` at all. That is honest rather than
 * a false green: the "the extractor found anything" job belongs to `all.length > 0` and to the
 * hermetic plants, and a menu of purely external links is a legitimate menu. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveContentRoot } from '../../../src/contract/env.ts';
import { Page, Post, Author, Navigation, Settings } from '../../../src/contract/entities.ts';
import { buildLinkIndex, linkContext, navHref } from '../../../src/lib/links.ts';

// Mirrors derive-routes.mjs's own delimiter: only the envelope between the `---` fences is YAML.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function readCollection(contentRoot, collection, schema) {
  const base = join(contentRoot, collection);
  const out = [];
  if (!existsSync(base)) return out;
  for (const localeEntry of readdirSync(base, { withFileTypes: true })) {
    if (!localeEntry.isDirectory()) continue;
    const localeDir = join(base, localeEntry.name);
    for (const file of readdirSync(localeDir)) {
      const raw = readFileSync(join(localeDir, file), 'utf8');
      const yamlSource = file.endsWith('.md') ? raw.match(FRONTMATTER)?.[1] : raw;
      if (yamlSource === undefined) {
        throw new Error(`${collection}/${localeEntry.name}/${file}: no frontmatter delimiters found`);
      }
      out.push(schema.parse(parseYaml(yamlSource)));
    }
  }
  return out;
}

/** Root-relative hrefs that navigation `ref:` items resolve to, across every locale, in menu
 *  order. Throws (via LinkResolutionError) if a `ref:` names a group that does not resolve —
 *  which is a genuine failure and should not be swallowed into an empty result. */
export function navRefHrefs() {
  const contentRoot = resolveContentRoot();
  const settings = Settings.parse(parseYaml(readFileSync(join(contentRoot, 'settings/site.yaml'), 'utf8')));

  const pages = readCollection(contentRoot, 'pages', Page);
  const posts = readCollection(contentRoot, 'posts', Post);
  const authors = readCollection(contentRoot, 'authors', Author);
  const index = buildLinkIndex({ pages, posts, authors });

  const hrefs = [];
  for (const nav of readCollection(contentRoot, 'navigation', Navigation)) {
    if (!settings.locales.includes(nav.locale)) continue;
    // Drafts are excluded from production, and this compares against a production build.
    const ctx = linkContext(index, { collection: 'navigation', ...nav }, false);
    const walk = (items) => {
      for (const item of items) {
        if (typeof item.ref === 'string') hrefs.push(navHref(ctx, item));
        if (item.children) walk(item.children);
      }
    };
    walk(nav.items);
  }
  return hrefs;
}
