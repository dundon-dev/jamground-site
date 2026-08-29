// Contract test for the block catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Block } from '../../src/contract/blocks.ts';
import { InlineText, MediaRef, Link, Icon } from '../../src/contract/defs.ts';

const ULID = '01J8Z9X2K3M4N5P6Q7R8S9T0V1';
const MEDIA = { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' };

function memberByType(type) {
  const member = Block.options.find(o => o.shape.type.value === type);
  assert.ok(member, `no member found for type ${type}`);
  return member;
}

const VALID = {
  paragraph: { type: 'paragraph', text: 'Hello **world**.' },
  heading: { type: 'heading', level: 2, text: 'A heading' },
  list: {
    type: 'list',
    items: [
      { text: 'one' },
      {
        text: 'two',
        list: {
          items: [{ text: 'nested one' }, { text: 'nested two', list: { items: [{ text: 'deepest' }] } }],
        },
      },
    ],
  },
  image: { type: 'image', media: MEDIA },
  quote: { type: 'quote', text: 'A quote.', citation: 'Someone' },
  code: { type: 'code', text: 'const x = 1;' },
  table: { type: 'table', head: ['A', 'B'], rows: [['1', '2']] },
  separator: { type: 'separator' },
  hero: { type: 'hero', heading: 'Big claim', body: 'Supporting text.', media: MEDIA, cta: { label: 'Go', ref: ULID } },
  featureGrid: {
    type: 'featureGrid',
    columns: 3,
    items: [{ heading: 'One', body: 'First' }, { heading: 'Two', body: 'Second' }],
  },
  cta: { type: 'cta', heading: 'Join now', link: { label: 'Go', ref: ULID } },
};

test('the union covers exactly the eleven types, in catalogue order (11 §4)', () => {
  assert.deepEqual(Block.options.map(o => o.shape.type.value), [
    'paragraph', 'heading', 'list', 'image', 'quote', 'code',
    'table', 'separator', 'hero', 'featureGrid', 'cta',
  ]);
});

for (const [type, value] of Object.entries(VALID)) {
  test(`a valid ${type} block parses`, () => {
    const result = Block.safeParse(value);
    assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
  });
}

test('.strict() rejects an unknown key on every member (11 §4b)', () => {
  for (const [type, value] of Object.entries(VALID)) {
    const result = Block.safeParse({ ...value, bogus: true });
    assert.equal(result.success, false, `${type} should reject an unrecognised key`);
  }
});

test('the discriminant is a closed literal, not any string', () => {
  assert.equal(Block.safeParse({ type: 'columns', text: 'x' }).success, false);
});

test('list nesting is capped at three levels — a fourth is rejected (11 §4a)', () => {
  const fourLevels = {
    type: 'list',
    items: [{
      text: 'one',
      list: { items: [{ text: 'two', list: { items: [{ text: 'three', list: { items: [{ text: 'four' }] } }] } }] },
    }],
  };
  assert.equal(Block.safeParse(fourLevels).success, false, 'a fourth level has no schema field to occupy');
});

test('heading level is restricted to 2, 3 or 4 — no h1, no h5/h6 (11 §Markdown-construct)', () => {
  assert.equal(Block.safeParse({ type: 'heading', level: 1, text: 'x' }).success, false);
  assert.equal(Block.safeParse({ type: 'heading', level: 5, text: 'x' }).success, false);
});

test('featureGrid.columns is restricted to 2, 3 or 4', () => {
  assert.equal(Block.safeParse({ ...VALID.featureGrid, columns: 5 }).success, false);
});

test('featureGrid.items is bounded 2..12', () => {
  assert.equal(Block.safeParse({ ...VALID.featureGrid, items: [{ heading: 'Only one', body: 'x' }] }).success, false);
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ heading: `Item ${i}`, body: 'x' }));
  assert.equal(Block.safeParse({ ...VALID.featureGrid, items: thirteen }).success, false);
});

test('table.head and table.rows each require at least one entry — no merged cells (11 §4a)', () => {
  assert.equal(Block.safeParse({ type: 'table', head: [], rows: [['1']] }).success, false);
  assert.equal(Block.safeParse({ type: 'table', head: ['A'], rows: [] }).success, false);
});

test('table cells reuse the shared InlineText type, not a fresh unconstrained string (11 §4b)', () => {
  const table = memberByType('table');
  assert.equal(table.shape.head.element, InlineText, 'head[] cells are InlineText');
  assert.equal(table.shape.rows.element.element, InlineText, 'rows[][] cells are InlineText');
});

test('hero, featureGrid and cta are dynamic — the schema carries only attributes, no markup (11 §4b)', () => {
  assert.equal(memberByType('hero').shape.media.unwrap(), MediaRef);
  assert.equal(memberByType('hero').shape.cta.unwrap(), Link);
  assert.equal(memberByType('featureGrid').shape.items.element.shape.icon.unwrap(), Icon);
  assert.equal(memberByType('cta').shape.link, Link);
});

// ---- the two normative test obligations for the block catalogue's leaf types -----------
//
// Both walk the catalogue's OWN structure — object shapes, array elements, union options,
// optional unwrapping — and stop at the four shared leaf types (InlineText, MediaRef, Link,
// Icon), which are imported from ./defs.ts rather than re-derived here: their own contracts
// are exercised by defs.test.mjs, not re-tested by this file.

const OPAQUE_SHARED_DEFS = new Set([InlineText, MediaRef, Link, Icon]);

// Table's cells and Code.text are the two named exceptions to "every string field is
// `.min(1)`". Table's cells never reach the ZodString check below at all — they are
// InlineText, one of the opaque shared defs above — which is exactly why reusing InlineText,
// rather than a fresh string, is what exempts them. Code.text is the one place this file
// defines a literal, deliberately unconstrained z.string().
const MIN_LENGTH_EXCEPTIONS = new Set(['code.text']);

function walk(schema, path, onNode) {
  if (OPAQUE_SHARED_DEFS.has(schema)) return;
  onNode(schema, path);
  switch (schema.constructor.name) {
    case 'ZodObject':
      for (const [key, value] of Object.entries(schema.shape)) walk(value, [...path, key], onNode);
      break;
    case 'ZodArray':
      walk(schema.element, [...path, '[]'], onNode);
      break;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      for (const option of schema.options) walk(option, path, onNode);
      break;
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      walk(schema._def.innerType, path, onNode);
      break;
    default:
      break;
  }
}

function walkCatalogue(onNode) {
  for (const member of Block.options) walk(member, [member.shape.type.value], onNode);
}

test('no ZodDefault node exists anywhere in the block catalogue (11 §4b)', () => {
  const offenders = [];
  walkCatalogue((node, path) => {
    if (node.constructor.name === 'ZodDefault') offenders.push(path.join('.'));
  });
  assert.deepEqual(offenders, [], `Zod materialises a default at parse time, which the canonical writer would then emit: ${offenders.join(', ')}`);
});

test('every ZodString in the catalogue has minLength >= 1, except code.text (11 §4b)', () => {
  const offenders = [];
  walkCatalogue((node, path) => {
    if (node.constructor.name !== 'ZodString') return;
    const key = path.join('.');
    if (MIN_LENGTH_EXCEPTIONS.has(key)) return;
    if (typeof node.minLength !== 'number' || node.minLength < 1) offenders.push(key);
  });
  assert.deepEqual(offenders, [], `every string field must be .min(1) unless emptiness is meaningful: ${offenders.join(', ')}`);
});

test('code.text has no minLength — an empty code block is meaningful (11 §4b)', () => {
  const code = memberByType('code');
  assert.equal(code.shape.text.constructor.name, 'ZodString');
  assert.equal(code.shape.text.minLength, null);
});
