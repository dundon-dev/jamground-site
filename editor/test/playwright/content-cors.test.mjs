// Unauthenticated cross-origin reads of the content repository, from a real browser origin.
//
// What this proves is a CORS fact, not a content fact: a page served from an ordinary origin
// can read the content tree from api.github.com and the file bytes from
// raw.githubusercontent.com with no token and no proxy — which is the assumption
// editor/lib/content-source.mjs is built on.
//
// It used to name two seed files and assert the tree contained them. That was never testing
// CORS; it was testing that one particular content repository still held one particular pair
// of filenames, and it broke the moment the seed changed. A fork's content repository holds
// something else entirely. So the file set is DERIVED from the tree the browser just fetched:
// every locale post the repository actually contains is fetched, and every one must come back
// readable and looking like a content file. That fails on exactly the things this test exists
// to catch — a missing CORS header, a private repository, a 404 endpoint — and stops failing
// on the thing it never meant to test.
import test from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import http from 'http';
import { CONTENT_BLOB_BASE, CONTENT_TREE_URL } from '../../config.mjs';

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/test.html') {
      // The two endpoints are interpolated from the fork's own configuration by Node, before
      // the page ever runs; inside the page script itself `\${…}` is escaped so it stays the
      // browser's own interpolation rather than this file's.
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Content CORS Test</title>
</head>
<body>
  <script>
    window.testResults = {};

    async function runTests() {
      const treeUrl = ${JSON.stringify(CONTENT_TREE_URL)};
      const blobBase = ${JSON.stringify(CONTENT_BLOB_BASE)};

      let postPaths = [];
      try {
        const treeRes = await fetch(treeUrl);
        window.testResults.treeResponseOk = treeRes.ok;
        const treeData = await treeRes.json();
        const tree = treeData.tree || [];
        // Whatever locale posts this repository holds — never a named file.
        postPaths = tree
          .map((item) => item.path)
          .filter((p) => typeof p === 'string' && p.startsWith('content/posts/') && p.endsWith('.md'))
          .sort();
        window.testResults.postPaths = postPaths;
      } catch (err) {
        window.testResults.treeError = err.message;
      }

      const blobs = [];
      for (const path of postPaths) {
        try {
          const res = await fetch(\`\${blobBase}/\${path}\`);
          const text = res.ok ? await res.text() : '';
          blobs.push({ path, ok: res.ok, startsWithFrontmatter: text.startsWith('---') });
        } catch (err) {
          blobs.push({ path, ok: false, error: err.message });
        }
      }
      window.testResults.blobs = blobs;

      window.testResults.done = true;
    }

    runTests();
  </script>
</body>
</html>
      `;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://${addr.address}:${addr.port}` });
    });
  });
}

test('unauthenticated CORS access from browser origin', async (t) => {
  const { server, url } = await startServer();
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to the test page
    await page.goto(`${url}/`);

    // Wait for tests to complete
    await page.waitForFunction(
      () => window.testResults?.done === true,
      { timeout: 15000 }
    );

    // Get results from page
    const results = await page.evaluate(() => window.testResults);

    // The tree endpoint answers a cross-origin, unauthenticated request.
    assert.strictEqual(results.treeError, undefined, `Tree fetch should not have errors: ${results.treeError}`);
    assert.strictEqual(results.treeResponseOk, true, 'Tree endpoint should return ok response');

    // At least one locale post, or the blob half of this test proves nothing at all — an
    // empty list would otherwise satisfy every assertion below by vacuity.
    assert.ok(
      Array.isArray(results.postPaths) && results.postPaths.length >= 1,
      `the content repository should expose at least one locale post; got: ${JSON.stringify(results.postPaths)}`,
    );
    for (const path of results.postPaths) {
      assert.match(path, /^content\/posts\/[a-z]{2}-[A-Z]{2}\/[^/]+\.md$/, `unexpected post path: ${path}`);
    }

    // Every one of them is readable cross-origin, and is a content file rather than an
    // error page GitHub served with a 200.
    assert.strictEqual(results.blobs.length, results.postPaths.length, 'every listed post should have been fetched');
    for (const blob of results.blobs) {
      assert.strictEqual(blob.error, undefined, `${blob.path} fetch should not have errors: ${blob.error}`);
      assert.strictEqual(blob.ok, true, `${blob.path} should return ok response`);
      assert.strictEqual(blob.startsWithFrontmatter, true, `${blob.path} should start with frontmatter fence`);
    }

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
