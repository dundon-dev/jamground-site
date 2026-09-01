// INV-5b LAYER 1, THE JAVASCRIPT HALF — the supports a block must not offer, and the filter that
// takes them away before registration.
//
// The PHP half is the mu-plugin's section 2 (`register_block_type_args`). Both halves are
// required and they are not interchangeable: `register_block_type_args` is a filter on
// WP_Block_Type_Registry::register, so it reaches the blocks WordPress registers inside
// Playground and reaches nothing at all in the host page — where `blocks-to-wp.mjs` builds the
// import tree with `createBlock()` and `export.mjs` reads it back. The host page had no layer 1
// at all until this module, and the two registries disagreeing is what `ac0a09f` was treating.
//
// ONE LIST, TWO CALL SITES, AND A TEST THAT THEY AGREE. `block-supports.test.mjs` reads the
// mu-plugin's own array out of the PHP source and asserts it equals this one, because a second
// copy of a security-adjacent list is a defect waiting for someone to edit one of them.
//
// `className` IS DELIBERATELY NOT HERE, and its absence is the correction rather than an
// oversight. The two are easily confused and do different things:
//
//   supports.className        the block's own generated class — `wp-block-heading`,
//                             `wp-block-list`, `wp-block-separator`, `wp-block-table`
//   supports.customClassName  the "Additional CSS class(es)" control in the Advanced panel
//
// Only the second is a control an editor can produce non-contract work with. The first is
// markup, and it is markup the contract FREEZES: `11 §4c` specifies `<hN class="wp-block-heading">`,
// `src/components/blocks/*.astro` emit it, and `test/blocks/core.test.mjs` asserts they do.
// Measured against the real registry, adding `className: false` here strips it:
//
//   <h2 class="wp-block-heading">  ->  <h2>
//   <ul class="wp-block-list">     ->  <ul>
//   <figure class="wp-block-table">->  <figure>
//   <hr class="wp-block-separator has-alpha-channel-opacity"/> -> <hr class="has-alpha-channel-opacity"/>
//
// which would make the editor the source of truth for markup and break parity with Astro for
// four of the eight core blocks. With `className` left alone and `customClassName` off, no
// `className` attribute is registered at all — so there is nothing for attribute-guard.mjs to
// refuse either.
export const STRIPPED_SUPPORTS = Object.freeze({
  color: false,
  typography: false,
  spacing: false,
  border: false,
  shadow: false,
  customClassName: false,
  anchor: false,
  align: false,
  dimensions: false,
  position: false,
  layout: false,
  filter: false,
});

/** Install layer 1 on a JavaScript block registry. MUST run before the blocks are registered —
 *  `blocks.registerBlockType` is a registration-time filter, and a block already in the registry
 *  is not revisited. `hooks` is `addFilter` from `@wordpress/hooks`, passed in rather than
 *  imported, the same discipline the rest of editor/lib uses so this stays testable in Node. */
export function stripSupports(addFilter, namespace = 'jamground/supports') {
  addFilter('blocks.registerBlockType', namespace, (settings) => ({
    ...settings,
    supports: { ...(settings.supports ?? {}), ...STRIPPED_SUPPORTS },
  }));
}
