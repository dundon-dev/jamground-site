// Contract test for environment resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolveContentRoot, resolveDraftFlag, writeBuildManifest, resolveEnv } from '../../src/contract/env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const distDir = resolve(projectRoot, 'dist');

// Clean up dist directory before and after tests to avoid side effects
function cleanDist() {
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
}

test('resolveContentRoot — defaults to ../jamground-content/content when env var not set', (t) => {
  const original = process.env.JAMGROUND_CONTENT_DIR;
  try {
    delete process.env.JAMGROUND_CONTENT_DIR;
    const root = resolveContentRoot();
    // Should resolve relative to the project root and end with /content
    assert(root.endsWith('/content'), `Expected root to end with /content, got: ${root}`);
    assert(!root.includes('undefined'), 'Should not contain "undefined"');
  } finally {
    if (original !== undefined) {
      process.env.JAMGROUND_CONTENT_DIR = original;
    }
  }
});

test('resolveContentRoot — uses JAMGROUND_CONTENT_DIR when set', (t) => {
  const original = process.env.JAMGROUND_CONTENT_DIR;
  try {
    process.env.JAMGROUND_CONTENT_DIR = '/custom/repo';
    const root = resolveContentRoot();
    // Should resolve the custom path and append /content
    assert(root.endsWith('/content'), `Expected root to end with /content, got: ${root}`);
    assert(root.includes('/custom/repo'), `Expected root to include /custom/repo, got: ${root}`);
  } finally {
    if (original !== undefined) {
      process.env.JAMGROUND_CONTENT_DIR = original;
    } else {
      delete process.env.JAMGROUND_CONTENT_DIR;
    }
  }
});

test('resolveDraftFlag — defaults to false when env var not set', (t) => {
  const original = process.env.JAMGROUND_INCLUDE_DRAFTS;
  try {
    delete process.env.JAMGROUND_INCLUDE_DRAFTS;
    const flag = resolveDraftFlag();
    assert.equal(flag, false);
  } finally {
    if (original !== undefined) {
      process.env.JAMGROUND_INCLUDE_DRAFTS = original;
    }
  }
});

test('resolveDraftFlag — defaults to false when env var is empty string', (t) => {
  const original = process.env.JAMGROUND_INCLUDE_DRAFTS;
  try {
    process.env.JAMGROUND_INCLUDE_DRAFTS = '';
    const flag = resolveDraftFlag();
    assert.equal(flag, false);
  } finally {
    if (original !== undefined) {
      process.env.JAMGROUND_INCLUDE_DRAFTS = original;
    } else {
      delete process.env.JAMGROUND_INCLUDE_DRAFTS;
    }
  }
});

test('resolveDraftFlag — returns true when env var is "1"', (t) => {
  const original = process.env.JAMGROUND_INCLUDE_DRAFTS;
  try {
    process.env.JAMGROUND_INCLUDE_DRAFTS = '1';
    const flag = resolveDraftFlag();
    assert.equal(flag, true);
  } finally {
    if (original !== undefined) {
      process.env.JAMGROUND_INCLUDE_DRAFTS = original;
    } else {
      delete process.env.JAMGROUND_INCLUDE_DRAFTS;
    }
  }
});

test('resolveDraftFlag — throws hard error for non-empty values other than "1"', (t) => {
  const original = process.env.JAMGROUND_INCLUDE_DRAFTS;
  const invalidValues = ['true', 'yes', 'on', 'enabled', '0', 'false', 'typo', ' ', '2'];

  for (const value of invalidValues) {
    try {
      process.env.JAMGROUND_INCLUDE_DRAFTS = value;
      assert.throws(
        () => resolveDraftFlag(),
        Error,
        `Expected error for value: ${value}`,
      );
    } finally {
      // Reset for next iteration
    }
  }

  // Restore original
  if (original !== undefined) {
    process.env.JAMGROUND_INCLUDE_DRAFTS = original;
  } else {
    delete process.env.JAMGROUND_INCLUDE_DRAFTS;
  }
});

test('writeBuildManifest — creates dist directory and writes manifest', (t) => {
  cleanDist();
  try {
    const manifest = {
      contentRoot: '/path/to/content',
      includeDrafts: false,
      timestamp: '2026-02-01T00:00:00Z',
    };
    writeBuildManifest(manifest);

    assert(existsSync(distDir), 'dist directory should exist');
    const manifestPath = resolve(distDir, 'build-manifest.json');
    assert(existsSync(manifestPath), 'build-manifest.json should exist');

    const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(written, manifest);
  } finally {
    cleanDist();
  }
});

test('writeBuildManifest — manifest is valid JSON with proper formatting', (t) => {
  cleanDist();
  try {
    const manifest = {
      contentRoot: '/path/to/content',
      includeDrafts: true,
      timestamp: '2026-02-01T12:34:56Z',
    };
    writeBuildManifest(manifest);

    const manifestPath = resolve(distDir, 'build-manifest.json');
    const content = readFileSync(manifestPath, 'utf8');

    // Should be valid JSON
    assert.doesNotThrow(() => JSON.parse(content), 'Manifest should be valid JSON');

    // Should end with exactly one newline
    assert(content.endsWith('\n'), 'Manifest should end with a newline');
    assert(!content.endsWith('\n\n'), 'Manifest should end with exactly one newline');

    // Should have proper indentation (2 spaces)
    assert(content.includes('  '), 'Manifest should have indentation');
  } finally {
    cleanDist();
  }
});

test('resolveEnv — resolves all environment variables and writes manifest', (t) => {
  const contentDirOriginal = process.env.JAMGROUND_CONTENT_DIR;
  const draftsOriginal = process.env.JAMGROUND_INCLUDE_DRAFTS;
  cleanDist();

  try {
    process.env.JAMGROUND_CONTENT_DIR = '/test/repo';
    process.env.JAMGROUND_INCLUDE_DRAFTS = '1';

    const manifest = resolveEnv();

    assert.equal(manifest.includeDrafts, true);
    assert(manifest.contentRoot.endsWith('/content'));
    assert(manifest.contentRoot.includes('/test/repo'));
    assert(manifest.timestamp, 'timestamp should be set');

    const manifestPath = resolve(distDir, 'build-manifest.json');
    assert(existsSync(manifestPath), 'build-manifest.json should exist after resolveEnv()');

    const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(written, manifest);
  } finally {
    if (contentDirOriginal !== undefined) {
      process.env.JAMGROUND_CONTENT_DIR = contentDirOriginal;
    } else {
      delete process.env.JAMGROUND_CONTENT_DIR;
    }
    if (draftsOriginal !== undefined) {
      process.env.JAMGROUND_INCLUDE_DRAFTS = draftsOriginal;
    } else {
      delete process.env.JAMGROUND_INCLUDE_DRAFTS;
    }
    cleanDist();
  }
});
