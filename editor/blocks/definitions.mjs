// THE ATTRIBUTE TABLE — one row per custom block, one module, both registries.
//
// The imitable pattern is kinds.mjs's, and it is worth naming which part is imitated. kinds.mjs
// does NOT introspect its Zod schemas: `schema: Page` is one column and `sitePath: pathForPage`
// is another, both written out by hand. What it gets from that is the property this table wants
// — one row per kind, so a fourth kind is a row and not a branch anywhere else. Deriving these
// attributes from the Zod shapes instead would need a translation layer for things a hand table
// answers trivially: MediaRef is a union of two object shapes, `items` is an array of objects,
// and `columns` is a union of three literals, none of which map onto a WordPress attribute
// `type` without inventing rules nobody needs.
//
// The enforcement is a test, not the derivation: block-definitions.test.mjs asserts these keys
// equal Object.keys(Schema.shape) minus `type`, per block. That test is what makes the
// registration an allowlist — attribute-guard.mjs:82-93 allowlists a jamground/* block by asking
// the registry what it registered, so a field missing HERE is a field export refuses, and a field
// registered here that the contract has no room for is a field export writes and validation
// rejects. Both directions are the same test.
//
// THESE ARE REGISTERED DEFAULTS, WHICH ARE NOT THE `.default()` 11 §4b BANS. That ban is on the
// Zod contract, where a default is materialised at parse time and then written to disk, turning
// every unordered list in the repository into a diff against its own canonical form. A WordPress
// registered default is the opposite: 11 §4d's third layer is written in terms of them ("ignore
// attributes equal to their registered default"), and core/list's `ordered: false` is one this
// contract already depends on. `columns` carries one because it is REQUIRED by the contract and
// a block inserted without it could not be saved at all.
//
// `save: () => null` on all three: 11 §4b makes the custom blocks dynamic, so the persisted form
// is a single self-closing delimiter carrying only attributes. There is no HTML to mismatch, so
// block validation cannot fail for them — which is why the markup contract's enforcement is the
// fidelity gate rather than Gutenberg's own validator.
import { STRIPPED_SUPPORTS } from '../lib/block-supports.mjs';

/** Layer 1 for a block registered in JAVASCRIPT ONLY, which all three of these are.
 *
 *  The mu-plugin's section 2 does not reach them and cannot be made to: `register_block_type_args`
 *  is a filter on WP_Block_Type_Registry::register, and a block registered with
 *  wp.blocks.registerBlockType never goes through PHP registration at all. The host page's
 *  `blocks.registerBlockType` filter (block-supports.mjs) DOES reach them, but only in the host
 *  page — so declaring the supports on the definition is what makes the two registries agree
 *  inside Playground as well. Applying it in both places is harmless: the filter merges the same
 *  keys onto the same values. */
const CUSTOM_BLOCK_SUPPORTS = Object.freeze({
  ...STRIPPED_SUPPORTS,
  // Beyond layer 1's list, and specific to a dynamic block with no rich-text child: there is
  // nothing here for an editor to type into except the controls we ship, and html editing would
  // offer a code view of markup the contract, not the editor, owns.
  html: false,
  reusable: false,
});

/** Contract `type` -> everything both registries need to register the block.
 *
 *  The camelCase/kebab-case boundary lives here and nowhere else: the contract says `featureGrid`
 *  and WordPress says `jamground/feature-grid`, and every other module asks this table rather
 *  than transforming the string itself. */
export const CUSTOM_BLOCKS = Object.freeze({
  hero: {
    name: 'jamground/hero',
    title: 'Hero',
    description: 'A heading, optional body, optional image and optional call to action.',
    attributes: {
      heading: { type: 'string' },
      body: { type: 'string' },
      // MediaRef, a `{ ref, alt }` reference into content/media/ — NOT an upload. It is
      // registered so that a hero carrying one survives a round trip through the editor
      // untouched; there is no control for it, because content/media/ is empty and a chooser
      // over an empty directory is the misleading surface stage A exists to remove.
      media: { type: 'object' },
      // Link, `{ label, ref }` — `ref` is a translation-group id, not a URL, and becomes an href
      // only at build time (src/lib/links.ts). Registered for the same reason as `media`.
      cta: { type: 'object' },
    },
  },
  featureGrid: {
    name: 'jamground/feature-grid',
    title: 'Feature grid',
    description: 'Two to twelve features, laid out in two, three or four columns.',
    attributes: {
      // Required by the contract, so it needs a registered default or a freshly inserted block
      // has no value the contract would accept. Three is the middle of `2 | 3 | 4`.
      columns: { type: 'number', default: 3 },
      // Each item is `{ heading, body, icon? }`. `icon` has no control and renders nothing —
      // FeatureGrid has no markup contract for it and there is no design/icons/ — so it
      // round-trips and reaches no element. A control that changes nothing visible is precisely
      // the surface stage A removed.
      items: { type: 'array', default: [] },
    },
  },
  cta: {
    name: 'jamground/cta',
    title: 'Call to action',
    description: 'A heading, optional body, and a link to another page.',
    attributes: {
      heading: { type: 'string' },
      body: { type: 'string' },
      link: { type: 'object' },
    },
  },
});

/** WordPress block name -> contract type. The reverse of the table's own keys, built from it
 *  rather than written a second time. */
export const CONTRACT_TYPE_BY_BLOCK_NAME = Object.freeze(
  Object.fromEntries(Object.entries(CUSTOM_BLOCKS).map(([type, spec]) => [spec.name, type])),
);

/** Every `jamground/*` name, in table order. */
export const CUSTOM_BLOCK_NAMES = Object.freeze(
  Object.values(CUSTOM_BLOCKS).map((spec) => spec.name),
);

/**
 * Register all three on a JavaScript block registry.
 *
 * `registerBlockType` is passed in rather than imported, the same discipline the rest of
 * editor/lib uses, because this runs in three places: the host page (entry.mjs, against
 * @wordpress/blocks), the editor bundle inside Playground (against `wp.blocks` off the global),
 * and Node tests.
 *
 * `editFor` is OPTIONAL and is the whole difference between the two registries. The host page
 * needs these blocks registered so createBlock/serialize/parse/getBlockType work for import and
 * export; it renders no canvas, so it needs no `edit` and pulls no React into the shell bundle.
 * The editor bundle passes one. A block registered without an `edit` still round-trips — which is
 * the property PoC-7d found is NOT true of PHP registration, where a registered type with no
 * `edit` never appeared in the inserter at all.
 */
export function registerCustomBlocks(registerBlockType, editFor) {
  for (const [type, spec] of Object.entries(CUSTOM_BLOCKS)) {
    const settings = {
      apiVersion: 3,
      title: spec.title,
      description: spec.description,
      // A core category, deliberately, rather than one of our own. An unregistered category is
      // one of the ways a registered block silently fails to appear in the inserter, and the
      // inserter here is allowlisted down to these blocks anyway, so a bespoke heading would
      // name a room with nothing else in it.
      category: 'design',
      attributes: spec.attributes,
      supports: CUSTOM_BLOCK_SUPPORTS,
      save: () => null,
    };
    if (editFor) settings.edit = editFor(type, spec);
    registerBlockType(spec.name, settings);
  }
}
