// The block bundle's entry point — the file esbuild builds and the shell writes into the WASM
// filesystem for the mu-plugin to enqueue.
//
// WHY THIS FILE EXISTS AT ALL, rather than the mu-plugin registering three blocks in PHP: PoC-7d
// (03 §Custom-blocks) registered `jamground/hero` in PHP alone and got a registered block type
// that NEVER APPEARED IN THE INSERTER. PHP registration gives a render_callback and a REST
// presence; it gives no `edit` component, and a block with no `edit` is not something the inserter
// will offer. A bundle calling wp.blocks.registerBlockType made it appear immediately.
//
// There is no build step inside Playground, so this is built by our own toolchain and carried in.
//
// IT READS `wp` OFF THE GLOBAL AND BUNDLES NO WORDPRESS. The script is enqueued with
// wp-blocks/wp-element/wp-block-editor/wp-components as dependencies, so WordPress has printed all
// four before this runs. Bundling them instead would put a second React in the page — two
// reconcilers, two copies of the block registry — which is the failure this dependency list exists
// to avoid.
//
// IT FAILS LOUDLY OR NOT AT ALL. Everything that goes wrong here produces the same symptom: an
// inserter that is simply short, with nothing in the console. So each precondition is checked and
// named, because "jamground blocks: wp.blockEditor is missing" is a bug report and an empty
// inserter is a mystery.
import { registerCustomBlocks, CUSTOM_BLOCK_NAMES } from './definitions.mjs';
import { makeEditFor } from './edit.mjs';

function register(wp) {
  for (const dependency of ['blocks', 'element', 'blockEditor', 'components']) {
    if (!wp || !wp[dependency]) {
      throw new Error(
        `jamground blocks: wp.${dependency} is missing, so ${CUSTOM_BLOCK_NAMES.join(', ')} were not registered. ` +
        'The enqueue in the mu-plugin declares it as a dependency — check that it is still in that list.',
      );
    }
  }

  registerCustomBlocks(wp.blocks.registerBlockType, makeEditFor(wp));

  // The registration is asserted here as well as in the browser suite, because this is the one
  // place that can tell the difference between "never ran" and "ran and did nothing".
  const missing = CUSTOM_BLOCK_NAMES.filter((name) => !wp.blocks.getBlockType(name));
  if (missing.length) {
    throw new Error(`jamground blocks: registerBlockType accepted no definition for ${missing.join(', ')}`);
  }

  // Read by editor/test/playwright/mu-plugin.test.mjs. A block being in the registry is not the
  // same as this bundle having put it there, and the browser suite needs to tell those apart.
  window.__jamgroundBlocks = { registered: CUSTOM_BLOCK_NAMES };
}

try {
  register(window.wp);
} catch (error) {
  // Rethrowing would take the rest of the editor's boot with it and turn a short inserter into a
  // blank screen, which is a worse trade than a named error beside a short inserter.
  console.error(error);
  window.__jamgroundBlocks = { error: String(error && error.message) };
}
