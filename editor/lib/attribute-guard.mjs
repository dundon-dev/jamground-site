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

// The contract-representable attributes per block. `core/separator` has none.
//
// `jamground/*` IS HANDLED SEPARATELY BELOW, FROM THE DEFINITIONS TABLE — not, as this comment
// used to say, from what the block registered. That claim was "registered with exactly the schema
// fields as attributes, so the registration itself is the allowlist", and it is false in BOTH
// registries: WordPress adds `lock`, `metadata` and `style` to every block it registers, so
// asking the registry made this layer three attributes wider than the contract, silently, in the
// one place whose whole job is refusing what the contract cannot represent.
//
// It was not hypothetical. Renaming a block in the list view sets `metadata: { name }`; the guard
// allowed it through, and export.mjs's custom arm iterates the contract's fields — so the rename
// was DROPPED on save without a word. Losing work quietly is exactly the failure INV-5b names,
// and a core block has never behaved that way here: `core/paragraph`'s allowlist is `['content']`,
// so the same rename on a paragraph has always been refused, by name.
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

import { CUSTOM_BLOCKS, CONTRACT_TYPE_BY_BLOCK_NAME } from '../blocks/definitions.mjs';

const isJamgroundBlock = (name) => name.startsWith('jamground/');

/** A `jamground/*` block's contract-representable attributes, from the one table both registries
 *  register from — so this layer allows exactly what the contract has a field for, whatever
 *  WordPress adds around it. block-definitions.test.mjs is what keeps that table equal to the
 *  Zod shapes; this function is why that test is load-bearing rather than tidy. */
function jamgroundAllowed(name) {
  const type = CONTRACT_TYPE_BY_BLOCK_NAME[name];
  return type ? Object.keys(CUSTOM_BLOCKS[type].attributes) : null;
}

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

  if (!isJamgroundBlock(name) && !(name in ALLOWLIST)) {
    throw new Error(`INV-5b layer 3: no contract representation for block "${name}"`);
  }

  // AN UNREGISTERED jamground/* BLOCK IS A MISSING REGISTRATION, NOT A BAD ATTRIBUTE, and saying
  // so is the whole point of this branch. A jamground/* block is allowlisted by asking the
  // registry what it registered — so if `getBlockType` returns undefined, `allowed` is the empty
  // set and the loop below refuses the FIRST attribute it reaches with "attribute \"heading\" on
  // block \"jamground/hero\" has no contract representation". That is a true sentence about a
  // false premise, and it names the wrong cause: `heading` is fine, the registration is missing.
  //
  // It is exactly the failure two registries invite. The host page and the editor inside
  // Playground register separately (entry.mjs and blocks/browser.mjs), so a block present in one
  // and absent from the other is a live possibility rather than a hypothetical, and this is the
  // path an export runs down when it happens.
  if (isJamgroundBlock(name) && (!blockType || !jamgroundAllowed(name))) {
    throw new Error(
      `INV-5b layer 3: block "${name}" is not registered in the registry doing the export, so its ` +
      'attributes have no allowlist — this is a missing registration, not a bad attribute ' +
      '(editor/blocks/definitions.mjs is the table both registries read)',
    );
  }

  const allowed = isJamgroundBlock(name)
    ? new Set(jamgroundAllowed(name))
    : new Set(ALLOWLIST[name]);

  for (const [key, value] of Object.entries(stripped)) {
    if (allowed.has(key)) continue;
    // PRESENT BUT UNSET IS NOT SET. `parse()` returns only the sourced attributes for markup
    // that matches the registered `save()` byte for byte, and the WHOLE registered schema —
    // every key, valued `undefined` — for markup that does not. The second case is ordinary
    // here rather than exotic: the editor re-saves a heading as `<h2>` while the import path
    // wrote `<h2 class="wp-block-heading">`, because the mu-plugin strips `className` support
    // inside WordPress and the host-page registry that serialised the import has it. So an
    // untouched heading arrives carrying `textAlign`, `fontSize`, `style` and ten more, all
    // undefined, and refusing them refused every save of a page a person had merely opened.
    //
    // `isDefaulted` cannot answer this: it returns false whenever the attribute declares no
    // `default` at all, which is exactly the case for `textAlign`. An attribute with no value
    // carries no meaning for the contract to fail to represent, so it is not "set" and there
    // is nothing to refuse. An attribute a person actually gave a value keeps its value here
    // and is still refused below, which is the whole job of this layer.
    if (value === undefined) continue;
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
