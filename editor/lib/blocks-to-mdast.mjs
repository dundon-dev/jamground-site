// Convert contract Block objects to mdast, for stringification to canonical markdown.
// This is the reverse of src/lib/mdast-to-blocks.ts — it takes blocks and produces
// an mdast tree that can be stringified to canonical markdown.
// The canonical settings that must be applied when stringifying this tree are defined
// where the stringifier is built (see export.mjs).
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// Parser for extracting inline mdast nodes from text content.
const parser = unified().use(remarkParse).use(remarkGfm);

/** Parse a canonical markdown text string to extract its inline mdast nodes.
 *  Since the text is already in canonical form, we parse it as a paragraph and extract
 *  its children — these are the inline nodes that correspond to the original formatting. */
function parseInlineText(text) {
  const tree = parser.parse(text);
  // The parsed tree should have a paragraph node as its first (and typically only) child
  // when parsing plain text with inline formatting.
  const paragraph = tree.children.find((n) => n.type === 'paragraph');
  return paragraph ? paragraph.children : [{ type: 'text', value: text }];
}

/** Convert a list block (with nesting) back to mdast list node structure.
 *  Recursively handles nested lists up to 3 levels deep. */
function mapListToMdast(block, level = 1) {
  const children = block.items.map((item) => {
    const itemChildren = [
      { type: 'paragraph', children: parseInlineText(item.text) },
    ];
    if (item.list && level < 3) {
      itemChildren.push(mapListToMdast(item.list, level + 1));
    }
    return { type: 'listItem', spread: false, children: itemChildren };
  });

  return {
    type: 'list',
    ordered: block.ordered || false,
    spread: false,
    children,
  };
}

/** One row of contract cells -> an mdast `tableRow`. Each cell is `InlineText`, so it is
 *  parsed for its inline nodes exactly as a paragraph's text is; the surrounding stringifier
 *  decides the pipe escaping and column padding, which is why nothing is stringified here. */
const tableRow = (cells) => ({
  type: 'tableRow',
  children: cells.map((cell) => ({ type: 'tableCell', children: parseInlineText(cell) })),
});

/** Convert a single Block object to an mdast node.
 *  Handles the seven core-derived types the mappers cover: heading, paragraph, list, quote,
 *  code, table, separator. `image` is the one that is still genuinely unsupported — it needs
 *  a media upload path that does not exist — and throws, as does any custom `jamground/*`
 *  type, rather than being silently dropped. */
export function blockToMdast(block) {
  switch (block.type) {
    case 'heading': {
      if (block.level < 2 || block.level > 4) {
        throw new Error(`Heading level must be 2–4, got ${block.level}`);
      }
      return {
        type: 'heading',
        depth: block.level,
        children: parseInlineText(block.text),
      };
    }

    case 'paragraph':
      return {
        type: 'paragraph',
        children: parseInlineText(block.text),
      };

    case 'list':
      return mapListToMdast(block);

    case 'quote':
      return {
        type: 'blockquote',
        children: [
          {
            type: 'paragraph',
            children: parseInlineText(block.text),
          },
        ],
      };

    // PLAIN TEXT: `text` becomes the fence's `value` verbatim and is never parsed for inline
    // marks — `parseInlineText` here would turn `**bold**` inside a code sample into a
    // `strong` node and print it back as `<strong>`. `lang` and `meta` are null because
    // `Code` deliberately carries no info string (blocks.ts:52-57); with `fences: true` the
    // stringifier emits a ``` fence, and an empty `value` an empty one.
    case 'code':
      return { type: 'code', lang: null, meta: null, value: block.text };

    // The head row and the body rows, in one `children` list — mdast has no thead/tbody, the
    // first row IS the header. `align` is one null per column: the contract carries no
    // alignment, so every column stays default-aligned (`| --- |`), and stating it per column
    // is what keeps the delimiter row's width in step with the header.
    case 'table':
      return {
        type: 'table',
        align: block.head.map(() => null),
        children: [tableRow(block.head), ...block.rows.map(tableRow)],
      };

    // `rule: '-'` and `ruleSpaces: false` in the canonical settings make this `---`.
    case 'separator':
      return { type: 'thematicBreak' };

    default:
      throw new Error(`blocksToMdast does not yet support block type: ${block.type}`);
  }
}

/** Convert an array of Block objects to an mdast root node.
 *  Returns a complete mdast tree ready for stringification. */
export function blocksToMdast(blocks) {
  return {
    type: 'root',
    children: blocks.map(blockToMdast),
  };
}
