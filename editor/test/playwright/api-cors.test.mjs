import test from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import http from 'http';

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/test.html') {
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>API CORS Preflight Test</title>
</head>
<body>
  <script>
    window.testResults = {};

    async function runTests() {
      try {
        // Test: Attempt to create a blob on api.github.com (Git Data write endpoint)
        // This will trigger a preflight OPTIONS request because:
        // 1. Method is POST (not simple)
        // 2. Authorization header is included (custom header, not in simple list)
        //
        // The preflight should be answered with Access-Control-Allow-Origin and
        // authorization (or Authorization) in Access-Control-Allow-Headers
        const response = await fetch(
          'https://api.github.com/repos/octocat/Hello-World/git/blobs',
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer test-token',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              content: 'test',
              encoding: 'utf-8'
            })
          }
        );

        // If we get here, the preflight was successful (CORS headers were correct)
        // The actual request might return 401 (unauthorized) or other error, but
        // that means CORS preflight passed
        window.testResults.preflightPassed = true;
        window.testResults.isCorsError = false;
        window.testResults.responseStatus = response.status;

        // Try to read the response to check for CORS headers in context
        // (these won't be visible to us but the fact that we got a response means CORS passed)
        try {
          const contentType = response.headers.get('content-type');
          window.testResults.responseHasContentType = contentType !== null;
        } catch (e) {
          // Headers might not be accessible, but that's ok
          window.testResults.responseHasContentType = false;
        }
      } catch (err) {
        // If we get a CORS error, it will have a specific message pattern
        const errorMsg = err.message || err.toString();
        window.testResults.preflightPassed = false;
        window.testResults.corsError = errorMsg;

        // Check if this is a CORS-related error
        window.testResults.isCorsError =
          errorMsg.includes('CORS') ||
          errorMsg.includes('cross-origin') ||
          errorMsg.includes('Access-Control');
      }

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

test('API CORS preflight for Git Data write endpoint', async (t) => {
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
      { timeout: 30000 }
    );

    // Get results from page
    const results = await page.evaluate(() => window.testResults);

    // The preflight should pass, which means we get a response
    // (even if it's 401 or another HTTP error, the CORS preflight succeeded)
    assert.strictEqual(
      results.preflightPassed,
      true,
      'CORS preflight to api.github.com should pass - if this fails, check CORS headers'
    );

    // Ensure we didn't get a CORS error
    assert.strictEqual(
      results.isCorsError,
      false,
      `Should not receive CORS error: ${results.corsError || 'none'}`
    );

    // We should have received a response status (indicating the preflight passed)
    assert.ok(
      results.responseStatus !== undefined,
      'Should receive a response status from api.github.com'
    );

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
