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
// The seven contract block types in scope — heading, paragraph, list, quote, code, table,
// separator — are exactly the ones `blocks-to-wp.mjs` (the reverse direction) and
// `blocks-to-mdast.mjs` cover. `image` is the one core-derived type still missing, because it
// needs a media upload path that does not exist (import.mjs:12). A block outside
// `attribute-guard.mjs`'s allowlist is refused there; one inside it but outside these seven
// throws here, naming itself, rather than being silently dropped.
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

// The exact reverse of `blocks-to-wp.mjs`'s `escHtml` — `citation` and a code block's `text`
// are plain strings, not InlineText, so they are HTML-unescaped rather than run through
// `htmlToInline`. Order matters: `&quot;` before `&gt;`/`&lt;` before `&amp;`, or a
// double-escaped entity would be corrupted.
const unescHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** One level of `core/list` (with `core/list-item` children) back to List/ListL2/ListL3 —
 *  the reverse of `blocks-to-wp.mjs`'s `listToWp`. A nested `core/list` lives as
 *  an innerBlock of its `core/list-item`, the only way Gutenberg represents nesting.
 *
 *  AN UNORDERED LIST OMITS `ordered` RATHER THAN WRITING `false`, which is the same shape the
 *  `core/quote` arm below already uses for its own optional attribute. `List.ordered` is
 *  `.optional()` at all three levels and no schema in this contract carries a `.default()`
 *  (blocks.ts:101-107) — absent means the renderer's default, and `List.astro` renders absent
 *  and `false` identically (`ordered ? 'ol' : 'ul'`). Writing the key unconditionally
 *  materialised an absent optional, so a list authored the way the contract says was re-exported
 *  with `ordered: false`, failed import.mjs's byte comparison, and was held back at boot —
 *  built fine, uneditable, and silent about why. `false` is also `core/list`'s registered
 *  default, so this is the write-side of the rule attribute-guard.mjs already applies when
 *  checking: a value still equal to its registered default is not information. */
function listWpToContract(block) {
  const items = block.innerBlocks.map((li) => {
    const text = htmlAttrToText(li.attributes.content);
    const nested = (li.innerBlocks ?? []).find((b) => b.name === 'core/list');
    return nested ? { text, list: listWpToContract(nested) } : { text };
  });
  return block.attributes.ordered ? { ordered: true, items } : { items };
}

/** One `core/table` row (`{ cells: [{ content, tag }] }`) back to the contract's flat array of
 *  `InlineText` cells. `htmlAttrToText` runs PER CELL — a cell's `content` is a rich-text
 *  attribute holding inline HTML, exactly as a paragraph's is, so it goes through the same
 *  mark-level allowlist. `tag` is not carried: the contract decides `th` vs `td` from which
 *  of `head`/`rows` the cell is in, and `blocks-to-wp.mjs` writes it back on the way in. */
const tableRowToCells = (row) => (row.cells ?? []).map((cell) => htmlAttrToText(cell.content));

/** Map one guarded WordPress block to its contract block. Throws, naming
 *  the block, on anything outside the seven in-scope types — fail loudly on any
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
    // PLAIN TEXT, not InlineText. `Code.text` is a bare `z.string()`, and `core/code`'s
    // `content` is HTML-escaped plain text, so this is `unescHtml` — the reverse of the
    // `escHtml` the import direction applies. NEVER `htmlAttrToText`: running a code sample
    // through the markdown-aware path would read `<strong>` in it as a mark and hand back
    // `**bold**`, rewriting the sample. `?? ''` because an empty code block is legal.
    case 'core/code':
      return { type: 'code', text: unescHtml(String(block.attributes.content ?? '')) };
    case 'core/table': {
      // `head`/`body` are arrays of ROWS, not of cells. `Table.head` is one row and
      // `Table.rows` is `.min(1)`, so anything else has no contract shape to go into —
      // refuse, naming it, rather than flattening two header rows into one or emitting a
      // table with an empty header, either of which would be silent loss. (`foot` needs no
      // check here: the attribute guard already refuses it once it leaves its `[]` default.)
      const head = block.attributes.head ?? [];
      const body = block.attributes.body ?? [];
      if (head.length !== 1) {
        throw new Error(`export: a table needs exactly one header row, found ${head.length}`);
      }
      if (body.length === 0) throw new Error('export: a table needs at least one body row');
      return { type: 'table', head: tableRowToCells(head[0]), rows: body.map(tableRowToCells) };
    }
    // No attributes at all: `Separator` carries only `type`, and the two classes core's
    // markup always shows come from `opacity`/`tagName` still being at their defaults.
    case 'core/separator':
      return { type: 'separator' };
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
