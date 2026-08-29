// Contract test for the canonical YAML writer.
// This file exercises four historical defect classes, to prove each is actually fixed:
// ENVELOPE_ORDER (deleted as a second source of truth for key order), orderKeys' latent
// nested-collision bug, prune's empty-string deletion, and OPTS' null-masking nullStr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { write, read, needsQuote } from '../../src/lib/canonical.ts';
import { Envelope } from '../../src/contract/envelope.ts';
import { Post, Page } from '../../src/contract/entities.ts';
import { Block } from '../../src/contract/blocks.ts';

const ULID_A = '01J8Z9X2K3M4N5P6Q7R8S9T0V1';
const ULID_B = '01J8Z9GRP00000000000000GRP';

function baseEnvelope(overrides = {}) {
  return {
    id: ULID_A,
    translationOf: ULID_B,
    locale: 'en-US',
    slug: 'pricing',
    title: 'Pricing',
    status: 'published',
    publishedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

test('key order derives from the schema, not a hand-maintained list — sourceHash last (the drift ENVELOPE_ORDER already had)', () => {
  // Fields given out of order on purpose: nothing about input order should survive.
  const value = {
    updatedAt: '2026-01-02T00:00:00Z',
    sourceHash: 'a'.repeat(64),
    title: 'Pricing',
    id: ULID_A,
    status: 'published',
    slug: 'pricing',
    publishedAt: '2026-01-01T00:00:00Z',
    translationOf: ULID_B,
    locale: 'en-US',
  };
  const out = write(value, Envelope);
  const keys = out.split('\n').filter(Boolean).map(l => l.split(':')[0]);
  assert.deepEqual(keys, [
    'id', 'translationOf', 'locale', 'slug', 'title', 'status',
    'publishedAt', 'updatedAt', 'sourceHash',
  ]);
});

test('Envelope.extend appends — Post body keys follow the envelope, in Post schema order', () => {
  const value = {
    ...baseEnvelope(),
    tags: ['pricing', 'plans'],
    author: ULID_B,
    excerpt: 'A short excerpt.',
  };
  const out = write(value, Post);
  const keys = out.split('\n').filter(l => /^[a-zA-Z]/.test(l)).map(l => l.split(':')[0]);
  assert.deepEqual(keys, [
    'id', 'translationOf', 'locale', 'slug', 'title', 'status', 'publishedAt', 'updatedAt',
    'author', 'excerpt', 'tags',
  ]);
});

test('nested key order comes from the nested schema alone — no hoisting across depths (the latent orderKeys bug)', () => {
  // `title` names both a top-level envelope-shaped field and a nested one; a hand-maintained
  // order applied at every depth would hoist the nested `title` above the nested `id`. Schema-
  // driven order does not, because each level's shape governs only that level.
  const Nested = z.object({ id: z.string().min(1), title: z.string().min(1) });
  const Wrapper = z.object({ title: z.string().min(1), nested: Nested });
  const out = write({ nested: { title: 'nested-title', id: 'nested-id' }, title: 'top-title' }, Wrapper);
  assert.equal(out, "title: top-title\nnested:\n  id: nested-id\n  title: nested-title\n");
});

test('a discriminated union orders by the matched member — type is always first', () => {
  const out = write({ level: 2, text: 'Section', type: 'heading' }, Block);
  const keys = out.split('\n').filter(Boolean).map(l => l.split(':')[0]);
  assert.deepEqual(keys, ['type', 'level', 'text']);
});

test('an empty string is a value — written as \'\', never deleted (the prune() bug)', () => {
  const out = write({ type: 'code', text: '' }, Block);
  assert.equal(out, "type: code\ntext: ''\n");
});

test('an absent optional is omitted entirely', () => {
  const out = write(baseEnvelope(), Envelope);
  assert.ok(!out.includes('slugHistory'), 'absent slugHistory must not appear');
  assert.ok(!out.includes('seo'), 'absent seo must not appear');
});

test('null throws rather than emitting an empty scalar (the nullStr bug)', () => {
  const AnySchema = z.object({ x: z.any() });
  assert.throws(() => write({ x: null }, AnySchema), /null/);
});

test('an empty array is a schema error, caught by parse(), never silently omitted', () => {
  // Page.blocks is z.array(Block).min(1) — the schema forbids [], so it never reaches
  // the writer's array-emptying branch to swallow.
  assert.throws(() => write({ ...baseEnvelope(), blocks: [] }, Page));
});

test('defensive quoting — YAML 1.1 hazard values are single-quoted', () => {
  for (const hazard of ['yes', 'no', 'true', 'off', '2026-08-17', '12:30', '750', 'null']) {
    assert.equal(needsQuote(hazard), true, `${hazard} should be flagged as a hazard`);
  }
  assert.equal(needsQuote('Pricing'), false);
  const out = write(baseEnvelope({ title: 'yes' }), Envelope);
  assert.match(out, /title: 'yes'/);
});

test('defensive quoting applies to keys as well as values', () => {
  const RecordSchema = z.object({ social: z.record(z.string(), z.string()) });
  const out = write({ social: { off: 'https://example.org/' } }, RecordSchema);
  assert.match(out, /'off':/);
});

test('never folds — lineWidth is unlimited', () => {
  const longTitle = 'A '.repeat(60) + 'headline';
  const out = write(baseEnvelope({ title: longTitle }), Envelope);
  const titleLine = out.split('\n').find(l => l.startsWith('title:'));
  assert.ok(titleLine.length > 80, 'a long title must stay on one line, unwrapped');
});

test('NFC-normalises stored text (INV-13)', () => {
  const nfd = 'café'; // "café" spelled with a combining acute accent (NFD)
  const out = write(baseEnvelope({ title: nfd }), Envelope);
  assert.ok(out.includes('café'), 'output must be the NFC form');
  assert.equal(out.normalize('NFC'), out);
});

test('round trip — read(write(x)) reproduces the pruned value, and write is idempotent', () => {
  const value = baseEnvelope({ slugHistory: ['old-pricing'] });
  const out1 = write(value, Envelope);
  const parsedBack = read(out1);
  const out2 = write(parsedBack, Envelope);
  assert.equal(out1, out2);
});

test('an invalid value never reaches the emitter — schema.parse() throws first', () => {
  assert.throws(() => write({ ...baseEnvelope(), locale: 'not-a-locale' }, Envelope));
});
