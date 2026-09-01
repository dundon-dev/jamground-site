// THE ATTRIBUTE TABLE IS THE ALLOWLIST, AND THIS IS WHAT MAKES THAT TRUE.
//
// attribute-guard.mjs:82-93 allowlists a jamground/* block by asking the registry what it
// registered — "registered with exactly the schema fields as attributes, so the registration
// itself is the allowlist." That sentence is a claim about a hand-written table in another file,
// and nothing checked it. Both directions of getting it wrong are silent in different ways:
//
//   a field in the contract, missing from the table   export refuses it as having no contract
//                                                     representation, which is the opposite of
//                                                     true, and names the wrong cause
//   a field in the table, absent from the contract    export writes it, the canonical writer
//                                                     emits it, and validation rejects the file
//                                                     after it has been written
//
// So this compares the two sets and does not care which side is wrong. Deliberately NOT a
// derivation: definitions.mjs's header says why the table is hand-written, and a test that
// derived the same thing the same way would agree with itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CUSTOM_BLOCKS, CONTRACT_TYPE_BY_BLOCK_NAME, CUSTOM_BLOCK_NAMES, registerCustomBlocks } from '../blocks/definitions.mjs';
import { STRIPPED_SUPPORTS } from '../lib/block-supports.mjs';

const { Block } = await import('../../src/contract/blocks.ts');

const memberByType = (type) => Block.options.find((o) => o.shape.type.value === type);

test('every custom block in the contract has a row in the table, and no row invents one', () => {
  // The contract's own list of custom types, taken from the union rather than restated: a
  // twelfth block type added to blocks.ts arrives here as a failure rather than as an omission.
  const contractCustomTypes = Block.options
    .map((o) => o.shape.type.value)
    .filter((type) => !['paragraph', 'heading', 'list', 'image', 'quote', 'code', 'table', 'separator'].includes(type));

  assert.deepEqual(Object.keys(CUSTOM_BLOCKS).sort(), contractCustomTypes.sort());
});

for (const [type, spec] of Object.entries(CUSTOM_BLOCKS)) {
  test(`${spec.name} registers exactly the contract's fields for \`${type}\``, () => {
    const schemaFields = Object.keys(memberByType(type).shape).filter((key) => key !== 'type');
    assert.deepEqual(
      Object.keys(spec.attributes).sort(),
      schemaFields.sort(),
      `${spec.name}'s attributes must equal ${type}'s schema fields minus \`type\``,
    );
  });
}

test('the name mapping is a bijection, and carries the camelCase/kebab-case boundary', () => {
  assert.deepEqual(CUSTOM_BLOCK_NAMES, ['jamground/hero', 'jamground/feature-grid', 'jamground/cta']);
  assert.equal(CONTRACT_TYPE_BY_BLOCK_NAME['jamground/feature-grid'], 'featureGrid');
  assert.equal(Object.keys(CONTRACT_TYPE_BY_BLOCK_NAME).length, CUSTOM_BLOCK_NAMES.length);
  for (const [type, spec] of Object.entries(CUSTOM_BLOCKS)) {
    assert.equal(CONTRACT_TYPE_BY_BLOCK_NAME[spec.name], type);
  }
});

test('no optional field carries a registered default', () => {
  // THE INVARIANT, and it is the WordPress-side half of 11 §4b. A registered default on an
  // optional field is written to disk on save — the attribute is present, so export reads it and
  // the canonical writer emits it — which materialises an absent optional and puts the file in
  // permanent drift against its own canonical form. That is the same defect the `ordered: false`
  // fix removed from the list path, arriving by a different door.
  //
  // The converse is NOT asserted, and the reason is worth writing down rather than leaving as an
  // omission: a required field cannot always carry a useful default. `heading` is
  // `z.string().min(1)`, so every constant is either invalid or a heading nobody typed. A hero
  // inserted and saved without one fails validation at save, naming `heading` — late, but honest,
  // and better than the editor inventing content.
  for (const [type, spec] of Object.entries(CUSTOM_BLOCKS)) {
    const shape = memberByType(type).shape;
    for (const [field, attr] of Object.entries(spec.attributes)) {
      if (shape[field].constructor.name !== 'ZodOptional') continue;
      assert.equal(
        'default' in attr, false,
        `${spec.name}.${field} is optional in the contract, so a registered default would write a value nobody set`,
      );
    }
  }
});

test('the registered `type` of every attribute matches the contract field it carries', () => {
  // The table's other column, and the one a hand-written table gets wrong quietly: a MediaRef
  // registered as a string still round-trips through this editor and still breaks the moment
  // anything reads it as the object it is.
  const wpType = (schema) => {
    const inner = schema.constructor.name === 'ZodOptional' ? schema.unwrap() : schema;
    switch (inner.constructor.name) {
      case 'ZodString': return 'string';
      case 'ZodObject': return 'object';
      case 'ZodArray': return 'array';
      // A union is whatever its options agree on — MediaRef is two object shapes, `columns` is
      // three number literals. Options that disagree have no single WordPress type and should
      // fail here rather than be given one.
      case 'ZodUnion': {
        const kinds = new Set(inner.options.map((o) =>
          o.constructor.name === 'ZodLiteral'
            ? typeof (o.values ? [...o.values][0] : o.value)
            : { ZodObject: 'object', ZodString: 'string', ZodArray: 'array' }[o.constructor.name]));
        assert.equal(kinds.size, 1, `a union of mixed kinds has no single WordPress attribute type: ${[...kinds]}`);
        return [...kinds][0];
      }
      default: throw new Error(`no WordPress attribute type for ${inner.constructor.name}`);
    }
  };

  for (const [type, spec] of Object.entries(CUSTOM_BLOCKS)) {
    const shape = memberByType(type).shape;
    for (const [field, attr] of Object.entries(spec.attributes)) {
      assert.equal(attr.type, wpType(shape[field]), `${spec.name}.${field}`);
    }
  }
});

test('`columns` is the one required field a constant can satisfy, and its default is valid', () => {
  // Every other required field is a string with `.min(1)` or an array with `.min(2)`, where no
  // constant is both valid and truthful. `columns` is `2 | 3 | 4`, so a fresh feature grid can
  // carry a real answer rather than an absent one. `items` defaults to `[]` — which the contract
  // REJECTS, deliberately: it is there so the repeater has an array to iterate, not to make an
  // empty grid saveable, and an empty one fails at save naming `items`.
  const columns = memberByType('featureGrid').shape.columns;
  assert.equal(columns.safeParse(CUSTOM_BLOCKS.featureGrid.attributes.columns.default).success, true);
  const items = memberByType('featureGrid').shape.items;
  assert.equal(items.safeParse(CUSTOM_BLOCKS.featureGrid.attributes.items.default).success, false);
});

test('registration declares its own supports, because no filter reaches a JS-only block', () => {
  // Correction 2, and it is the difference between the two halves of layer 1. The mu-plugin's
  // section 2 is a `register_block_type_args` filter, which fires inside WP_Block_Type_Registry
  // for blocks that go through PHP register_block_type(). These three never do.
  const registered = {};
  registerCustomBlocks((name, settings) => { registered[name] = settings; });

  assert.deepEqual(Object.keys(registered), CUSTOM_BLOCK_NAMES);
  for (const [name, settings] of Object.entries(registered)) {
    for (const [key, value] of Object.entries(STRIPPED_SUPPORTS)) {
      assert.equal(settings.supports[key], value, `${name} must declare supports.${key} itself`);
    }
    assert.equal(settings.save(), null, `${name} must be dynamic — 11 §4b`);
    assert.equal(settings.edit, undefined, 'a registry given no editFor gets no edit component');
  }
});
