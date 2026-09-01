// THE ROUND TRIP FOR THE THREE jamground/* BLOCKS: contract -> createBlock -> serialize -> parse
// -> guard -> export -> contract, asserted deep-equal.
//
// This is the property that makes registering an attribute WITHOUT a control worth doing. A hero
// carrying a `media` nobody in this editor can choose, or a `cta` carrying a `ref` nobody can
// pick, still has to open, survive being looked at, and be written back exactly as it was — a
// control that does not exist yet must cost an editor nothing, and the way it could cost them
// everything is silently dropping the field on save.
//
// It runs against the HOST registry (@wordpress/blocks here, entry.mjs in the browser), which is
// the one blocks-to-wp.mjs and export.mjs actually use. The editor inside Playground registers the
// same table through blocks/browser.mjs, and that half is only observable in the browser suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType, registerBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const { registerCustomBlocks, CUSTOM_BLOCK_NAMES } = await import('../blocks/definitions.mjs');
registerCustomBlocks(registerBlockType);

const { markupToContractBlocks } = await import('../lib/export.mjs');
const { blocksToMarkup, blockToWp } = await import('../lib/blocks-to-wp.mjs');
const { guardBlockAttributes } = await import('../lib/attribute-guard.mjs');
const { Block } = await import('../../src/contract/blocks.ts');

const api = { createBlock, serialize, parse, getBlockType };
const roundTrip = (blocks) => markupToContractBlocks(api, blocksToMarkup(api, blocks));

/* Every fixture is a value the CONTRACT accepts — asserted below, so a fixture cannot drift into
 * testing a shape the contract would reject and pass for the wrong reason. */
const FIXTURES = [
  ['hero — heading only, every optional absent',
    { type: 'hero', heading: 'A WordPress editor' }],
  ['hero — every optional present, including the two with no control',
    { type: 'hero', heading: 'Pricing & plans', body: 'No setup fees.',
      media: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' },
      cta: { label: 'Get started', ref: '01M143VFF8TN0D6FNX3S6M5T49' } }],
  ['hero — decorative media, where `alt` is prohibited rather than empty',
    { type: 'hero', heading: 'H', media: { ref: 'media/x.png', decorative: true } }],
  ['featureGrid — the minimum two items',
    { type: 'featureGrid', columns: 2,
      items: [{ heading: 'A', body: 'one' }, { heading: 'B', body: 'two' }] }],
  ['featureGrid — an icon, which round-trips and renders nothing',
    { type: 'featureGrid', columns: 4,
      items: [{ heading: 'A', body: 'one', icon: 'bolt' }, { heading: 'B', body: 'two' }] }],
  ['cta — body absent',
    { type: 'cta', heading: 'Start now', link: { label: 'Go', ref: '01M143VHDR61GWZ9Z89PHAPK4X' } }],
  ['cta — body present, and markdown marks travel as characters',
    { type: 'cta', heading: 'H & H', body: 'Read the **docs** first.',
      link: { label: 'L & L', ref: '01M143VHDR61GWZ9Z89PHAPK4X' } }],
];

for (const [name, block] of FIXTURES) {
  test(`round trip: ${name}`, () => {
    assert.equal(Block.safeParse(block).success, true, 'the fixture itself must be contract-valid');
    assert.deepEqual(roundTrip([block]), [block]);
  });
}

test('an absent optional stays absent rather than coming back as undefined', () => {
  // The key must not be PRESENT-AND-UNDEFINED either: the canonical writer would emit it, and a
  // `body:` with nothing after it is exactly the drift the `ordered` fix removed from lists.
  const [hero] = roundTrip([{ type: 'hero', heading: 'H' }]);
  assert.deepEqual(Object.keys(hero), ['type', 'heading']);
  assert.equal('body' in hero, false);
  assert.equal('media' in hero, false);
  assert.equal('cta' in hero, false);
});

test('a required field with a registered default is written even when untouched', () => {
  // The other half of the rule above, and the reason the two cannot be one rule. `columns` is
  // required, so its registered default is a real answer and must reach the file; dropping it
  // because "nobody set it" would write a featureGrid the contract rejects.
  const built = createBlock('jamground/feature-grid', {
    items: [{ heading: 'A', body: 'one' }, { heading: 'B', body: 'two' }],
  });
  const [grid] = markupToContractBlocks(api, serialize([built]));
  assert.equal(grid.columns, 3);
  assert.equal(Block.safeParse(grid).success, true);
});

test('all three are dynamic, so the markup is a delimiter and carries no HTML', () => {
  // 11 §4b. If a save() ever starts emitting markup, the block gains a way to be invalid that it
  // does not have today, and the fidelity gate stops being the only thing standing between the
  // canvas and the site.
  const markup = blocksToMarkup(api, [{ type: 'hero', heading: 'H' }]);
  assert.match(markup, /^<!-- wp:jamground\/hero \{"heading":"H"\} \/-->$/);
  for (const name of CUSTOM_BLOCK_NAMES) {
    assert.equal(getBlockType(name).save(), null, `${name} must have save() === null`);
  }
});

test('the guard allowlists a jamground block from its own registration', () => {
  // attribute-guard.mjs's claim in its own words: "registered with exactly the schema fields as
  // attributes, so the registration itself is the allowlist." Asserted in both directions.
  const block = blockToWp(api, { type: 'hero', heading: 'H', body: 'B' });
  assert.deepEqual(guardBlockAttributes(api, block), { heading: 'H', body: 'B' });

  assert.throws(
    () => guardBlockAttributes(api, { name: 'jamground/hero', attributes: { heading: 'H', tagline: 'nope' } }),
    /attribute "tagline" on block "jamground\/hero" has no contract representation/,
  );
});

test('an unregistered jamground block is named as a missing registration', () => {
  // Correction 4. With an empty allowlist the loop refuses the first attribute it reaches and
  // blames `heading`, which is a true sentence about a false premise. The two registries can
  // disagree, so this is a path an export really runs down.
  const unregistered = { name: 'jamground/callout', attributes: { heading: 'H' } };
  assert.throws(
    () => guardBlockAttributes(api, unregistered),
    /is not registered in the registry doing the export/,
  );
  assert.doesNotThrow(() => {
    try { guardBlockAttributes(api, unregistered); } catch (e) {
      assert.equal(/has no contract representation/.test(e.message), false,
        'it must not blame the attribute for a missing registration');
    }
  });
});
