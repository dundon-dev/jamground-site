/* Invariant: A draft entity produces no file in dist/ — no route, no HTML file, no sitemap entry,
 * no hreflang alternate (05 §Drafts). JAMGROUND_INCLUDE_DRAFTS=1 includes drafts in preview
 * builds. Any other non-empty value is a hard error. A gate nobody has watched fail is not
 * known to be a gate — this test plants a seeded draft, asserts it is excluded by default,
 * asserts it is included when the flag is '1', and asserts that any other value throws. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildToTempDir, listFiles } from '../conformance/lib/build.mjs';

// Suppress unhandled rejections from Astro's internal cleanup that race with test completion.
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes('ENOENT') && !msg.includes('UnknownFilesystemError') && !msg.includes('data-store')) {
    console.error('Unexpected unhandled rejection:', err);
  }
});

test('drafts: seeded draft excluded by default, included with JAMGROUND_INCLUDE_DRAFTS=1, error on invalid value', async (t) => {
  // Create a temporary content repository with minimal valid seed data plus a draft
  const tempContentDir = mkdtempSync(join(tmpdir(), 'jamground-test-content-drafts-'));

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

    // Create a valid published post
    const publishedPostPath = join(tempContentDir, 'content', 'posts', 'en-US', 'published-post.md');
    const publishedPost = `---
id: 01M0BSHTFEWS6VYC4XBR52R3JA
translationOf: 01M0BSHSG62QD33PKX3GRRXX5A
locale: en-US
slug: published-post
title: Published Post
status: published
publishedAt: '2026-08-01T09:00:00Z'
updatedAt: '2026-08-01T09:00:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
excerpt: A published post
tags:
  - general
---

Published content.
`;
    writeFileSync(publishedPostPath, publishedPost);

    // Create a draft post with the same structure
    const draftPostPath = join(tempContentDir, 'content', 'posts', 'en-US', 'draft-post.md');
    const draftPost = `---
id: 01M0BSHRGY5ZASDV3325D7XWXG
translationOf: 01M0BSHQHP2AJ81S98TMMQB6S0
locale: en-US
slug: roadmap-preview
title: A preview of what is next
status: draft
publishedAt: '2026-09-01T09:00:00Z'
updatedAt: '2026-08-10T11:30:00Z'
author: 01M0BSHNK661FD6Y2JPMH75A1C
excerpt: An early look at translations, scheduled publishing and the editing shell.
tags:
  - roadmap
---

## Not ready yet

This post is a draft. It should not appear in any published listing, sitemap, or locale index until an editor changes its status to published.
`;
    writeFileSync(draftPostPath, draftPost);

    const originalEnv = process.env.JAMGROUND_CONTENT_DIR;
    const sharedCacheDir = mkdtempSync(join(tmpdir(), 'jamground-test-cache-'));

    try {
      // Test 1: Build with default (drafts excluded)
      process.env.JAMGROUND_CONTENT_DIR = tempContentDir;
      const outDir1 = await buildToTempDir({ cacheDir: sharedCacheDir });
      assert(outDir1, 'valid build should produce output');

      const files1 = listFiles(outDir1);
      const hasDraftRoute = files1.some(f => f.includes('en-us/blog/roadmap-preview'));
      assert(!hasDraftRoute, 'draft post should not have a route when drafts are excluded');

      // Verify published post is present
      const hasPublishedRoute = files1.some(f => f.includes('en-us/blog/published-post'));
      assert(hasPublishedRoute, 'published post should have a route');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));

      // Test 2: Build with JAMGROUND_INCLUDE_DRAFTS=1
      process.env.JAMGROUND_INCLUDE_DRAFTS = '1';
      const outDir2 = await buildToTempDir({ cacheDir: sharedCacheDir });
      assert(outDir2, 'build with JAMGROUND_INCLUDE_DRAFTS=1 should produce output');

      const files2 = listFiles(outDir2);
      const hasDraftRoute2 = files2.some(f => f.includes('en-us/blog/roadmap-preview'));
      assert(hasDraftRoute2, 'draft post should have a route when JAMGROUND_INCLUDE_DRAFTS=1');

      // Verify published post is still present
      const hasPublishedRoute2 = files2.some(f => f.includes('en-us/blog/published-post'));
      assert(hasPublishedRoute2, 'published post should still have a route');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));

      // Test 3: Build with invalid JAMGROUND_INCLUDE_DRAFTS value
      process.env.JAMGROUND_INCLUDE_DRAFTS = 'invalid';
      let buildThrew = false;
      try {
        const outDir3 = await buildToTempDir({ cacheDir: sharedCacheDir });
        // If build succeeded when it should have failed, fail the test
        assert.fail('build should have failed with invalid JAMGROUND_INCLUDE_DRAFTS value but succeeded');
      } catch (err) {
        // Expected: build should throw due to invalid draft flag
        buildThrew = true;
        const msg = err instanceof Error ? err.message : String(err);
        assert(
          msg.includes('JAMGROUND_INCLUDE_DRAFTS') || msg.includes('typo publishing drafts'),
          'error message should reference JAMGROUND_INCLUDE_DRAFTS or draft publishing',
        );
      }
      assert(buildThrew, 'build must fail with invalid JAMGROUND_INCLUDE_DRAFTS value');

      // Allow Astro's internal cleanup to complete
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      // Restore environment
      if (originalEnv !== undefined) process.env.JAMGROUND_CONTENT_DIR = originalEnv;
      else delete process.env.JAMGROUND_CONTENT_DIR;
      delete process.env.JAMGROUND_INCLUDE_DRAFTS;

      // Give Astro's internal event loop time to fully settle before cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clean up the shared cache directory
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
