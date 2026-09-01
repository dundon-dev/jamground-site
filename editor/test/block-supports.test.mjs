// INV-5b layer 1 exists twice — once in JavaScript for the host page's registry, once in PHP for
// the registry inside Playground — because neither filter can reach the other's registry. Two
// copies of a list is the shape a defect hides in, so this reads the mu-plugin's array back out
// of the PHP source and asserts it says exactly what block-supports.mjs says.
//
// It also pins `className`'s ABSENCE from both, positively rather than by omission. That is the
// one entry whose removal changes markup rather than controls, and a test that only compared the
// two lists would stay green if someone put it back in both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

const { createBlock, serialize, getBlockType } = require('@wordpress/blocks');
const { addFilter } = require('@wordpress/hooks');

const { STRIPPED_SUPPORTS, stripSupports } = await import('../lib/block-supports.mjs');

const MU_PLUGIN = readFileSync(fileURLToPath(new URL('../mu-plugin/jamground.php', import.meta.url)), 'utf8');

/** The `$args['supports'] = array_merge(...)` array in section 2, as `{ key: false }`. Anchored on
 *  `register_block_type_args` rather than on a line number, so moving the hook does not break this
 *  and deleting it does. */
function muPluginSupports() {
  const hook = MU_PLUGIN.split("add_filter('register_block_type_args'")[1];
  assert(hook, "the mu-plugin should still register a `register_block_type_args` filter — layer 1's PHP half");
  const body = hook.slice(0, hook.indexOf(']);'));
  const entries = [...body.matchAll(/'([a-zA-Z]+)'\s*=>\s*(true|false)/g)];
  assert(entries.length > 0, 'the supports array should not be empty — an empty one strips nothing');
  return Object.fromEntries(entries.map(([, k, v]) => [k, v === 'true']));
}

test('layer 1 says the same thing in both languages', () => {
  assert.deepEqual(muPluginSupports(), { ...STRIPPED_SUPPORTS });
});

test('every stripped support is stripped, not merely listed', () => {
  for (const [key, value] of Object.entries(STRIPPED_SUPPORTS)) {
    assert.equal(value, false, `${key} should be disabled, not enabled`);
  }
});

test('`className` is in neither list, because it is markup rather than a control', () => {
  // The contract freezes the generated class (11 §4c) and the Astro components emit it. Stripping
  // it made this editor re-save `<h2 class="wp-block-heading">` as a bare `<h2>` — the divergence
  // ac0a09f treated a symptom of. `customClassName` is the control, and it stays off.
  assert.equal('className' in STRIPPED_SUPPORTS, false);
  assert.equal('className' in muPluginSupports(), false);
  assert.equal(STRIPPED_SUPPORTS.customClassName, false);
});

test('the filtered host registry emits the markup the contract freezes (11 §4c)', () => {
  // Registration-time filter: it has to be installed before the blocks are registered, so this
  // registers core blocks itself rather than relying on another test file's module-scope call.
  stripSupports(addFilter, 'jamground/supports-test');
  const { registerCoreBlocks } = require('@wordpress/block-library');
  registerCoreBlocks();

  const heading = serialize([createBlock('core/heading', { level: 2, content: 'Welcome' })]);
  const list = serialize([createBlock('core/list', {}, [createBlock('core/list-item', { content: 'a' })])]);
  const separator = serialize([createBlock('core/separator', {})]);
  const table = serialize([createBlock('core/table', {
    head: [{ cells: [{ content: 'h', tag: 'th' }] }],
    body: [{ cells: [{ content: 'b', tag: 'td' }] }],
  })]);

  assert.match(heading, /<h2 class="wp-block-heading">Welcome<\/h2>/);
  assert.match(list, /<ul class="wp-block-list">/);
  assert.match(separator, /<hr class="wp-block-separator has-alpha-channel-opacity"\/>/);
  assert.match(table, /<figure class="wp-block-table"><table class="has-fixed-layout">/);

  // And the control is gone: no `className` attribute is registered at all, so there is nothing
  // for attribute-guard.mjs to refuse.
  assert.equal(getBlockType('core/heading').supports.customClassName, false);
  assert.equal('className' in (getBlockType('core/heading').attributes ?? {}), false);
});
