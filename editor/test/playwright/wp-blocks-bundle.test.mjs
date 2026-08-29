// Test that createBlock and serialize work in the browser from a bundled module
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

test('WordPress blocks bundle: createBlock and serialize work in browser', async () => {
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

    // Navigate to page
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Wait for the API to be available
    await page.waitForFunction(() => typeof window.wpBlocksAPI !== 'undefined', { timeout: 5000 });

    // Test heading block
    const headingResult = await page.evaluate(() => {
      const { createBlock, serialize, parse } = window.wpBlocksAPI;
      const block = createBlock('core/heading', { level: 2, content: 'Test Heading' });
      const markup = serialize([block]);
      const parsed = parse(markup);
      return {
        isValid: parsed.length > 0 && parsed[0].isValid,
        blockName: parsed[0]?.name,
      };
    });

    assert(headingResult.isValid, 'Heading block should be valid');
    assert.equal(headingResult.blockName, 'core/heading', 'Block name should be core/heading');

    // Test paragraph block
    const paragraphResult = await page.evaluate(() => {
      const { createBlock, serialize, parse } = window.wpBlocksAPI;
      const block = createBlock('core/paragraph', { content: 'Test paragraph' });
      const markup = serialize([block]);
      const parsed = parse(markup);
      return {
        isValid: parsed.length > 0 && parsed[0].isValid,
        blockName: parsed[0]?.name,
      };
    });

    assert(paragraphResult.isValid, 'Paragraph block should be valid');
    assert.equal(paragraphResult.blockName, 'core/paragraph', 'Block name should be core/paragraph');

    // Test list block
    const listResult = await page.evaluate(() => {
      const { createBlock, serialize, parse } = window.wpBlocksAPI;
      const block = createBlock('core/list', { values: '<li>Item 1</li><li>Item 2</li>' });
      const markup = serialize([block]);
      const parsed = parse(markup);
      return {
        isValid: parsed.length > 0 && parsed[0].isValid,
        blockName: parsed[0]?.name,
      };
    });

    assert(listResult.isValid, 'List block should be valid');
    assert.equal(listResult.blockName, 'core/list', 'Block name should be core/list');

    // Test quote block
    const quoteResult = await page.evaluate(() => {
      const { createBlock, serialize, parse } = window.wpBlocksAPI;
      const block = createBlock('core/quote', { value: '<p>Test quote</p>' });
      const markup = serialize([block]);
      const parsed = parse(markup);
      return {
        isValid: parsed.length > 0 && parsed[0].isValid,
        blockName: parsed[0]?.name,
      };
    });

    assert(quoteResult.isValid, 'Quote block should be valid');
    assert.equal(quoteResult.blockName, 'core/quote', 'Block name should be core/quote');

  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
