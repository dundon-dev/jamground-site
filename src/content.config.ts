/* Astro content collections config. `settings/` and `media/` are
 * locale-neutral and have no locale directory, so `settings/` is not a collection
 * at all: both its files carry no envelope and no `id`, so
 * `glob({ generateId: ({ data }) => data.id })` cannot key them — it is a plain module
 * read below instead, and a `Settings` parse failure throws at config load, so `astro
 * build` exits non-zero. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { parse } from 'yaml';
import { Page, Post, Author, Navigation, Settings, Redirects } from './contract/entities.ts';
import { resolveContentRoot } from './contract/env.ts';

const generateId = ({ data }: { data: Record<string, unknown> }) => data.id as string;

// Every collection glob below is two literal segments — one locale directory, one entry
// file — not the recursive form. That is what enforces "exactly one locale directory": a
// nested subdirectory inside a locale directory would carry meaning the contract denies
// (filenames carry no meaning), and the recursive form would silently admit it instead of
// rejecting it.
const LOCALE_ENTRY_PATTERN = '*/*';

const contentRoot = resolveContentRoot();

const pages = defineCollection({
  loader: glob({ pattern: LOCALE_ENTRY_PATTERN, base: join(contentRoot, 'pages'), generateId }),
  schema: Page,
});

const posts = defineCollection({
  loader: glob({ pattern: LOCALE_ENTRY_PATTERN, base: join(contentRoot, 'posts'), generateId }),
  schema: Post,
});

const authors = defineCollection({
  loader: glob({ pattern: LOCALE_ENTRY_PATTERN, base: join(contentRoot, 'authors'), generateId }),
  schema: Author,
});

const navigation = defineCollection({
  loader: glob({ pattern: LOCALE_ENTRY_PATTERN, base: join(contentRoot, 'navigation'), generateId }),
  schema: Navigation,
});

export const collections = { pages, posts, authors, navigation };

// settings/ cannot load through the collection mechanism above — see the file-level note.
export const settings = Settings.parse(parse(readFileSync(join(contentRoot, 'settings/site.yaml'), 'utf8')));
export const redirects = existsSync(join(contentRoot, 'settings/redirects.yaml'))
  ? Redirects.parse(parse(readFileSync(join(contentRoot, 'settings/redirects.yaml'), 'utf8')))
  : { redirects: [] };
