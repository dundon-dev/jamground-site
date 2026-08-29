// A headline typed in wp-admin reaches the committed file.
//
// This is the exact regression this test guards against: read-posts.mjs's PHP reader once
// selected `post_name` and never `post_title`, then rebuilt each post's frontmatter from its
// own stored `_jamground_source` baseline and discarded even the slug it had just read — so
// the frontmatter handed to getChangedFiles was always the baseline's own, and a headline
// edit compared equal to itself on every save.
//
// Every action below is a real click on the real control, never `window.jamgroundShell.*` and
// never a value the test hands the method itself — the same discipline write-path.test.mjs
// enforces, against the same class of stub: GitHub's REST API and its OAuth authorize screen,
// and the broker. The one call this project's own code makes that passes straight through to
// the real network is content-source.mjs's unauthenticated read of the content tree and blobs
// on boot: the shell commits only what wp-admin has already persisted, and that starts with a
// real import.
//
// The headline itself is persisted through the sandbox database (`client.run`, the same
// channel read-posts.mjs reads from), the way wp-admin's own Save/Update reaches storage —
// never DOM access, which the cross-origin boundary forecloses.
//
// Asserts:
//   1. (negative) with nothing edited, save issues zero GitHub requests and says so
//   2. a title persisted through the sandbox database reaches the committed blob's `title:`
//   3. that same save leaves `slug:` unmoved and adds no `slugHistory`
//   4. that same save advances `updatedAt`
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { VOCAB } from '../../lib/vocabulary.mjs';
import { parseEntity } from '../../lib/entity.mjs';
import { KINDS } from '../../lib/kinds.mjs';
import { CONTENT_REPO } from '../../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

// The same repository entry.mjs targets for every GitHub call, read from the one place the
// fork declares it. A stub keyed on a stale slug would stop matching and fall through to this
// file's 404 branch rather than failing where the mismatch is.
const REPO = CONTENT_REPO;

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, { cwd: editorDir, stdio: 'pipe' });
}

function startServer() {
  // The OAuth callback lands back on `/` carrying a query string (`?code=…&state=…`), so
  // routing has to look at the pathname alone rather than comparing the whole `req.url` — the
  // same fix write-path.test.mjs's server already needed.
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      const relPath = pathname === '/' ? '/index.html' : pathname;
      fs.readFile(path.join(distDir, relPath)).then(
        (content) => {
          const contentType = relPath.endsWith('.js') ? 'application/javascript'
            : relPath.endsWith('.html') ? 'text/html'
              : 'text/plain';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        },
        () => {
          res.writeHead(404);
          res.end('Not found');
        },
      );
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

// Waits for the status line to hold a NEW non-empty message — never an empty one.
async function waitForStatusChange(page, previousText, { timeout = 20000 } = {}) {
  await page.waitForFunction(
    (prev) => {
      const t = document.getElementById('jamground-status').textContent;
      return t.length > 0 && t !== prev;
    },
    previousText,
    { timeout },
  );
  return page.evaluate(() => document.getElementById('jamground-status').textContent);
}

test('a title typed in wp-admin reaches the committed blob, with slug unmoved and updatedAt advanced', async () => {
  await buildBundle();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // --- Stubs: everything outside our own code, nothing inside it. ---

    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const url = new URL(route.request().url());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = url.searchParams.get('state');
      const location = `${baseUrl}/?code=headline-fake-code&state=${encodeURIComponent(state)}`;
      await route.fulfill({ status: 302, headers: { location } });
    });

    const brokerRequests = [];
    await context.route(`${baseUrl}/token`, async (route) => {
      brokerRequests.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'gho_headline_token', token_type: 'bearer', scope: 'repo' }),
      });
    });

    // GitHub's REST API — the same minimal model of refs/commits write-path.test.mjs drives,
    // trimmed to what start-a-change and save need (no merge, no GraphQL: this file never
    // clicks send-for-review or publish).
    const apiCalls = [];
    const blobsPosted = [];
    const treesPosted = [];
    const branches = { main: 'sha-main-0' };
    const commits = {};
    let prNumber = 0;

    function isDescendantOf(targetSha, ancestorSha, commitsMap) {
      if (targetSha === ancestorSha) return true;
      if (!commitsMap[targetSha]) return false;
      const parents = commitsMap[targetSha].parents || [];
      return parents.some((parent) => isDescendantOf(parent, ancestorSha, commitsMap));
    }

    await context.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const bodyText = req.postData();
      const body = bodyText ? JSON.parse(bodyText) : null;

      // The one call OUR code does not make: content-source.mjs's unauthenticated read of
      // the content tree on boot. Passed straight through to the real network.
      if (method === 'GET' && url.pathname.includes('/git/trees/main')) {
        await route.continue();
        return;
      }

      const repoMatch = url.pathname.match(new RegExp(`^/repos/${REPO}(/.*)$`));
      if (!repoMatch) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unstubbed in test' }) });
        return;
      }
      const p = repoMatch[1];
      apiCalls.push({ method, path: p, body });

      const refHeadsMatch = p.match(/^\/git\/ref\/heads\/(.+)$/);
      if (method === 'GET' && refHeadsMatch) {
        const branch = refHeadsMatch[1];
        if (branches[branch]) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: branches[branch] } }) });
        } else {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
        }
        return;
      }

      if (method === 'POST' && p === '/git/refs') {
        const branch = body.ref.replace('refs/heads/', '');
        if (branches[branch]) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Reference already exists' }) });
        } else {
          branches[branch] = body.sha;
          await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ref: body.ref, object: { sha: body.sha } }) });
        }
        return;
      }

      const refsHeadsMatch = p.match(/^\/git\/refs\/heads\/(.+)$/);
      if (method === 'PATCH' && refsHeadsMatch) {
        const branch = refsHeadsMatch[1];
        const currentBranchSha = branches[branch];
        const force = body.force === true;
        if (!force && currentBranchSha && !isDescendantOf(body.sha, currentBranchSha, commits)) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Update is not a fast forward' }) });
          return;
        }
        branches[branch] = body.sha;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: body.sha } }) });
        return;
      }

      if (method === 'POST' && p === '/pulls') {
        const headSha = branches[body.head];
        const baseSha = branches[body.base];
        if (headSha === baseSha) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'No commits between ' + body.base + ' and ' + body.head }] }) });
          return;
        }
        prNumber += 1;
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ number: prNumber, node_id: `PR_kwABCheadline${prNumber}`, draft: true }) });
        return;
      }

      const commitMatch = p.match(/^\/git\/commits\/(.+)$/);
      if (method === 'GET' && commitMatch) {
        const sha = commitMatch[1];
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha, tree: { sha: `tree-${sha}` } }) });
        return;
      }

      if (method === 'POST' && p === '/git/blobs') {
        blobsPosted.push(body);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: `blob-${blobsPosted.length}` }) });
        return;
      }

      if (method === 'POST' && p === '/git/trees') {
        treesPosted.push(body);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: `tree-result-${apiCalls.length}` }) });
        return;
      }

      if (method === 'POST' && p === '/git/commits') {
        const commitSha = `commit-${apiCalls.length}`;
        commits[commitSha] = { parents: body.parents || [] };
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: commitSha }) });
        return;
      }

      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `unstubbed in test: ${method} ${p}` }) });
    });

    // --- Boot. ---
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => window.jamgroundReady === true || typeof window.jamgroundBootError !== 'undefined',
      { timeout: 240000 },
    );
    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `no boot error should occur: ${bootError}`);
    const importError = await page.evaluate(() => window.jamgroundImportError);
    assert(!importError, `import should not throw: ${importError}`);
    const importMap = await page.evaluate(() => window.jamgroundImportResult);
    assert(importMap && Object.keys(importMap).length >= 1, 'import should have produced at least one post');

    const editedContractId = Object.keys(importMap)[0];
    const editedPostId = importMap[editedContractId];

    // The baseline, read the same way read-posts.mjs reads it, so this test knows what
    // "unmoved" and "advanced" mean without re-deriving the fix under test.
    // `_jamground_path` comes along for the ride: import wrote it before any click in this
    // test, so it is an independent record of WHERE this post was read from, and the save's
    // tree entry is checked against it below.
    const baselineMeta = await page.evaluate(async ({ postId }) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const code = `<?php require '${root}/wp-load.php'; echo json_encode([`
        + `'src' => get_post_meta(${postId}, '_jamground_source', true),`
        + `'kind' => get_post_meta(${postId}, '_jamground_kind', true),`
        + `'path' => get_post_meta(${postId}, '_jamground_path', true)]);`;
      const result = await c.run({ code });
      return JSON.parse(result.text);
    }, { postId: editedPostId });
    const baselineSource = baselineMeta.src;
    const baselinePath = baselineMeta.path;
    // The row's OWN kind, read from the meta import wrote — not assumed to be `post`. The
    // first entity in the import map is whichever the repository lists first, and since pages
    // are imported that is a page here; `parsePost` would have thrown "Missing frontmatter
    // fence" on a file that has no fence to miss.
    const baselineKind = baselineMeta.kind;
    assert.ok(KINDS[baselineKind], `the edited row must declare a known kind, got ${JSON.stringify(baselineKind)}`);
    const { frontmatter: baseline } = parseEntity(baselineKind, baselinePath, baselineSource);
    assert.ok(baseline.slug, 'the baseline post must carry a slug to compare against');
    assert.ok(baseline.updatedAt, 'the baseline post must carry updatedAt to compare against');
    assert.ok(baselinePath, 'the baseline post must carry the path it was imported from');

    // Sign in through the popup control.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#jamground-control-signIn'),
    ]);
    await popup.waitForEvent('close', { timeout: 10000 });
    await page.waitForFunction(() => window.jamgroundShell.getToken() !== null, { timeout: 10000 });
    let status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.equal(status, VOCAB.signedIn);

    // Start a change through its control.
    const beforeStart = status;
    await page.click('#jamground-control-startAChange');
    status = await waitForStatusChange(page, beforeStart);
    // The status line no longer says only `changeStarted`: opening a change also hands over the
    // staging address, so this reads `<changeStarted> — <stagingPreparing>` with the URL appended
    // as a link, and textContent concatenates the link's text. Asserting the prefix plus the
    // address is stronger than the old equality — it checks the address is actually offered.
    assert.ok(status.startsWith(VOCAB.changeStarted), `status should open with the change-started wording, got: ${status}`);
    assert.ok(status.includes(VOCAB.stagingPreparing), 'the staging site should be offered when the change opens');
    assert.match(status, /https:\/\/pr-\d+\.preview\./, 'the staging address itself must be on screen, not merely promised');
    const afterStartLen = apiCalls.length;

    // 1. (negative) Nothing edited yet: save issues zero requests and says so — the
    // truthful half of the defect this task fixes, proved before the positive half so the
    // fix cannot be read as "everything now looks changed".
    const beforeEmptySave = status;
    await page.click('#jamground-control-save');
    status = await waitForStatusChange(page, beforeEmptySave);
    assert.equal(status, VOCAB.nothingToSave);
    assert.equal(apiCalls.length, afterStartLen, 'a save with nothing edited issues no GitHub request');

    // 2. Persist a NEW TITLE through the sandbox database — the way wp-admin's own
    // Save/Update reaches storage — never a separate export call.
    const NEW_TITLE = 'A New Headline Typed In Wp Admin';
    await page.evaluate(async ({ postId, title }) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const code = `<?php require '${root}/wp-load.php'; ` +
        `wp_update_post(['ID' => ${postId}, 'post_title' => '${title}']);`;
      await c.run({ code });
    }, { postId: editedPostId, title: NEW_TITLE });

    // 3. Press the REAL save control — never window.jamgroundShell, never a test helper.
    const beforeSave = status;
    const blobsBeforeThisSave = blobsPosted.length;
    await page.click('#jamground-control-save');
    status = await waitForStatusChange(page, beforeSave);
    assert.equal(status, VOCAB.saved);

    const newBlobs = blobsPosted.slice(blobsBeforeThisSave);
    assert.equal(newBlobs.length, 1, 'the headline edit alone commits exactly one blob');
    const [blob] = newBlobs;
    const { frontmatter: written } = parseEntity(baselineKind, baselinePath, blob.content);

    // The tree entry path must be exact. It used to be spelled out here, which was only
    // ever right while one particular file existed in one particular content repository —
    // a fork's repository holds something else entirely, and the seed post this named has
    // since been replaced. `_jamground_path`, read from the sandbox database above before
    // any of this test's clicks, is the same claim made against an independent witness: the
    // path import recorded, not one derived from the save under test. It still catches the
    // defect this guards against — a save that invents a path, or writes to another entity's
    // path, moves this value away from the one the post was read from.
    const newTrees = treesPosted.slice(Math.max(0, treesPosted.length - 1));
    assert.equal(newTrees.length, 1, 'the headline edit should write exactly one tree');
    const [tree] = newTrees;
    assert(tree.tree && Array.isArray(tree.tree), 'tree should have a tree array');
    assert.equal(tree.tree.length, 1, 'the tree should carry exactly one entry');
    const [treeEntry] = tree.tree;
    assert.equal(treeEntry.path, baselinePath, 'the tree entry path must be the path the post was read from');
    // The shape of that path is the KIND'S, from the table: `content/<dir>/<locale>/<name><ext>`.
    // Spelled out as a posts-only regex it was a fact about one kind, and would refuse the
    // page this test now edits.
    const { dir, ext } = KINDS[baselineKind];
    assert.match(
      baselinePath,
      new RegExp(`^content/${dir}/[a-z]{2}-[A-Z]{2}/[^/]+\\${ext}$`),
      `and that path must be a locale ${baselineKind} file`,
    );

    // The typed headline reaches the committed blob.
    assert.equal(written.title, NEW_TITLE);
    // The slug is unmoved, and no slugHistory appears — a title edit must not move the route.
    assert.equal(written.slug, baseline.slug);
    assert.equal(written.slugHistory, undefined);
    assert.ok(!/^slugHistory:/m.test(blob.content), 'no slugHistory key should be emitted');
    // updatedAt has advanced.
    assert.notEqual(written.updatedAt, baseline.updatedAt);
    assert.ok(
      new Date(written.updatedAt).getTime() > new Date(baseline.updatedAt).getTime(),
      'updatedAt should move forward, not merely differ',
    );
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
