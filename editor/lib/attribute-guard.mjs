// The third and final attribute-allowlisting layer — enforced at export time.
//
// Layer 1 (a `blocks.registerBlockType` filter, applied before registration) removes the
// controls that could ever produce a non-contract attribute. This module is the backstop
// for the case layer 1 misses: a WordPress upgrade introducing an attribute we did not
// anticipate, or a block built without the filter running first. It runs at export, after
// the block tree exists and before `serialize()`, so it must ignore attributes that are
// still equal to their registered default — otherwise every
// `core/paragraph` fails on `dropCap: false`, which is present on every parsed block whether
// or not an editor ever touched it.
//
// `api` is the block API (`getBlockType`, from `@wordpress/blocks`), passed as an argument
// rather than imported at module scope — the same discipline `blocks-to-wp.mjs` and
// `wp-blocks.mjs` use, because `@wordpress/block-library` touches `window` on import and this
// module runs in both the browser bundle and this Node test.

// The contract-representable attributes per block. `core/separator` has
// none. `jamground/*` is handled separately below: those blocks are registered with exactly
// the schema fields as attributes, so the registration itself is the allowlist.
const ALLOWLIST = {
  'core/paragraph': ['content'],
  'core/heading': ['content', 'level'],
  'core/list': ['ordered'],
  'core/list-item': ['content'],
  'core/image': ['url', 'alt', 'caption'],
  'core/quote': ['citation'],
  'core/code': ['content'],
  'core/table': ['head', 'body'],
  'core/separator': [],
};

const isJamgroundBlock = (name) => name.startsWith('jamground/');

// Strips two things unconditionally, ahead of the table check below:
// the ephemeral WordPress attachment `id` (it never appears in content, and is meaningless on
// the next boot anyway, since Playground's IDs autoincrement per session) and the
// `wp-image-N` class token it leaves behind in `className`. Returns a new attributes object;
// the input is never mutated.
function stripImageEphemera(name, attributes) {
  if (name !== 'core/image') return attributes;
  const next = { ...attributes };
  delete next.id;
  if (typeof next.className === 'string') {
    const rest = next.className
      .split(/\s+/)
      .filter((token) => token && !/^wp-image-\d+$/.test(token))
      .join(' ');
    if (rest) next.className = rest;
    else delete next.className;
  }
  return next;
}

// `core/table`'s `caption` is a rich-text attribute with NO registered default, so
// `isDefaulted` cannot see it — yet every table parses with `caption` present and empty,
// whether or not anyone typed one, because the attribute is sourced from a `<figcaption>`
// that simply isn't there. `caption` is absent from the table's allowlist because this
// contract's `Table` has no caption field. So an empty one is the parser's artifact and is
// dropped here; a caption someone actually TYPED survives this and is refused by the loop
// below, which is the point — dropping it silently is the loss this module exists to stop.
function stripEmptyTableCaption(name, attributes) {
  if (name !== 'core/table' || !('caption' in attributes)) return attributes;
  if (String(attributes.caption ?? '') !== '') return attributes;
  const next = { ...attributes };
  delete next.caption;
  return next;
}

// Attributes still equal to their registered default do not count as set.
// Compared structurally, since a default can be an array or object as
// well as a primitive.
function isDefaulted(blockType, key, value) {
  const attrDef = blockType?.attributes?.[key];
  if (!attrDef || !('default' in attrDef)) return false;
  return JSON.stringify(attrDef.default) === JSON.stringify(value);
}

/** Guards one block's attributes for export. Returns the sanitised attributes object
 *  (image ephemera stripped); throws, naming the block and the offending attribute, if
 *  anything outside the allowlist survives that and isn't equal to its registered default.
 *  `getBlockType` is `api.getBlockType` from `@wordpress/blocks`. */
export function guardBlockAttributes(api, block) {
  const { name, attributes = {} } = block;
  const stripped = stripEmptyTableCaption(name, stripImageEphemera(name, attributes));

  const blockType = api.getBlockType(name);
  const allowed = isJamgroundBlock(name)
    ? new Set(Object.keys(blockType?.attributes ?? {}))
    : new Set(ALLOWLIST[name]);

  if (!isJamgroundBlock(name) && !(name in ALLOWLIST)) {
    throw new Error(`INV-5b layer 3: no contract representation for block "${name}"`);
  }

  for (const [key, value] of Object.entries(stripped)) {
    if (allowed.has(key)) continue;
    if (isDefaulted(blockType, key, value)) continue;
    throw new Error(
      `INV-5b layer 3: attribute "${key}" on block "${name}" has no contract representation`,
    );
  }

  return stripped;
}

/** Walks a parsed block tree (as `@wordpress/blocks`' `parse()` returns it, or the tree built
 *  with `createBlock()` before `serialize()`) and guards every block, including inner blocks.
 *  Returns a new tree with sanitised attributes; the input tree is never mutated. Throws on
 *  the first violation found, naming the offending block and attribute. */
export function guardExportTree(api, blocks) {
  return blocks.map((block) => ({
    ...block,
    attributes: guardBlockAttributes(api, block),
    innerBlocks: guardExportTree(api, block.innerBlocks ?? []),
  }));
}
