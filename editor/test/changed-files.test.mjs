// Test changed-file detection: compare exports against stored source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./domshim.cjs'); // must run before @wordpress packages touch `window` at module scope

// CJS build only — see blocks-to-wp.test.mjs for why.
const { registerCoreBlocks } = require('@wordpress/block-library');
const { createBlock, serialize, parse, getBlockType } = require('@wordpress/blocks');
registerCoreBlocks();

const { getChangedFiles } = await import('../lib/changed-files.mjs');
const { exportPost } = await import('../lib/export.mjs');

const api = { createBlock, serialize, parse, getBlockType };

const FRONTMATTER = {
  id: '01M0BSHTFEWS6VYC4XBR52R3JE',
  translationOf: '01M0BSHSG62QD33PKX3GRRXX5W',
  locale: 'en-US',
  slug: 'test-post-1',
  title: 'Test Post 1',
  status: 'published',
  publishedAt: '2026-08-01T09:00:00Z',
  updatedAt: '2026-08-01T09:00:00Z',
  author: '01M0BSHNK661FD6Y2JPMH75A1C',
};

// Mock timestamp for reproducible tests
function getUpdatedAt() {
  return '2026-08-01T09:00:00Z'; // same as FRONTMATTER to avoid changes
}

test('unmodified post yields an empty set', () => {
  // Create original markup
  const originalMarkup = serialize([createBlock('core/paragraph', { content: 'Test content.' })]);

  // Export to get the canonical source
  const storedSource = exportPost({
    api,
    markup: originalMarkup,
    frontmatter: FRONTMATTER,
    previousSlug: FRONTMATTER.slug,
    updatedAt: getUpdatedAt(),
  });

  // Create a post with that stored source
  const post = {
    id: 1,
    kind: 'post',
    content: originalMarkup, // same markup as when originally imported
    slug: FRONTMATTER.slug,
    frontmatter: FRONTMATTER,
    meta: {
      _jamground_id: FRONTMATTER.id,
      _jamground_source: storedSource,
    },
  };

  // Check for changes
  const changed = getChangedFiles([post], { api, getUpdatedAt });

  // Should return empty array when nothing changed
  assert.deepEqual(changed, []);
});

test('changed headline yields exactly one entry', () => {
  // Create original markup with a paragraph
  const originalMarkup = serialize([createBlock('core/paragraph', { content: 'Original content.' })]);

  // Export to get the canonical source
  const storedSource = exportPost({
    api,
    markup: originalMarkup,
    frontmatter: FRONTMATTER,
    previousSlug: FRONTMATTER.slug,
    updatedAt: getUpdatedAt(),
  });

  // Create modified markup with a heading added
  const modifiedMarkup = serialize([
    createBlock('core/heading', { level: 2, content: 'A heading' }),
    createBlock('core/paragraph', { content: 'Original content.' }),
  ]);

  const post = {
    id: 1,
    kind: 'post',
    content: modifiedMarkup, // changed markup
    slug: FRONTMATTER.slug,
    frontmatter: FRONTMATTER,
    meta: {
      _jamground_id: FRONTMATTER.id,
      _jamground_source: storedSource,
    },
  };

  const changed = getChangedFiles([post], { api, getUpdatedAt });

  // Should return the post since it changed
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, 1);
});

test('missing stored source throws', () => {
  const markup = serialize([createBlock('core/paragraph', { content: 'Test.' })]);

  const post = {
    id: 1,
    kind: 'post',
    content: markup,
    slug: FRONTMATTER.slug,
    frontmatter: FRONTMATTER,
    meta: {
      _jamground_id: FRONTMATTER.id,
      // _jamground_source is missing
    },
  };

  assert.throws(
    () => getChangedFiles([post], { api, getUpdatedAt }),
    /lacks _jamground_source/
  );
});
