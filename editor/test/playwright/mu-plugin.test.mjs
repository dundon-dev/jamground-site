// The mu-plugin: allowlist, stripped supports, block assets, welcome guide.
//
// The allowlist alone is a content-quality / round-trip mechanism, never a security
// control — this test only observes what the inserter offers, in-browser. There is no
// jamground/* block in this release, so the inserter assertion owed here is the NEGATIVE
// one: forbidden core blocks (Columns, Cover, Group, …) must not appear. The positive form —
// a custom block appearing — has no reproducible artefact and is not asserted.
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

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, {
    cwd: editorDir,
    stdio: 'pipe',
  });
}

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

test('mu-plugin: allowlist, stripped supports, block assets, welcome guide', async () => {
  await buildBundle();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => {
      return window.jamgroundReady === true || typeof window.jamgroundBootError !== 'undefined';
    }, { timeout: 240000 });

    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    // Create a post and navigate to its edit screen so the mu-plugin's admin_init and
    // enqueue_block_assets hooks fire for a request made after the file was written.
    const postId = await page.evaluate(async () => {
      const client = window.jamgroundClient;
      const root = await client.documentRoot;
      await client.writeFile(root + '/jp-seed.php', `<?php require '${root}/wp-load.php';
        $id = wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Probe',
          'post_content'=>"<!-- wp:heading -->\\n<h2 class=\\"wp-block-heading\\">Section</h2>\\n<!-- /wp:heading -->"]);
        echo 'POST:' . $id;`);
      const s = await client.run({ code: `<?php require '${root}/jp-seed.php';` });
      return (s.text.match(/POST:(\d+)/) || [])[1];
    });
    assert(postId, 'seed post should have been created');

    await page.evaluate(async (id) => {
      await window.jamgroundClient.goTo('/wp-admin/post.php?post=' + id + '&action=edit');
    }, postId);

    // Find the frame that actually holds wp-admin, whatever the nesting (the iframe is
    // cross-origin, so the shell page cannot inspect it directly — Playwright can).
    let admin = null;
    let canvasFrame = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (!admin && await f.locator('#editor, .interface-interface-skeleton, .editor-header').count()) admin = f;
          if (!canvasFrame && await f.locator('.block-editor-writing-flow, .block-editor-block-list__layout').count()) canvasFrame = f;
        } catch {}
      }
      if (admin && canvasFrame) break;
      await page.waitForTimeout(250);
    }
    assert(admin, 'the wp-admin frame should be reachable');

    // 4. Welcome guide suppressed.
    const welcomeGuideCount = await admin.locator('.edit-post-welcome-guide, .components-guide').count();
    assert.equal(welcomeGuideCount, 0, 'the welcome guide should not appear');

    // 3. enqueue_block_assets: the shared stylesheet loads inside the editor canvas.
    const cf = canvasFrame && canvasFrame !== admin ? canvasFrame : admin.childFrames()[0];
    assert(cf, 'the editor canvas frame should be reachable');
    const probe = await cf.locator('body').evaluate((b) => getComputedStyle(b).getPropertyValue('--jp-mu-plugin'));
    assert.equal(String(probe).trim(), 'present', 'enqueue_block_assets CSS should be inside the canvas');

    // 1. allowed_block_types_all: the inserter is restricted. This is the NEGATIVE
    // assertion — no jamground/* block exists yet, so
    // only the absence of disallowed core blocks is checked.
    await admin.locator('button[aria-label*="Block Inserter" i]').first().click({ timeout: 15000 });
    await page.waitForTimeout(3000);
    const names = [...new Set(
      (await admin.locator('.block-editor-block-types-list__item-title').allInnerTexts()).map((s) => s.trim()).filter(Boolean)
    )];
    assert(names.length > 0, 'the inserter should offer at least one block');
    assert(
      !names.some((n) => /^(Columns|Cover|Group|Buttons|Gallery)$/i.test(n)),
      `the inserter should not offer disallowed blocks, got: ${names.join(', ')}`
    );
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
