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

/** Convert a single Block object to an mdast node.
 *  Only handles the four types specified in the task: heading, paragraph, list, quote.
 *  Other block types throw an error indicating they are not yet supported. */
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
