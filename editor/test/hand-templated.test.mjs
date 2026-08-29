import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — the ESM build imports JSON without an import attribute and fails under
// Node ESM.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse } = require('@wordpress/blocks');
registerCoreBlocks();

const { blocksToMarkup } = await import('../lib/blocks-to-wp.mjs');

const api = { createBlock, serialize };

test('serialized markup from blocksToMarkup parses with isValid true for every block', () => {
  const markup = blocksToMarkup(api, [
    { type: 'heading', level: 3, text: 'A heading' },
    { type: 'paragraph', text: 'A paragraph.' },
  ]);
  const parsed = parse(markup);
  for (const block of parsed) {
    assert.equal(block.isValid, true, `block ${block.name} is invalid`);
  }
  assert.equal(parsed.length, 2);
});

test('hand-templated heading with attribute order difference parses isValid false', () => {
  // First, get the canonical serialization via blocksToMarkup
  const canonical = blocksToMarkup(api, [{ type: 'heading', level: 2, text: 'Test heading' }]);
  const canonicalParsed = parse(canonical);
  assert.equal(canonicalParsed[0].isValid, true, 'canonical should be valid');

  // Create hand-templated markup with different attribute order in the comment
  // and mismatched HTML structure (level mismatch: h3 in content but h2 in attributes)
  const handTemplated = `<!-- wp:heading {"content":"Test heading","level":2} -->
<h3>Test heading</h3>
<!-- /wp:heading -->`;

  const handParsed = parse(handTemplated);
  // isValid is false when Gutenberg re-serializes and it differs from the input
  // The mismatched heading level (h3 vs level:2 = h2) causes string comparison to fail
  assert.equal(
    handParsed[0].isValid,
    false,
    'hand-templated markup with mismatched heading level should be invalid',
  );
});

test('unregistered block name parses as core/missing with isValid true', () => {
  const handTemplated = `<!-- wp:unregistered/block {"someAttr":"value"} -->
<div>Some content</div>
<!-- /wp:unregistered/block -->`;

  const parsed = parse(handTemplated);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'core/missing', 'unregistered block maps to core/missing');
  assert.equal(parsed[0].isValid, true, 'core/missing parses as isValid, so it is not a useful allowlist check');
});
