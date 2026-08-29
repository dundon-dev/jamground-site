// Contract Block -> WordPress block markup.
// Export direction only: the import path must build a real block tree with
// createBlock() and emit markup with serialize(), never hand-templated HTML, because
// Gutenberg validates a block by re-running its save() and string-comparing the result.
//
// Takes the block API as an argument, the same discipline wp-blocks.mjs uses, so this one
// module runs both inside the browser bundle (registerCoreBlocks already called there) and
// in this Node test (registerCoreBlocks called by domshim's caller).
import { inlineToHtml } from './inline-to-html.mjs';

// `citation` and a code block's `text` are plain strings, not InlineText, so they are
// HTML-entity-escaped rather than run through the markdown-aware inlineToHtml.
const escHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One level of list (List/ListL2/ListL3) -> a core/list block whose children are
 *  core/list-item blocks. A nested `.list` becomes an innerBlock of its list-item, which is
 *  the only way Gutenberg represents nesting (a whole core/list inside a core/list-item) —
 *  the same recursion covers all three schema levels because their item shape is uniform. */
function listToWp(api, list) {
  const items = list.items.map((item) => {
    const inner = item.list ? [listToWp(api, item.list)] : [];
    return api.createBlock('core/list-item', { content: inlineToHtml(item.text) }, inner);
  });
  return api.createBlock('core/list', { ordered: !!list.ordered }, items);
}

/** One contract `table` -> `core/table`'s `head`/`body` attributes. Neither is a flat array
 *  of cells: each is an array of ROWS, and a row is `{ cells: [{ content, tag }] }`. `tag`
 *  is what core's own save() emits the cell as, so header cells must say `th` and body cells
 *  `td` or the markup contract (`<thead><tr><th>`, `<tbody><tr><td>`) is not met and the
 *  block re-parses invalid. The contract's `head` is ONE row, so it becomes a one-element
 *  array here; there is no `foot`, and core's default `[]` for it is left untouched. */
function tableToWp(api, block) {
  const cells = (row, tag) => ({ cells: row.map((cell) => ({ content: inlineToHtml(cell), tag })) });
  return api.createBlock('core/table', {
    head: [cells(block.head, 'th')],
    body: block.rows.map((row) => cells(row, 'td')),
  });
}

/** Map one contract block to the matching WordPress block, built with createBlock()
 *  so serialize() produces markup that re-parses as isValid. Seven types are in scope:
 *  heading, paragraph, list, quote, code, table, separator — every core-derived type except
 *  `image`, which needs a media upload path that does not exist yet (import.mjs:12) and so
 *  stays refused here. */
export function blockToWp(api, block) {
  switch (block.type) {
    case 'heading':
      return api.createBlock('core/heading', {
        level: block.level,
        content: inlineToHtml(block.text),
      });
    case 'paragraph':
      return api.createBlock('core/paragraph', { content: inlineToHtml(block.text) });
    case 'list':
      return listToWp(api, block);
    case 'quote': {
      const inner = [api.createBlock('core/paragraph', { content: inlineToHtml(block.text) })];
      const attrs = block.citation ? { citation: escHtml(block.citation) } : {};
      return api.createBlock('core/quote', attrs, inner);
    }
    // A code block's `text` is PLAIN TEXT — `Code` is `{ type, text: z.string() }`, with no
    // `.min(1)` and no `language`. `core/code`'s `content` is a rich-text attribute, so it is
    // HTML: a `<` reaching it unescaped is read as a tag and the rest of the sample is EATEN.
    // It goes through `escHtml`, never `inlineToHtml` — which would read `**bold**` in a code
    // sample as a mark and rewrite the sample as `<strong>bold</strong>`. An empty `text` is
    // legal and serialises to `<code></code>`.
    case 'code':
      return api.createBlock('core/code', { content: escHtml(block.text) });
    case 'table':
      return tableToWp(api, block);
    // `Separator` carries only `type`, and core's markup carries its two default classes
    // (`wp-block-separator has-alpha-channel-opacity`) unconditionally — from `opacity`'s and
    // `tagName`'s registered defaults, which is why no attribute is set here.
    case 'separator':
      return api.createBlock('core/separator', {});
    default:
      throw new Error(`unmapped contract block type: ${block.type}`);
  }
}

/** Map a list of contract blocks to WordPress block markup, via createBlock() and
 *  serialize() only — never hand-templated. */
export function blocksToMarkup(api, blocks) {
  return api.serialize(blocks.map((block) => blockToWp(api, block)));
}
