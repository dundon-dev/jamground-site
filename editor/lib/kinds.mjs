// The kind table: ONE declaration per content kind, read by every consumer that needs to
// know how a kind differs from another.
//
// Posts are markdown with a frontmatter fence; pages are whole YAML documents whose `blocks`
// field IS the contract block list; an author is a whole YAML document with no blocks at all,
// because a person is not a document. Those are the only real differences between them, and before
// this table it would have had to be re-derived — as a `switch`, or an extension test, or a
// second parser — in content-source.mjs, entity.mjs, import.mjs, read-posts.mjs and export.mjs
// independently. Five switches on the same fact drift apart one commit at a time, and the
// failure they drift into is not a crash: it is a page written back out through the markdown
// serialiser, which destroys the file. So the fact is declared once, here, and every consumer
// reads it.
//
// Adding a kind means adding a row. It must NOT mean adding a branch anywhere else.
import yaml from 'yaml';
import { Author, Page, Post } from '../../src/contract/entities.ts';
import { write } from '../../src/lib/canonical.ts';
import { mdastToBlocks } from '../../src/lib/mdast-to-blocks.ts';
import { pathForPage, pathForPost, pathForAuthor } from '../../src/lib/links.ts';
import { VOCAB, editorialError } from './vocabulary.mjs';

/** The slug `src/pages/[locale]/index.astro` selects the site's front page by, and that
 *  `src/pages/[locale]/[slug].astro` excludes from the ordinary page routes. The site has no
 *  other way to find its front page, so a page that stops carrying this slug stops being the
 *  homepage — see the refusal in the page serialiser below. */
const HOME_SLUG = 'home';

/**
 * Split a frontmatter-fenced markdown file into the YAML document and the body that follows.
 *
 *   ---
 *   frontmatter YAML here
 *   ---
 *   body markdown here
 *
 * This lived in entity.mjs and applied to every file it was given. It is now the POST kind's
 * parser and nothing else's, which is what makes it unreachable for a `.yaml` page — a page
 * has no fence to miss, so "Missing frontmatter fence" is a fact about the post format rather
 * than about content in general.
 */
function splitFrontmatterFence(path, raw) {
  const lines = raw.split('\n');

  if (lines.length === 0 || !lines[0].startsWith('---')) {
    throw new Error(`Missing frontmatter fence in ${path}`);
  }

  let closingFenceIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      closingFenceIndex = i;
      break;
    }
  }

  if (closingFenceIndex === -1) {
    throw new Error(`Missing closing frontmatter fence in ${path}`);
  }

  const frontmatterText = lines.slice(1, closingFenceIndex).join('\n');
  const bodyStart = closingFenceIndex + 1;
  const bodyLines = bodyStart < lines.length ? lines.slice(bodyStart) : [];
  // Remove the blank line immediately after the closing fence if present
  if (bodyLines.length > 0 && bodyLines[0] === '') {
    bodyLines.shift();
  }

  return { document: parseYaml(path, frontmatterText, 'frontmatter of '), body: bodyLines.join('\n') };
}

/** A whole-file YAML document: no fence, no body. `blocks` is a field of the document, so
 *  there is nothing following it to parse. */
function parseYamlDocument(path, raw) {
  return { document: parseYaml(path, raw, ''), body: '' };
}

function parseYaml(path, text, where) {
  try {
    return yaml.parse(text);
  } catch (err) {
    throw new Error(`Invalid YAML in ${where}${path}: ${err.message}`);
  }
}

/**
 * One row per kind:
 *
 *   dir         the directory under `content/` holding this kind, per locale
 *   ext         the file extension; the two together are the whole membership test
 *   schema      the contract schema the parsed document is validated against
 *   wpPostType  the WordPress post type its rows are filed as
 *   parse       raw bytes -> { document, body }: what to validate, and what follows it
 *   toBlocks    a parsed entity -> the contract `Block[]` the editor canvas is built from
 *   serialise   the envelope plus its blocks -> the exact bytes of the file on disk
 *   sitePath    (locale, slug) -> the path this kind's entities are served at on the SITE
 *
 * `sitePath` is src/lib/links.ts's own helper, referenced rather than reimplemented: that
 * module holds the routing table exactly once, and the `slug === 'home'` special case lives
 * inside `pathForPage` where it belongs. It is a row here rather than a lookup at the call
 * site for the reason at the top of this file — a fourth kind must not mean a fourth branch
 * in site-links.mjs.
 *
 * `serialise` receives one bag for every kind — `{ frontmatter, blocks, previousSlug,
 * toMarkdown }` — and each kind takes what it needs. `toMarkdown` is injected rather than
 * built here because export.mjs already owns the one canonical markdown stringifier, and two
 * independently-tuned stringifiers would be a second source of truth for the same settings.
 */
export const KINDS = {
  post: {
    dir: 'posts',
    ext: '.md',
    schema: Post,
    wpPostType: 'post',
    sitePath: pathForPost,
    parse: splitFrontmatterFence,
    // A post's body is markdown following the fence, not a schema field, so its blocks are
    // whatever that markdown maps to.
    toBlocks: (entity) => mdastToBlocks(entity.body),
    serialise: ({ frontmatter, blocks, toMarkdown }) =>
      `---\n${write(frontmatter, Post)}---\n\n${toMarkdown(blocks).trimEnd()}\n`,
  },

  page: {
    dir: 'pages',
    ext: '.yaml',
    schema: Page,
    wpPostType: 'page',
    sitePath: pathForPage,
    parse: parseYamlDocument,
    // `Page.blocks` IS the contract block list — there is no markdown step to undo.
    toBlocks: (entity) => entity.blocks,
    serialise: ({ frontmatter, blocks, previousSlug }) => {
      // THE HOMEPAGE HAZARD. `src/pages/[locale]/index.astro` finds the front page by
      // `slug === 'home'` and `[slug].astro` excludes that slug from the ordinary routes, so
      // renaming the home page in wp-admin does not move the homepage — it REMOVES it. The
      // build then fails, jamground-deploy never flips a failed build, and the live site keeps
      // serving the previous release; the editor's only signal is a staging site that never
      // appears. Refusing here is where they can see it.
      if (previousSlug === HOME_SLUG && frontmatter.slug !== HOME_SLUG) {
        throw editorialError(VOCAB.homePageAddressFixed);
      }
      // `Page.blocks` is `.min(1)`, so an emptied page would throw `Too small` out of the
      // canonical writer, reach the editor as "save did not complete — please try again", and
      // never work however many times they tried. Say the true and actionable thing instead.
      if (blocks.length === 0) {
        throw editorialError(VOCAB.pageNeedsContent);
      }
      // Safe at any object position: canonical.ts's `orderKeys` derives key order from
      // `Object.keys(schema.shape)`, and `Page = Envelope.extend({ blocks })` puts `blocks`
      // last by construction.
      return write({ ...frontmatter, blocks }, Page);
    },
  },

  author: {
    dir: 'authors',
    ext: '.yaml',
    schema: Author,
    wpPostType: 'jamground_author',
    sitePath: pathForAuthor,
    parse: parseYamlDocument,
    // AN AUTHOR IS NOT A DOCUMENT. `Author` has no `blocks` field — there is no list of
    // blocks on disk to build a canvas from, and `blocksToMarkup(api, [])` is `''`, so the
    // row's `post_content` is empty and stays empty. That is the whole of the difference
    // between this kind and a page, and it is stated here rather than as a branch in import.
    toBlocks: () => [],
    serialise: ({ frontmatter, blocks }) => {
      // The other half of the same fact. If content ever DID reach an author's body there
      // would be nowhere on disk to put it: `write(frontmatter, Author)` cannot carry it, so
      // it would be dropped at the next save with nothing said — the silent-loss case this
      // project refuses everywhere else. Refusing here makes it a save that fails and names
      // the person, rather than a save that succeeds and quietly discards their writing.
      // (The import-time round-trip check runs this same serialiser, so an author file that
      // somehow carried a body is held back before it ever gets a WordPress row.)
      if (blocks.length > 0) {
        throw editorialError(`${VOCAB.authorHasNoBody} ${frontmatter.title}`);
      }
      // `name`, `role`, `bio`, `avatar` and every other envelope field are carried straight
      // through from the baseline — this writer never names them, so it can never drop one.
      return write(frontmatter, Author);
    },
  },
};

/** Every kind name, in declaration order — the default set a consumer works over. */
export const KIND_NAMES = Object.keys(KINDS);

/** The WordPress post types our own rows are filed as. read-posts.mjs queries exactly these,
 *  never `'any'`, which would sweep in WordPress's own types and its revisions. */
export const WP_POST_TYPES = KIND_NAMES.map((kind) => KINDS[kind].wpPostType);

/** The kind a repository path belongs to, or `undefined` — the same directory-plus-extension
 *  membership test content-source.mjs filters the tree with. */
export function kindForPath(path) {
  if (typeof path !== 'string') return undefined;
  return KIND_NAMES.find((kind) =>
    path.startsWith(`content/${KINDS[kind].dir}/`) && path.endsWith(KINDS[kind].ext));
}

/** The kind a WordPress post type belongs to, or `undefined`. */
export function kindForWpPostType(postType) {
  return KIND_NAMES.find((kind) => KINDS[kind].wpPostType === postType);
}

/** The row for `kind`, or a throw naming it. A kind that reached here unknown means something
 *  upstream lost track of what it was holding, and the next step would pick a serialiser for
 *  it — so it stops here rather than guessing. */
export function kindSpec(kind, context) {
  const spec = KINDS[kind];
  if (!spec) {
    throw new Error(`${context}: unknown content kind ${JSON.stringify(kind)} (known kinds: ${KIND_NAMES.join(', ')})`);
  }
  return spec;
}
