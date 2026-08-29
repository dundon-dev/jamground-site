// Export: Gutenberg block markup -> a contract entity, on save.
//   1. Parse block markup from the modified entity
//   2. Map blocks back to contract types; fail loudly on any unmapped
//      block or non-contract attribute
//   3. (media rewrite — out of scope: the seed repository has none)
//   4. Preserve `id`, append to `slugHistory` if `slug` changed, update `updatedAt`
//   5. (write/commit/push — the shell's job, not this pure module's)
//
// Steps 1-4 are the same for every kind: block markup is block markup, and the envelope rules
// are the envelope's. The kind is consulted ONCE, at the final assembly — a post's blocks
// become markdown behind a frontmatter fence, a page's are a field of its own YAML document —
// and that assembly is the kind table's `serialise`, not a `switch` here.
//
// The four contract block types in scope — heading, paragraph, list, quote — are exactly
// the ones `blocks-to-wp.mjs` (the reverse direction) and `blocks-to-mdast.mjs` cover: what
// the seed content exercises. A block outside `attribute-guard.mjs`'s allowlist is refused
// there; one inside it but outside these four throws here, naming itself, rather than being
// silently dropped.
import { guardExportTree } from './attribute-guard.mjs';
import { htmlToInline } from './html-to-inline.mjs';
import { blocksToMdast } from './blocks-to-mdast.mjs';
import { kindSpec } from './kinds.mjs';
import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';

// The one canonical markdown setting set — used both to
// stringify a whole document body and, wrapped in a throwaway paragraph, to stringify a run
// of inline nodes to the same string an InlineText field holds. Mirrors
// `src/lib/mdast-to-blocks.ts`, which the import direction (mdast -> blocks) already uses;
// two independently-tuned stringifiers would be a second source of truth for the same
// settings.
const stringifier = unified()
  .use(remarkStringify, {
    bullet: '-', emphasis: '_', strong: '*', fences: true,
    listItemIndent: 'one', rule: '-', ruleSpaces: false, resourceLink: true,
  })
  .use(remarkGfm);

function inlineText(nodes) {
  return stringifier.stringify({ type: 'root', children: [{ type: 'paragraph', children: nodes }] }).trimEnd();
}

// A block's `content` (and `core/quote`'s `citation`) attribute is HTML — the export
// direction is untrusted input, so it goes through `htmlToInline`'s mark-level
// allowlist before it can become an InlineText value.
const htmlAttrToText = (html) => inlineText(htmlToInline(String(html ?? '')));

// The exact reverse of `blocks-to-wp.mjs`'s `escHtml` — `citation` is a plain
// string, not InlineText, so it is HTML-unescaped rather than run through `htmlToInline`.
// Order matters: `&quot;` before `&gt;`/`&lt;` before `&amp;`, or a double-escaped entity
// would be corrupted.
const unescHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** One level of `core/list` (with `core/list-item` children) back to List/ListL2/ListL3 —
 *  the reverse of `blocks-to-wp.mjs`'s `listToWp`. A nested `core/list` lives as
 *  an innerBlock of its `core/list-item`, the only way Gutenberg represents nesting. */
function listWpToContract(block) {
  const items = block.innerBlocks.map((li) => {
    const text = htmlAttrToText(li.attributes.content);
    const nested = (li.innerBlocks ?? []).find((b) => b.name === 'core/list');
    return nested ? { text, list: listWpToContract(nested) } : { text };
  });
  return { ordered: !!block.attributes.ordered, items };
}

/** Map one guarded WordPress block to its contract block. Throws, naming
 *  the block, on anything outside the four in-scope types — fail loudly on any
 *  unmapped block, rather than silently dropping it. */
export function wpBlockToContractBlock(block) {
  switch (block.name) {
    case 'core/heading':
      return { type: 'heading', level: block.attributes.level, text: htmlAttrToText(block.attributes.content) };
    case 'core/paragraph':
      return { type: 'paragraph', text: htmlAttrToText(block.attributes.content) };
    case 'core/list':
      return { type: 'list', ...listWpToContract(block) };
    case 'core/quote': {
      const paragraph = (block.innerBlocks ?? []).find((b) => b.name === 'core/paragraph');
      const text = htmlAttrToText(paragraph?.attributes.content);
      const rawCitation = block.attributes.citation;
      const citation = rawCitation ? unescHtml(String(rawCitation)) : undefined;
      return citation ? { type: 'quote', text, citation } : { type: 'quote', text };
    }
    default:
      throw new Error(`export: unmapped block "${block.name}" (03 §Export-Gutenberg step 2)`);
  }
}

/** Parse block markup, guard every block's attributes, and map the guarded
 *  tree to contract blocks. `api` needs `parse` and
 *  `getBlockType`, the same discipline the rest of `editor/lib` uses. */
export function markupToContractBlocks(api, markup) {
  const parsed = api.parse(markup);
  const guarded = guardExportTree(api, parsed);
  return guarded.map(wpBlockToContractBlock);
}

/** Block markup -> the canonical markdown a Post's frontmatter fence encloses. */
export function markupToBody(api, markup) {
  const blocks = markupToContractBlocks(api, markup);
  return stringifier.stringify(blocksToMdast(blocks));
}

/** The export path in full: block markup plus the entity's envelope
 *  fields -> a canonical contract file, ready to write under `content/`.
 *
 * `kind` names the row of the kind table that decides what the finished file looks like. It is
 * REQUIRED and is not defaulted: a missing kind means the caller lost track of what it was
 * holding, and guessing "post" would write a page out as fenced markdown — the exact silent
 * corruption the kind table exists to prevent. `kindSpec` throws instead, naming it.
 *
 * Everything before that final assembly is kind-independent and stays here. `frontmatter` is
 * the contract envelope — a page's `blocks` field is NOT part of it (entity.mjs lifts it out),
 * because the blocks written are the ones the editor just produced, not the ones on disk —
 * with whatever the editor changed already applied by the caller; deciding what changed is the
 * caller's job (it has session state this pure module does not). `id` is carried through
 * unconditionally because `frontmatter` already has it and this function never touches it.
 * `previousSlug` is the slug the file on disk currently has; `slugHistory` grows only when
 * `frontmatter.slug` differs from it, and a kind may also refuse a particular rename (pages
 * refuse losing the homepage). `updatedAt` is supplied by the caller — a pure module does not
 * read the wall clock. */
export function exportEntity({ kind, api, markup, frontmatter, previousSlug, updatedAt }) {
  const spec = kindSpec(kind, 'exportEntity');
  const blocks = markupToContractBlocks(api, markup);

  const history = frontmatter.slug !== previousSlug
    ? [...(frontmatter.slugHistory ?? []), previousSlug]
    : frontmatter.slugHistory;

  const next = { ...frontmatter, updatedAt };
  if (history && history.length > 0) next.slugHistory = history;
  else delete next.slugHistory;

  return spec.serialise({
    frontmatter: next,
    blocks,
    previousSlug,
    toMarkdown: (bs) => stringifier.stringify(blocksToMdast(bs)),
  });
}

/** The post-shaped entry point, kept as a thin wrapper for the tests whose subject really is
 *  posts. */
export function exportPost(args) {
  return exportEntity({ ...args, kind: 'post' });
}
