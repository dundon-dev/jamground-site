// Draft: The draft post is imported, listed and editable
//
// Verifies the key assertion of this release: drafts imported from the content
// repository are excluded from the build but visible to editors in wp-admin.
// A shell that filters drafts the same way the build does is wrong in a way no
// schema check catches.
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

test('draft: the draft post is imported, listed and editable', async () => {
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

    const importError = await page.evaluate(() => window.jamgroundImportError);
    assert(!importError, `Import should not throw: ${importError}`);

    const map = await page.evaluate(() => window.jamgroundImportResult);
    assert(map, 'import should have produced a contract-id -> post-id map');

    // 1. Both seed posts exist after import — two posts, no more
    const contractIds = Object.keys(map);
    assert.equal(contractIds.length, 2, `expected exactly two imported posts, got: ${contractIds.length}`);

    // 2. Get post_status for each post via client API
    const postStatuses = await page.evaluate(async (map) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const ids = Object.values(map);
      const phpEntries = ids.map((id) =>
        `$out[${JSON.stringify(String(id))}] = ['status'=>get_post_status(${id}),'jid'=>get_post_meta(${id},'_jamground_id',true)];`
      ).join('\n');
      const code = `<?php require '${root}/wp-load.php'; $out = []; ${phpEntries} echo json_encode($out);`;
      const s = await c.run({ code });
      return JSON.parse(s.text);
    }, map);

    // Identify which is draft and which is publish
    const draftPostId = Object.entries(postStatuses).find(([, meta]) => meta.status === 'draft')?.[0];
    const publishPostId = Object.entries(postStatuses).find(([, meta]) => meta.status === 'publish')?.[0];

    assert(draftPostId, 'one post should be a draft');
    assert(publishPostId, 'one post should be published');

    // Check that the draft post has the expected ID
    const draftMeta = postStatuses[draftPostId];
    assert.equal(draftMeta.jid, '01M0BSHRGY5ZASDV3325D7XWXG', `draft post should have the expected _jamground_id`);

    // 3. Both appear in the wp-admin post list
    // First check the draft post list
    await page.evaluate(async () => {
      await window.jamgroundClient.goTo('/wp-admin/edit.php?post_status=draft&post_type=post');
    });

    let draftListFrame = null;
    const listDeadline = Date.now() + 60000;
    while (Date.now() < listDeadline) {
      for (const f of page.frames()) {
        try {
          if (await f.locator('.wp-list-table').count()) { draftListFrame = f; break; }
        } catch {}
      }
      if (draftListFrame) break;
      await page.waitForTimeout(250);
    }
    assert(draftListFrame, 'the draft post list should be reachable');

    const draftRowCount = await draftListFrame.locator('.wp-list-table tbody tr').count();
    assert(draftRowCount >= 1, 'the imported draft should appear in the draft post list');

    // Check the published post list
    await page.evaluate(async () => {
      await window.jamgroundClient.goTo('/wp-admin/edit.php?post_status=publish&post_type=post');
    });

    let publishListFrame = null;
    const publishListDeadline = Date.now() + 60000;
    while (Date.now() < publishListDeadline) {
      for (const f of page.frames()) {
        try {
          if (await f.locator('.wp-list-table').count()) { publishListFrame = f; break; }
        } catch {}
      }
      if (publishListFrame) break;
      await page.waitForTimeout(250);
    }
    assert(publishListFrame, 'the published post list should be reachable');

    const publishRowCount = await publishListFrame.locator('.wp-list-table tbody tr').count();
    assert(publishRowCount >= 1, 'the imported published post should appear in the published post list');

    // 4. Opening each in the block editor reaches an editable canvas
    // Open draft post in editor
    await page.evaluate(async (id) => {
      await window.jamgroundClient.goTo('/wp-admin/post.php?post=' + id + '&action=edit');
    }, draftPostId);

    let draftEditorFrame = null;
    let draftCanvasFrame = null;
    const draftEditorDeadline = Date.now() + 90000;
    while (Date.now() < draftEditorDeadline) {
      for (const f of page.frames()) {
        try {
          if (!draftEditorFrame && await f.locator('#editor, .interface-interface-skeleton, .editor-header').count()) {
            draftEditorFrame = f;
          }
          if (!draftCanvasFrame && await f.locator('.block-editor-writing-flow, .block-editor-block-list__layout').count()) {
            draftCanvasFrame = f;
          }
        } catch {}
      }
      if (draftEditorFrame && draftCanvasFrame) break;
      await page.waitForTimeout(250);
    }
    assert(draftEditorFrame, 'the draft post editor frame should be reachable');
    assert(draftCanvasFrame, 'the draft post editor canvas should be reachable');

    // Open published post in editor
    await page.evaluate(async (id) => {
      await window.jamgroundClient.goTo('/wp-admin/post.php?post=' + id + '&action=edit');
    }, publishPostId);

    let publishEditorFrame = null;
    let publishCanvasFrame = null;
    const publishEditorDeadline = Date.now() + 90000;
    while (Date.now() < publishEditorDeadline) {
      for (const f of page.frames()) {
        try {
          if (!publishEditorFrame && await f.locator('#editor, .interface-interface-skeleton, .editor-header').count()) {
            publishEditorFrame = f;
          }
          if (!publishCanvasFrame && await f.locator('.block-editor-writing-flow, .block-editor-block-list__layout').count()) {
            publishCanvasFrame = f;
          }
        } catch {}
      }
      if (publishEditorFrame && publishCanvasFrame) break;
      await page.waitForTimeout(250);
    }
    assert(publishEditorFrame, 'the published post editor frame should be reachable');
    assert(publishCanvasFrame, 'the published post editor canvas should be reachable');

  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
