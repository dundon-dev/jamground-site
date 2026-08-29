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
import { CONTENT_BLOB_BASE } from '../../config.mjs';
import { KINDS } from '../../lib/kinds.mjs';
import { parseEntity } from '../../lib/entity.mjs';
import { listSeedEntities, wpPostTypesOf } from './seed-entities.mjs';

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

test('import: every seed entity lands in wp-admin with id/source/kind post meta', async () => {
  await buildBundle();

  // Asked of the repository before the browser starts, so the assertions below compare
  // against what is actually there rather than against a remembered filename. Derived through
  // the kind table, so pages count as much as posts do — this used to filter to
  // `content/posts/**.md`, which would now report both pages as entities that failed to
  // arrive.
  const seedEntities = await listSeedEntities();
  const seedKindByPath = Object.fromEntries(seedEntities.map((e) => [e.path, e.kind]));

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
    assert(seedEntities.length >= 1, 'the content repository should expose at least one entity');
    assert.equal(
      contractIds.length,
      seedEntities.length,
      `expected one imported row per entity in the repository (${seedEntities.length}: `
      + `${seedEntities.map((e) => e.path).join(', ')}), got ${contractIds.length}: ${contractIds.join(', ')}`,
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
        `'kind'=>get_post_meta(${id},'_jamground_kind',true),` +
        `'type'=>get_post_type(${id}),` +
        `'name'=>get_post_field('post_name',${id})];`
      ).join('\n');
      const code = `<?php require '${root}/wp-load.php'; $out = []; ${phpEntries} echo json_encode($out);`;
      const s = await c.run({ code });
      return JSON.parse(s.text);
    }, map);

    const BLOB_BASE = CONTENT_BLOB_BASE;
    const pathsSeenPerPost = [];
    // Drafts are counted PER POST TYPE, because that is how `edit.php` lists them: one
    // navigation per type, each answering only about its own. A single total compared against
    // a single type's list would go green on zero drafts while measuring the wrong half.
    const expectedDraftsByType = Object.fromEntries(wpPostTypesOf(seedEntities).map((t) => [t, 0]));

    for (const [contractId, postId] of Object.entries(map)) {
      const meta = metaByPostId[String(postId)];
      assert(meta, `post meta should exist for post ${postId}`);
      assert.equal(meta.jid, contractId, '_jamground_id should equal the contract id');
      assert(typeof meta.src === 'string' && meta.src.length > 0, '_jamground_source should hold the fetched bytes');
      assert(['draft', 'publish'].includes(meta.status), `post_status should map from contract status, got: ${meta.status}`);

      // Assert that _jamground_path is set
      assert(meta.path, `_jamground_path should be set for post ${postId}`);
      pathsSeenPerPost.push(meta.path);

      // The three-way agreement read-posts.mjs enforces, observed here on real rows: the kind
      // the row declares, the kind its path implies, and the post type WordPress filed it as.
      // A page filed as a `post` would be written back through the markdown serialiser.
      assert.equal(meta.kind, seedKindByPath[meta.path],
        `_jamground_kind should match the kind ${meta.path} implies, got ${JSON.stringify(meta.kind)}`);
      assert.equal(meta.type, KINDS[meta.kind].wpPostType,
        `a ${meta.kind} must be filed as WordPress post type ${KINDS[meta.kind].wpPostType}, got ${meta.type}`);

      // Fetch the raw file from GitHub at the path and assert byte-identity
      const fileUrl = `${BLOB_BASE}/${meta.path}`;
      const fileResponse = await fetch(fileUrl);
      assert.equal(fileResponse.status, 200, `should fetch file at ${meta.path} with status 200, got ${fileResponse.status}`);
      const fileBytes = await fileResponse.text();
      assert.equal(fileBytes, meta.src, `bytes at ${meta.path} should be byte-identical to _jamground_source`);

      // Assert that post_name matches the slug the stored bytes declare. Read with the REAL
      // parser for the row's own kind rather than a fence splitter copied into this file —
      // the copy said "frontmatter should have a closing fence", which is true of a post and
      // false of a page, and would fail every page in the repository.
      const { frontmatter } = parseEntity(meta.kind, meta.path, meta.src);
      assert.equal(meta.name, frontmatter.slug, `post_name should equal the slug from _jamground_source, expected: ${frontmatter.slug}, got: ${meta.name}`);

      // Status must ROUND-TRIP, per post, rather than merely being one of the two legal
      // values (asserted above). `draft` maps to `draft` and `published` to `publish`; a
      // mapping that inverted, or that defaulted everything to one value, passes the
      // membership check and fails here.
      const expectedStatus = frontmatter.status === 'draft' ? 'draft' : 'publish';
      assert.equal(meta.status, expectedStatus, `post_status should map from the contract status \`${frontmatter.status}\`, expected: ${expectedStatus}, got: ${meta.status}`);
      if (expectedStatus === 'draft') expectedDraftsByType[meta.type] += 1;
    }

    // Assert that every imported entity recorded its own distinct path — one path per row,
    // no two the same, which is what a path collision during import would break.
    assert.equal(pathsSeenPerPost.length, seedEntities.length, `should have collected ${seedEntities.length} path(s)`);
    assert.equal(new Set(pathsSeenPerPost).size, pathsSeenPerPost.length, `the posts should have distinct paths: ${pathsSeenPerPost.join(', ')}`);

    // The drafts view, counted rather than assumed, ONCE PER POST TYPE. This deliberately does
    // NOT assert that a draft exists: a fork's content repository may hold drafts or none, and
    // an assertion that depends on seed data is testing the seed rather than the importer.
    // What must hold either way is that the number of rows WordPress files as drafts under a
    // type equals the number the content declared for that type — which catches both a draft
    // that failed to import and a published entity wrongly filed as one. Asking only about
    // `post_type=post`, as this did, cannot see a page at all.
    for (const [postType, expectedDrafts] of Object.entries(expectedDraftsByType)) {
      await page.evaluate(async (t) => {
        await window.jamgroundClient.goTo(`/wp-admin/edit.php?post_status=draft&post_type=${t}`);
      }, postType);

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
      assert(listFrame, `the draft list for post_type=${postType} should be reachable`);
      // `:not(.no-items)` because an empty list table still renders one row saying so.
      const rowCount = await listFrame.locator('.wp-list-table tbody tr:not(.no-items)').count();
      assert.equal(rowCount, expectedDrafts, `the drafts view for ${postType} should list exactly the ${expectedDrafts} draft(s) the content declares, got ${rowCount}`);
    }

    // And the positive claim this stage exists for: every entity is listed under its own type,
    // so both seed pages are in wp-admin's Pages list and editable there.
    const expectedRowsByType = {};
    for (const e of seedEntities) {
      const t = KINDS[e.kind].wpPostType;
      expectedRowsByType[t] = (expectedRowsByType[t] || 0) + 1;
    }
    for (const [postType, expectedRows] of Object.entries(expectedRowsByType)) {
      await page.evaluate(async (t) => {
        await window.jamgroundClient.goTo(`/wp-admin/edit.php?post_status=all&post_type=${t}`);
      }, postType);

      let allFrame = null;
      const allDeadline = Date.now() + 60000;
      while (Date.now() < allDeadline) {
        for (const f of page.frames()) {
          try {
            if (await f.locator('.wp-list-table').count()) { allFrame = f; break; }
          } catch {}
        }
        if (allFrame) break;
        await page.waitForTimeout(250);
      }
      assert(allFrame, `the list for post_type=${postType} should be reachable`);
      const allRows = await allFrame.locator('.wp-list-table tbody tr:not(.no-items)').count();
      assert.equal(allRows, expectedRows, `the ${postType} list should hold exactly the ${expectedRows} entit(y/ies) the content declares, got ${allRows}`);
    }
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
