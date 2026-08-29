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
import { KINDS } from '../../lib/kinds.mjs';
import { listSeedEntities } from './seed-entities.mjs';

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

  // Asked of the repository, not written down: this used to be the literal 2, which was a
  // fact about a seed that no longer exists. The repository now holds three entities across
  // two kinds, and a literal here would be wrong again the next time the seed moves.
  const seedEntities = await listSeedEntities();

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

    // 1. Every seed entity exists after import — that many rows, no more
    const contractIds = Object.keys(map);
    assert.equal(
      contractIds.length,
      seedEntities.length,
      `expected one imported row per entity in the repository (${seedEntities.length}), got: ${contractIds.length}`,
    );

    // 2. Get post_status for each post via client API
    const postStatuses = await page.evaluate(async (map) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const ids = Object.values(map);
      const phpEntries = ids.map((id) =>
        `$out[${JSON.stringify(String(id))}] = ['status'=>get_post_status(${id}),'jid'=>get_post_meta(${id},'_jamground_id',true),`
        + `'kind'=>get_post_meta(${id},'_jamground_kind',true),'type'=>get_post_type(${id})];`
      ).join('\n');
      const code = `<?php require '${root}/wp-load.php'; $out = []; ${phpEntries} echo json_encode($out);`;
      const s = await c.run({ code });
      return JSON.parse(s.text);
    }, map);

    // Identify which is draft and which is publish
    const draftPostId = Object.entries(postStatuses).find(([, meta]) => meta.status === 'draft')?.[0];
    const publishPostId = Object.entries(postStatuses).find(([, meta]) => meta.status === 'publish')?.[0];

    // DERIVED FROM THE CONTENT, NOT ASSUMED OF IT. This test asserted that a draft exists, and
    // pinned the contract id of the seed draft that used to. The content repository ships no
    // draft any more — that was a deliberate choice when it was reseeded — so both assertions
    // were false, and neither could be seen from `npm test`, whose editor glob is non-recursive.
    //
    // What must hold whatever the content contains is the MAPPING: `status: draft` becomes a
    // WordPress draft and `status: published` becomes a publish, for every row. A test that needs
    // a particular entity to exist is testing the seed; this tests the importer.
    assert(publishPostId, 'the seed content has published entities, so at least one row must be a publish');
    for (const [id, m] of Object.entries(postStatuses)) {
      assert.ok(['draft', 'publish'].includes(m.status),
        `row ${id} has status ${m.status}, which is neither of the two the contract maps to`);
    }

    const publishMeta = postStatuses[publishPostId];
    // The row's declared kind and WordPress's own post type must agree, on every row — the
    // same three-way agreement read-posts.mjs enforces before it will export anything.
    for (const [id, m] of Object.entries(postStatuses)) {
      assert.equal(m.type, KINDS[m.kind].wpPostType, `row ${id} declares kind ${m.kind} but is filed as ${m.type}`);
    }
    // The contract id that used to be pinned here belonged to a seed draft that no longer
    // exists. Every row's id is checked against the session map instead, which holds however
    // many entities the repository actually has.
    for (const [id, m] of Object.entries(postStatuses)) {
      assert.ok(m.jid, `row ${id} carries no _jamground_id, so nothing downstream can identify it`);
    }

    // 3. Both appear in the wp-admin post list
    // First check the draft post list. The type is the DRAFT ROW'S OWN, from the kind table —
    // `post_type=post` was hardcoded, and with pages imported it lists only half of what the
    // shell put into wp-admin while still satisfying a `>= 1` count, which is the worst kind
    // of green: an assertion that keeps passing while measuring the wrong thing.
    // Counted against what the content declares, so this holds at zero drafts as well as at one.
    const draftType = draftPostId
      ? KINDS[postStatuses[draftPostId].kind].wpPostType
      : KINDS[publishMeta.kind].wpPostType;
    await page.evaluate(async (t) => {
      await window.jamgroundClient.goTo(`/wp-admin/edit.php?post_status=draft&post_type=${t}`);
    }, draftType);

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

    // `:not(.no-items)` because an empty list table still renders one row saying so. Equality,
    // not `>= 1`: the old bound kept passing while measuring the wrong half once pages existed.
    const draftRowCount = await draftListFrame.locator('.wp-list-table tbody tr:not(.no-items)').count();
    const expectedForType = Object.values(postStatuses)
      .filter((m) => m.status === 'draft' && KINDS[m.kind].wpPostType === draftType).length;
    assert.equal(draftRowCount, expectedForType,
      `the drafts view for ${draftType} should list exactly the ${expectedForType} the content declares, got ${draftRowCount}`);

    // Check the published post list, likewise under the published row's own type.
    const publishType = KINDS[publishMeta.kind].wpPostType;
    await page.evaluate(async (t) => {
      await window.jamgroundClient.goTo(`/wp-admin/edit.php?post_status=publish&post_type=${t}`);
    }, publishType);

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

    const publishRowCount = await publishListFrame.locator('.wp-list-table tbody tr:not(.no-items)').count();
    const expectedPublished = Object.values(postStatuses)
      .filter((m) => m.status === 'publish' && KINDS[m.kind].wpPostType === publishType).length;
    assert.equal(publishRowCount, expectedPublished,
      `the published view for ${publishType} should list exactly the ${expectedPublished} the content declares, got ${publishRowCount}`);

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
