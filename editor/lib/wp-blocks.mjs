// Exports registerCore function that takes the block API as an argument
// This allows the same module to work in both browser (ESM from esbuild)
// and Node (CJS with createRequire)
import { registerCoreBlocks } from '@wordpress/block-library';

export function registerCore(api) {
  // The api parameter contains registerBlockType and other utilities
  // We call registerCoreBlocks which registers all core WordPress blocks
  registerCoreBlocks();
}
