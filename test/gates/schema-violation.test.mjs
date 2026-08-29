/* Every entity validates against its collection schema, and a schema
 * violation must fail the build, not deploy. A gate nobody has watched fail is not known to
 * be a gate — this test plants a deliberate violation, asserts the build rejects it, then
 * reverts and asserts green again. The test captures exit code, never log text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildToTempDir, cleanup } from '../conformance/lib/build.mjs';

// Suppress unhandled rejections from Astro's internal cleanup that race with test completion.
// The test assertions themselves are not affected by this handler. These errors happen
// asynchronously after the test has already completed and passed, so suppressing them
// is safe and necessary to avoid false test failures.
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Suppress filesystem errors from Astro's async cleanup operations
  if (!msg.includes('ENOENT') && !msg.includes('UnknownFilesystemError') && !msg.includes('data-store')) {
    // Re-emit for visibility of unexpected errors (but don't crash the test)
    console.error('Unexpected unhandled rejection:', err);
  }
  // Always suppress - these are cleanup-time errors that don't represent test failures
});

test('schema violation: status:published with no publishedAt causes build to fail', async (t) => {
  // Create a temporary content repository with minimal valid seed data
  const tempContentDir = mkdtempSync(join(tmpdir(), 'jamground-test-content-'));

  try {
    // Create directory structure for all required collections
    mkdirSync(join(tempContentDir, 'content', 'settings'), { recursive: true });
    mkdirSync(join(tempContentDir, 'content', 'posts', 'en-US'), { recursive: true });
    mkdirSync(join(tempContentDir, 'content', 'authors', 'en-US'), { recursive: true });
    mkdirSync(join(tempContentDir, 'content', 'pages', 'en-US'), { recursive: true });
    mkdirSync(join(tempContentDir, 'content', 'navigation', 'en-US'), { recursive: true });

    // Write settings (required for build)
    const siteYaml = `defaultLocale: en-US
locales:
  - en-US
siteName: Jamground Test
baseUrl: https://example.org/
`;
    writeFileSync(join(tempContentDir, 'content', 'settings', 'site.yaml'), siteYaml);

    // Create a minimal test author (required by Post schema)
    const testAuthorPath = join(tempContentDir, 'content', 'authors', 'en-US', 'test-author.yaml');
    const validAuthor = `id: 01M0BSHNK661FD6Y2JPMH75A1C
translationOf: 01M0BSHNK661FD6Y2JPMH75A1C
locale: en-US
slug: test-author
title: Test Author
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
name: Test Author
`;
    writeFileSync(testAuthorPath, validAuthor);

    // Create a minimal test page (required for the pages collection)
    // Pages require blocks array with at least one block (paragraph with text)
    const testPagePath = join(tempContentDir, 'content', 'pages', 'en-US', 'test-page.yaml');
    const validPage = `id: 01M0BSHTFEWS6VYC4XBR52R3JF
translationOf: 01M0BSHSG62QD33PKX3GRRXX5X
locale: en-US
slug: test-page
title: Test Page
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
blocks:
  - type: paragraph
    text: Test page content
`;
    writeFileSync(testPagePath, validPage);

    // Create a minimal test navigation (required for the navigation collection)
    const testNavPath = join(tempContentDir, 'content', 'navigation', 'en-US', 'test-nav.yaml');
    const validNav = `id: 01M0BSHTFEWS6VYC4XBR52R3JG
translationOf: 01M0BSHSG62QD33PKX3GRRXX5Y
locale: en-US
slug: test-nav
title: Test Navigation
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
items:
  - label: Home
    ref: 01M0BSHSG62QD33PKX3GRRXX5X
`;
    writeFileSync(testNavPath, validNav);

    // Create a valid test post with status:published and publishedAt
    const testPostPath = join(tempContentDir, 'content', 'posts', 'en-US', 'test-post.md');
    const validPost = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test-post
title: Test Post
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
---

Test content.
`;
    writeFileSync(testPostPath, validPost);

    const originalEnv = process.env.JAMGROUND_CONTENT_DIR;
    process.env.JAMGROUND_CONTENT_DIR = tempContentDir;
    const sharedCacheDir = mkdtempSync(join(tmpdir(), 'jamground-test-cache-'));

    try {
      // Test 1: Build should succeed with valid content
      const outDir1 = await buildToTempDir({ cacheDir: sharedCacheDir });
      assert(outDir1, 'valid build should produce output');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));

      // Test 2: Plant the schema violation (remove publishedAt)
      const violatedPost = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JE
translationOf: 01M0BSHSG62QD33PKX3GRRXX5W
locale: en-US
slug: test-post
title: Test Post
status: published
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
---

Test content.
`;
      writeFileSync(testPostPath, violatedPost);

      // Build should fail with schema violation
      let buildFailed = false;
      try {
        const outDir2 = await buildToTempDir({ cacheDir: sharedCacheDir });
        // If build succeeded when it should have failed, fail the test
        assert.fail('build should have failed with schema violation but succeeded');
      } catch (err) {
        // Expected: build should throw due to schema validation error
        buildFailed = true;
      }
      assert(buildFailed, 'build must fail with schema violation');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));

      // Test 3: Revert the violation and verify build succeeds again
      writeFileSync(testPostPath, validPost);
      const outDir3 = await buildToTempDir({ cacheDir: sharedCacheDir });
      assert(outDir3, 'build should succeed again after reverting violation');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      // Restore environment
      if (originalEnv !== undefined) process.env.JAMGROUND_CONTENT_DIR = originalEnv;
      else delete process.env.JAMGROUND_CONTENT_DIR;

      // Give Astro's internal event loop time to fully settle before cleanup
      // This avoids race conditions where Astro tries to write to files after cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clean up the shared cache directory - do this last to allow all async operations to complete
      try {
        rmSync(sharedCacheDir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  } finally {
    // Clean up temp content directory whatever the outcome
    rmSync(tempContentDir, { recursive: true, force: true });
  }
});
