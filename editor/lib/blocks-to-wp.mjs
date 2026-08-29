// Contract Block -> WordPress block markup.
// Export direction only: the import path must build a real block tree with
// createBlock() and emit markup with serialize(), never hand-templated HTML, because
// Gutenberg validates a block by re-running its save() and string-comparing the result.
//
// Takes the block API as an argument, the same discipline wp-blocks.mjs uses, so this one
// module runs both inside the browser bundle (registerCoreBlocks already called there) and
// in this Node test (registerCoreBlocks called by domshim's caller).
import { inlineToHtml } from './inline-to-html.mjs';

// citation is a plain string, not InlineText, so it is HTML-entity-escaped rather
// than run through the markdown-aware inlineToHtml.
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

/** Map one contract block to the matching WordPress block, built with createBlock()
 *  so serialize() produces markup that re-parses as isValid. Four types are in
 *  scope: heading, paragraph, list, quote — everything the two seed posts exercise. */
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
    default:
      throw new Error(`unmapped contract block type: ${block.type}`);
  }
}

/** Map a list of contract blocks to WordPress block markup, via createBlock() and
 *  serialize() only — never hand-templated. */
export function blocksToMarkup(api, blocks) {
  return api.serialize(blocks.map((block) => blockToWp(api, block)));
}
