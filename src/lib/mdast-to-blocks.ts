/* Extract mdast -> contract Block mapping used by both renderer and editor.
 * See PostBody.astro for the full reasoning behind this transformation pipeline.
 * The canonical markdown settings below are normative and govern both markdown bodies and
 * InlineText scalars. */
import type { z } from 'zod';
import type { Block } from '../contract/blocks.ts';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';

const stringifier = unified()
  .use(remarkStringify, {
    bullet: '-', emphasis: '_', strong: '*', fences: true,
    listItemIndent: 'one', rule: '-', ruleSpaces: false, resourceLink: true,
  })
  .use(remarkGfm);

/** A run of inline children, rendered to the same canonical string a `text` field holds in
 *  the contract — wrapping in a throwaway paragraph is what lets
 *  the shared stringifier, which only knows how to stringify a tree, serialise a bare run of
 *  inline nodes. */
function inlineText(children: unknown[]): string {
  return stringifier.stringify({ type: 'root', children: [{ type: 'paragraph', children }] } as never).trimEnd();
}

const firstOfType = (nodes: any[], type: string) => nodes.find((n) => n.type === type);

/** One level of List/ListL2/ListL3 (blocks.ts) — `level` is which of the three this
 *  call is producing, and items stop offering a nested `.list` once `level` reaches 3,
 *  exactly as ListL3's own shape has no `list` field for a mapped fourth source level to
 *  fill. */
function mapList(node: any, level: number) {
  return {
    ordered: node.ordered,
    items: node.children.map((li: any) => {
      const paragraph = firstOfType(li.children, 'paragraph');
      const nestedList = firstOfType(li.children, 'list');
      const text = inlineText(paragraph ? paragraph.children : []);
      return !nestedList || level >= 3 ? { text } : { text, list: mapList(nestedList, level + 1) };
    }),
  };
}

function mapNode(node: any): z.infer<typeof Block> {
  switch (node.type) {
    case 'heading':
      return { type: 'heading', level: node.depth, text: inlineText(node.children) };
    case 'paragraph':
      if (node.children.length === 1 && node.children[0].type === 'image') {
        const { url, alt } = node.children[0];
        return { type: 'image', media: { ref: url, alt: alt || '' } };
      }
      return { type: 'paragraph', text: inlineText(node.children) };
    case 'list':
      return { type: 'list', ...mapList(node, 1) };
    case 'blockquote':
      return { type: 'quote', text: inlineText(firstOfType(node.children, 'paragraph')?.children ?? []) };
    case 'code':
      return { type: 'code', text: node.value };
    case 'table': {
      const [head, ...rows] = node.children;
      return {
        type: 'table',
        head: head.children.map((cell: any) => inlineText(cell.children)),
        rows: rows.map((row: any) => row.children.map((cell: any) => inlineText(cell.children))),
      };
    }
    case 'thematicBreak':
      return { type: 'separator' };
    default:
      throw new Error(`unmapped markdown construct: ${node.type}`);
  }
}

/** Parse a markdown body string to an mdast tree and map it to contract Block array.
 *  Takes the same canonical remark settings as InlineText validation. */
export function mdastToBlocks(body: string): z.infer<typeof Block>[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body);
  return tree.children.map(mapNode);
}
