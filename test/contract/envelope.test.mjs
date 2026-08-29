// Contract test for the shared frontmatter envelope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Envelope } from '../../src/contract/envelope.ts';

const ULID_A = '01J8Z9X2K3M4N5P6Q7R8S9T0V1';
const ULID_B = '01J8Z9GRP00000000000000GRP';

function base(overrides = {}) {
  return {
    id: ULID_A,
    translationOf: ULID_B,
    locale: 'en-US',
    slug: 'pricing',
    title: 'Pricing',
    status: 'published',
    publishedAt: '2026-08-17T09:00:00Z',
    updatedAt: '2026-08-17T14:22:00Z',
    ...overrides,
  };
}

test('key order is the order of record — id, translationOf, locale, slug, slugHistory, title, status, publishedAt, updatedAt, seo, sourceHash', () => {
  assert.deepEqual(Object.keys(Envelope.shape), [
    'id', 'translationOf', 'locale', 'slug', 'slugHistory', 'title',
    'status', 'publishedAt', 'updatedAt', 'seo', 'sourceHash',
  ]);
});

test('seo key order — title, description, ogImage, noindex', () => {
  const seoShape = Envelope.shape.seo.unwrap().shape;
  assert.deepEqual(Object.keys(seoShape), ['title', 'description', 'ogImage', 'noindex']);
});

test('a minimal published entity parses', () => {
  const result = Envelope.safeParse(base());
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('a full example from 02 §3 parses byte-for-byte', () => {
  const result = Envelope.safeParse(base({
    slugHistory: ['plans', 'our-plans'],
    seo: {
      title: 'Pricing — Example',
      description: 'Simple, transparent pricing.',
      ogImage: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' },
    },
    sourceHash: '4f2c1d8a9b3e7f06152d4c8a9b3e7f06152d4c8a9b3e7f06152d4c8a9b3e7f06',
  }));
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('publishedAt is required when status is published (OD-27)', () => {
  const result = Envelope.safeParse(base({ publishedAt: undefined }));
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].path[0], 'publishedAt');
});

test('publishedAt is optional on a draft, where it is the scheduling date (R12, OD-05)', () => {
  const result = Envelope.safeParse(base({ status: 'draft', publishedAt: undefined }));
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('updatedAt is always required, regardless of status', () => {
  const result = Envelope.safeParse(base({ updatedAt: undefined }));
  assert.equal(result.success, false);
});

test('slugHistory is optional, and every entry must itself be a valid Slug', () => {
  assert.equal(Envelope.safeParse(base()).success, true, 'absent slugHistory is legal');
  assert.equal(Envelope.safeParse(base({ slugHistory: ['plans'] })).success, true);
  assert.equal(Envelope.safeParse(base({ slugHistory: ['Not-A-Slug'] })).success, false);
});

test('status is a closed enum of draft or published', () => {
  assert.equal(Envelope.safeParse(base({ status: 'archived' })).success, false);
});

test('seo is optional, and every field inside it is optional', () => {
  assert.equal(Envelope.safeParse(base()).success, true, 'absent seo is legal');
  assert.equal(Envelope.safeParse(base({ seo: {} })).success, true, 'empty seo is legal');
});

test('seo.title and seo.description are length-bounded', () => {
  assert.equal(Envelope.safeParse(base({ seo: { title: 'x'.repeat(70) } })).success, true);
  assert.equal(Envelope.safeParse(base({ seo: { title: 'x'.repeat(71) } })).success, false);
  assert.equal(Envelope.safeParse(base({ seo: { description: 'x'.repeat(160) } })).success, true);
  assert.equal(Envelope.safeParse(base({ seo: { description: 'x'.repeat(161) } })).success, false);
});

test('seo.ogImage is a MediaRef, and seo.noindex is a boolean', () => {
  assert.equal(
    Envelope.safeParse(base({ seo: { ogImage: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' } } })).success,
    true,
  );
  assert.equal(Envelope.safeParse(base({ seo: { ogImage: { ref: 'not-rooted-at-content.jpg', alt: 'x' } } })).success, false);
  assert.equal(Envelope.safeParse(base({ seo: { noindex: true } })).success, true);
  assert.equal(Envelope.safeParse(base({ seo: { noindex: 'yes' } })).success, false);
});

test('sourceHash is optional, and must be lowercase-hex SHA-256 when present (11 §2)', () => {
  assert.equal(Envelope.safeParse(base()).success, true, 'absent sourceHash is legal — default-locale entities have none');
  assert.equal(
    Envelope.safeParse(base({
      sourceHash: '4f2c1d8a9b3e7f06152d4c8a9b3e7f06152d4c8a9b3e7f06152d4c8a9b3e7f06',
    })).success,
    true,
  );
  assert.equal(Envelope.safeParse(base({ sourceHash: 'not-hex' })).success, false, 'wrong alphabet rejected');
  assert.equal(Envelope.safeParse(base({ sourceHash: '4f2c1d8a' })).success, false, 'wrong length rejected');
  assert.equal(
    Envelope.safeParse(base({
      sourceHash: '4F2C1D8A9B3E7F06152D4C8A9B3E7F06152D4C8A9B3E7F06152D4C8A9B3E7F06',
    })).success,
    false,
    'uppercase hex rejected',
  );
});

test('id, translationOf and locale are required', () => {
  assert.equal(Envelope.safeParse(base({ id: undefined })).success, false);
  assert.equal(Envelope.safeParse(base({ translationOf: undefined })).success, false);
  assert.equal(Envelope.safeParse(base({ locale: undefined })).success, false);
});

test('title must be non-empty', () => {
  assert.equal(Envelope.safeParse(base({ title: '' })).success, false);
});
