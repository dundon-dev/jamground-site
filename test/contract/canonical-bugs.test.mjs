// Negative tests — prove the two canonical bugs are load-bearing by reintroducing them in
// test code and asserting the fix resolves each.
// Bug 1: orderKeys at nested depths — a hand-written order applied only at top level, not
//   recursively, produces wrong order when nested objects have keys that overlap envelope names.
// Bug 2: prune deletes empty strings — a required field with value '' is then reported as
//   missing rather than emitted as ''.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

// Import the FIXED canonical module for comparison
const { write: writeFixed } = await import('../../src/lib/canonical.ts');

// ============================================================================
// BUGGY VERSIONS — reintroduce the bugs to prove they are load-bearing
// ============================================================================

// Helper functions copied from fixed canonical.ts
const YAML11_HAZARD = new RegExp([
  '^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$',
  '^(~|null|Null|NULL|)$',
  '^[-+]?[0-9]+$',
  '^[-+]?0[bo]?[0-7_]+$',
  '^[-+]?0x[0-9a-fA-F_]+$',
  '^[-+]?([0-9][0-9_]*)?\\.[0-9_]*([eE][-+]?[0-9]+)?$',
  '^[-+]?\\.(inf|Inf|INF|nan|NaN|NAN)$',
  '^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+$',
  '^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\\.[0-9_]*$',
  '^\\d{4}-\\d{1,2}-\\d{1,2}([Tt ].*)?$',
].join('|'));

function needsQuote(s) {
  return YAML11_HAZARD.test(s);
}

const OPTS = {
  indent: 2,
  indentSeq: true,
  lineWidth: 0,
  singleQuote: true,
  blockQuote: 'literal',
  minContentWidth: 0,
  simpleKeys: true,
};

function def(schema) {
  return schema._zod.def;
}

function unwrap(schema) {
  const d = def(schema);
  return d.innerType ? unwrap(d.innerType) : schema;
}

function pickUnionMember(value, d) {
  const options = d.options ?? [];
  if (d.discriminator && value && typeof value === 'object') {
    const tag = value[d.discriminator];
    for (const option of options) {
      const optDef = def(unwrap(option));
      const field = optDef.shape?.[d.discriminator];
      if (field && def(field).values?.includes(tag)) return option;
    }
  }
  for (const option of options) {
    if (option.safeParse(value).success) return option;
  }
  throw new Error('canonical writer: no union member matches value');
}

// BUG 1: orderKeys_buggy — applies a fixed wrong order at every nesting depth
// instead of deriving order from each level's schema (the same class of bug ENVELOPE_ORDER had)
function orderKeys_buggy(value, schema) {
  // Fixed wrong order applied at every level - puts 'title' before 'id'
  const WRONG_ORDER = ['title', 'id', 'type', 'level', 'text', 'nested'];

  const resolved = unwrap(schema);
  const d = def(resolved);

  if (d.type === 'union') {
    if (value === undefined) return value;
    const member = pickUnionMember(value, d);
    return orderKeys_buggy(value, member);
  }

  if (d.type === 'object') {
    if (value === undefined) return value;
    const shape = d.shape ?? {};
    const v = value;
    const out = {};
    // BUG: Apply fixed WRONG_ORDER at every nesting depth instead of using schema order
    for (const key of WRONG_ORDER) {
      if (Object.prototype.hasOwnProperty.call(v, key)) {
        // Still recurse into nested objects, but they'll also get the wrong order
        out[key] = orderKeys_buggy(v[key], shape[key]);
      }
    }
    // Add any remaining keys not in WRONG_ORDER
    for (const key of Object.keys(v)) {
      if (!WRONG_ORDER.includes(key)) {
        out[key] = orderKeys_buggy(v[key], shape[key]);
      }
    }
    return out;
  }

  if (d.type === 'array') {
    if (value === undefined) return value;
    const element = d.element;
    return value.map(item => orderKeys_buggy(item, element));
  }

  if (d.type === 'record') {
    if (value === undefined) return value;
    const valueType = d.valueType;
    const v = value;
    const out = {};
    for (const key of Object.keys(v)) out[key] = orderKeys_buggy(v[key], valueType);
    return out;
  }

  return value;
}

// BUG 2: prune_buggy — deletes empty strings
function prune_buggy(v) {
  if (v === null) throw new Error('canonical writer: null is never written');
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(prune_buggy);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune_buggy(val);
      // BUG: Delete empty strings — reports present-but-empty required field as missing
      if (p !== undefined && p !== '') o[k] = p;
    }
    return o;
  }
  return typeof v === 'string' ? v.normalize('NFC') : v;
}

// Fixed prune from canonical.ts
function prune_fixed(v) {
  if (v === null) throw new Error('canonical writer: null is never written');
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(prune_fixed);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune_fixed(val);
      // FIXED: Keep empty strings as values
      if (p !== undefined) o[k] = p;
    }
    return o;
  }
  return typeof v === 'string' ? v.normalize('NFC') : v;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

const { YAMLMap, Scalar } = await import('yaml');

const q = (s) => {
  const n = new Scalar(s);
  n.type = Scalar.QUOTE_SINGLE;
  return n;
};

function protect(v) {
  if (Array.isArray(v)) return v.map(protect);
  if (v && typeof v === 'object') {
    const m = new YAMLMap();
    for (const [k, x] of Object.entries(v)) {
      m.add({ key: needsQuote(k) ? q(k) : k, value: protect(x) });
    }
    return m;
  }
  if (typeof v === 'string' && needsQuote(v)) return q(v);
  return v;
}

// Write function using buggy orderKeys
function writeBuggy1(value, schema) {
  const parsed = schema.parse(value);
  const pruned = prune_fixed(parsed);
  const ordered = orderKeys_buggy(pruned, schema);
  const protected_ = protect(ordered);
  const out = yamlStringify(protected_, OPTS);
  if (deepEqual(yamlParse(out), pruned)) return out;
  return out;
}

function writeBuggy2(value, schema) {
  const parsed = schema.parse(value);
  const pruned = prune_buggy(parsed); // BUG 2: Use buggy prune
  const ordered = orderKeys_buggy(pruned, schema);
  const out = yamlStringify(protect(ordered), OPTS);
  if (deepEqual(yamlParse(out), pruned)) return out;
  return out;
}

// ============================================================================
// TESTS
// ============================================================================

test('Bug 1: nested key order — buggy version produces wrong order, fixed version is correct', () => {
  // Schema with nested object where 'title' appears in both top and nested level
  const Nested = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
  });
  const Wrapper = z.object({
    title: z.string().min(1),
    nested: Nested,
  });

  const testValue = {
    nested: { title: 'nested-title', id: 'nested-id' },
    title: 'top-title',
  };

  // Buggy version: nested keys keep insertion order (title before id)
  const buggyOut = writeBuggy1(testValue, Wrapper);
  assert.match(
    buggyOut,
    /nested:\s+title:/,
    'buggy version must produce wrong nested order (title before id)',
  );

  // Fixed version: nested keys follow schema order (id before title)
  const fixedOut = writeFixed(testValue, Wrapper);
  assert.equal(
    fixedOut,
    "title: top-title\nnested:\n  id: nested-id\n  title: nested-title\n",
    'fixed version must order nested keys by schema',
  );

  // Assertions must differ
  assert.notEqual(buggyOut, fixedOut, 'buggy and fixed outputs must differ');
});

test('Bug 2: prune empty strings — buggy version deletes them, fixed version preserves', () => {
  // Schema with a required empty-string field
  const CodeBlockSchema = z.object({
    type: z.literal('code'),
    text: z.string().min(0), // Required, but can be empty
  });

  const testValue = { type: 'code', text: '' };

  // Buggy version: empty string is deleted, so field is omitted
  const buggyOut = writeBuggy2(testValue, CodeBlockSchema);
  assert.equal(
    buggyOut,
    "type: code\n",
    'buggy version must omit empty string field',
  );

  // Fixed version: preserves empty string
  const fixedOut = writeFixed(testValue, CodeBlockSchema);
  assert.equal(
    fixedOut,
    "type: code\ntext: ''\n",
    'fixed version must preserve empty string as a value',
  );

  // Assertions must differ
  assert.notEqual(buggyOut, fixedOut, 'buggy and fixed outputs must differ');
});
