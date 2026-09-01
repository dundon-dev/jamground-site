// THE OTHER HALF OF R5's CORE-BLOCK CLAUSE: WordPress's own save() against the frozen record.
//
// `10 §R5` asks the fidelity gate to pass "for the 3 custom blocks and all 8 core blocks", and
// until this file the second half was not asserted anywhere. The custom blocks have a chain:
// test/blocks/custom.test.mjs holds Astro to design/markup/, editor/test/fidelity.test.mjs holds
// the `edit` component's React to the same module, so the two renderers agree transitively. Core
// blocks had only the first link — test/blocks/core.test.mjs held Astro to strings written by hand
// into that test file, read off core's save.js at authoring time. Nothing asked WordPress.
//
// SO THE HOLE WAS A WORDPRESS UPGRADE, which is exactly what `10 §R5`'s Notes say this gate is
// for: "Core blocks are the awkward case — their markup is observed, not authored… This gate is
// what detects a WordPress upgrade changing them." Change `wp-block-heading` in a future
// @wordpress/block-library and every gate in this repository stays green: core.test.mjs compares
// Astro against the old string and passes, markup-parity compares two registries that have both
// moved and passes, and the site quietly serves markup the editor no longer produces. This file is
// the assertion that fails.
//
// IT IS A NODE TEST, NOT A BROWSER ONE, and that is the difference between it and
// test/playwright/markup-parity.test.mjs, which is easy to confuse with it:
//
//   markup-parity (browser)  host registry serialize() vs WASM registry serialize()
//                            catches the two REGISTRIES drifting from each other
//   this file     (node)     WordPress's serialize() vs design/markup/core.ts
//                            catches EITHER registry drifting from what Astro renders
//
// Neither subsumes the other. markup-parity would stay green through an upgrade that moved both
// registries together; this one would stay green through the `ac0a09f` class of defect, where the
// two registries are configured differently and only one of them is asked.
//
// COMPARED AS PARSED TREES, not bytes, and the reason is in design/markup/core.ts's header:
// React self-closes void elements and writes `alt=""` where Astro emits a bare `alt`. Both vanish
// on parse and neither is drift. The normaliser is ./normalise.mjs — the same one the fidelity
// gate uses, so "the same markup" means one thing across both gates. It skips comment nodes,
// which is what lets a serialize()'s block delimiters be compared against markup that has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — the ESM build imports JSON without an import attribute and fails under
// Node ESM. Same constraint blocks-to-wp.test.mjs is under.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize } = require('@wordpress/blocks');
registerCoreBlocks();

const { normalise } = await import('./normalise.mjs');
const { blockToWp } = await import('../lib/blocks-to-wp.mjs');
const { CORE_CASES, CORE_TYPES } = await import('../../design/markup/core.ts');

const api = { createBlock, serialize };

/** The WordPress block for one case. Through the real mapper wherever there is one, so this
 *  exercises the path a real import takes rather than a second description of it; from the row's
 *  own `wp` only where blocks-to-wp.mjs refuses the type, which today is `image` alone. */
function wpBlockFor({ block, wp }) {
  return wp ? createBlock(wp.name, wp.attributes) : blockToWp(api, block);
}

for (const testCase of CORE_CASES) {
  test(`core markup: ${testCase.name}`, () => {
    assert.equal(
      normalise(serialize(wpBlockFor(testCase))),
      normalise(testCase.markup),
      'WordPress no longer emits the markup design/markup/core.ts records, so what this editor '
      + 'saves and what the site renders have come apart',
    );
  });
}

// The `wp` escape hatch is a statement about ONE block type, and it stops being true the moment
// R10 gives `image` somewhere to upload to. Pinned so that adding a second one is a decision
// somebody makes here rather than a quiet widening of what this gate does not cover.
test('only the type the mapper refuses carries its own WordPress attributes', () => {
  assert.deepEqual(
    [...new Set(CORE_CASES.filter((c) => c.wp).map((c) => c.block.type))],
    ['image'],
  );
});

// Same claim test/blocks/core.test.mjs makes on its side, and it has to be made on both: this file
// and that one iterate the same rows, so a deleted row shrinks both halves of the chain at once.
test('every core-derived contract type has at least one case', () => {
  const covered = new Set(CORE_CASES.map((c) => c.block.type));
  assert.deepEqual([...CORE_TYPES].filter((type) => !covered.has(type)), []);
});
