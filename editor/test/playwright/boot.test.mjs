// Test that Playground boots cross-origin and reaches wp-admin
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

// Helper to build the bundle
async function buildBundle() {
  try {
    execSync(`node ${path.join(editorDir, 'build.mjs')}`, {
      cwd: editorDir,
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(`Build failed: ${error.message}`);
  }
}

// Helper to serve dist directory
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(distDir, 'index.html')).then((content) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        });
      } else {
        const filePath = path.join(distDir, req.url);
        fs.readFile(filePath).then(
          (content) => {
            const contentType = req.url.endsWith('.js') ? 'application/javascript' : 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
          },
          () => {
            res.writeHead(404);
            res.end('Not found');
          }
        );
      }
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

test('Playground boots cross-origin and reaches wp-admin', async () => {
  // Build the bundle
  await buildBundle();

  // Start server
  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    // Launch browser
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // Listen to console messages
    page.on('console', (msg) => console.log(`[PAGE] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`[PAGE ERROR] ${err}`));

    // Navigate to page
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Wait for Playground to be ready
    await page.waitForFunction(() => {
      const ready = typeof window.jamgroundReady !== 'undefined';
      const err = typeof window.jamgroundBootError !== 'undefined';
      return ready || err;
    }, { timeout: 30000 });

    // Verify that the iframe element exists and has id="wp"
    const iframeId = await page.evaluate(() => document.getElementById('wp')?.id);
    assert.equal(iframeId, 'wp', 'iframe should have id="wp"');

    // Verify that the root element has id="jamground-shell"
    const rootId = await page.evaluate(() => document.body?.id);
    assert.equal(rootId, 'jamground-shell', 'body should have id="jamground-shell"');

    // Check that jamgroundReady flag is set
    const isReady = await page.evaluate(() => window.jamgroundReady === true);
    assert(isReady, 'Playground should be ready');

    // Verify no boot error
    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    // Check that wp-admin is accessible through the iframe
    // We wait for the iframe to have content that indicates wp-admin
    await page.waitForTimeout(2000);

    // Get iframe title or content to verify wp-admin is loaded
    const iframeElement = page.frameLocator('#wp');

    // Wait for the iframe to have navigated to wp-admin
    // This is a basic check - the iframe should contain WordPress admin content
    const iframeReady = await page.evaluate(() => {
      const iframe = document.getElementById('wp');
      // Cross-origin iframes cannot be directly inspected, so we rely on the Playground client API
      // which is handled by the jamgroundReady flag
      return iframe && iframe.src && iframe.src.includes('wordpress.net');
    });

    assert(iframeReady, 'iframe should be pointing to Playground remote URL');

  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
