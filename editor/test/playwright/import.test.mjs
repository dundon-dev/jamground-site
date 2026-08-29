// Import: contract -> Gutenberg, on boot.
//
// Watches the whole pipeline run for real: fetch the two seed posts (unauthenticated),
// validate and convert them, and insert them into wp-admin. A draft post appearing in the
// post list is the positive assertion here; the id/source mapping in post meta
// is asserted directly rather than inferred.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { CONTENT_BLOB_BASE, CONTENT_TREE_URL } from '../../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

/* What the content repository actually holds, asked of the repository rather than written
 * down here. The count below used to be the literal 2, which was a fact about one seed at
 * one moment rather than about import: a fork's repository holds a different number of
 * posts, and this assertion is meant to catch import dropping one, not to catch the seed
 * changing. Derived, it still catches exactly that. */
async function listSeedPosts() {
  const res = await fetch(CONTENT_TREE_URL);
  if (!res.ok) throw new Error(`Failed to fetch the content tree: ${res.status} ${CONTENT_TREE_URL}`);
  const data = await res.json();
  return (data.tree || [])
    .map((entry) => entry.path)
    .filter((p) => typeof p === 'string' && p.startsWith('content/posts/') && p.endsWith('.md'))
    .sort();
}

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

test('import: every seed post lands in wp-admin with id/source post meta', async () => {
  await buildBundle();

  // Asked of the repository before the browser starts, so the assertions below compare
  // against what is actually there rather than against a remembered filename.
  const seedPaths = await listSeedPosts();

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
    const contractIds = Object.keys(map);
    assert(seedPaths.length >= 1, 'the content repository should expose at least one locale post');
    assert.equal(
      contractIds.length,
      seedPaths.length,
      `expected one imported post per locale post in the repository (${seedPaths.length}: `
      + `${seedPaths.join(', ')}), got ${contractIds.length}: ${contractIds.join(', ')}`,
    );

    // Post meta round trip: the contract id and the fetched bytes verbatim.
    const metaByPostId = await page.evaluate(async (map) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const ids = Object.values(map);
      const phpEntries = ids.map((id) =>
        `$out[${JSON.stringify(String(id))}] = ['status'=>get_post_status(${id}),` +
        `'jid'=>get_post_meta(${id},'_jamground_id',true),'src'=>get_post_meta(${id},'_jamground_source',true),` +
        `'path'=>get_post_meta(${id},'_jamground_path',true),` +
        `'name'=>get_post_field('post_name',${id})];`
      ).join('\n');
      const code = `<?php require '${root}/wp-load.php'; $out = []; ${phpEntries} echo json_encode($out);`;
      const s = await c.run({ code });
      return JSON.parse(s.text);
    }, map);

    const BLOB_BASE = CONTENT_BLOB_BASE;
    const pathsSeenPerPost = [];
    let expectedDrafts = 0;

    for (const [contractId, postId] of Object.entries(map)) {
      const meta = metaByPostId[String(postId)];
      assert(meta, `post meta should exist for post ${postId}`);
      assert.equal(meta.jid, contractId, '_jamground_id should equal the contract id');
      assert(typeof meta.src === 'string' && meta.src.startsWith('---'), '_jamground_source should hold the fetched bytes, starting with the frontmatter fence');
      assert(['draft', 'publish'].includes(meta.status), `post_status should map from contract status, got: ${meta.status}`);

      // Assert that _jamground_path is set
      assert(meta.path, `_jamground_path should be set for post ${postId}`);
      pathsSeenPerPost.push(meta.path);

      // Fetch the raw file from GitHub at the path and assert byte-identity
      const fileUrl = `${BLOB_BASE}/${meta.path}`;
      const fileResponse = await fetch(fileUrl);
      assert.equal(fileResponse.status, 200, `should fetch file at ${meta.path} with status 200, got ${fileResponse.status}`);
      const fileBytes = await fileResponse.text();
      assert.equal(fileBytes, meta.src, `bytes at ${meta.path} should be byte-identical to _jamground_source`);

      // Assert that post_name matches the slug from the _jamground_source frontmatter
      const lines = meta.src.split('\n');
      let closingFenceIndex = -1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith('---')) {
          closingFenceIndex = i;
          break;
        }
      }
      assert(closingFenceIndex !== -1, 'frontmatter should have a closing fence');
      const frontmatterText = lines.slice(1, closingFenceIndex).join('\n');
      const frontmatter = yaml.parse(frontmatterText);
      assert.equal(meta.name, frontmatter.slug, `post_name should equal the slug from _jamground_source, expected: ${frontmatter.slug}, got: ${meta.name}`);

      // Status must ROUND-TRIP, per post, rather than merely being one of the two legal
      // values (asserted above). `draft` maps to `draft` and `published` to `publish`; a
      // mapping that inverted, or that defaulted everything to one value, passes the
      // membership check and fails here.
      const expectedStatus = frontmatter.status === 'draft' ? 'draft' : 'publish';
      assert.equal(meta.status, expectedStatus, `post_status should map from the contract status \`${frontmatter.status}\`, expected: ${expectedStatus}, got: ${meta.status}`);
      if (expectedStatus === 'draft') expectedDrafts += 1;
    }

    // Assert that every imported post recorded its own distinct path — one path per post,
    // no two the same, which is what a path collision during import would break.
    assert.equal(pathsSeenPerPost.length, seedPaths.length, `should have collected ${seedPaths.length} path(s)`);
    assert.equal(new Set(pathsSeenPerPost).size, pathsSeenPerPost.length, `the posts should have distinct paths: ${pathsSeenPerPost.join(', ')}`);

    // The drafts view, counted rather than assumed. This deliberately does NOT assert that a
    // draft exists: a fork's content repository may hold drafts or none, and an assertion that
    // depends on seed data is testing the seed rather than the importer. What must hold either
    // way is that the number of posts WordPress files as drafts equals the number the content
    // declared — which catches both a draft that failed to import and a published post wrongly
    // filed as one.
    await page.evaluate(async () => {
      await window.jamgroundClient.goTo('/wp-admin/edit.php?post_status=draft&post_type=post');
    });

    let listFrame = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (await f.locator('.wp-list-table').count()) { listFrame = f; break; }
        } catch {}
      }
      if (listFrame) break;
      await page.waitForTimeout(250);
    }
    assert(listFrame, 'the draft post list should be reachable');
    // `:not(.no-items)` because an empty list table still renders one row saying so.
    const rowCount = await listFrame.locator('.wp-list-table tbody tr:not(.no-items)').count();
    assert.equal(rowCount, expectedDrafts, `the drafts view should list exactly the ${expectedDrafts} draft(s) the content declares, got ${rowCount}`);
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
