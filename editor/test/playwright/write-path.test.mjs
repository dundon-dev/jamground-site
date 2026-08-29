// The write path, end to end, driven only through the shell's own controls.
//
// A shell whose buttons have no handlers would still pass "a save with nothing edited
// issues no GitHub request" — that assertion is trivially true of an inert button. This
// test is built the opposite way: every action below is a real click on the real
// control, never `window.jamgroundShell.*`, never an argument the test hands the method
// itself. The only stubs are things outside our code — GitHub's REST API, its GraphQL
// endpoint, its OAuth authorize screen, and the broker. The one call this project's own
// code makes that this file passes straight through is the unauthenticated `git/trees`
// read `content-source.mjs` uses to import seed content on boot; nothing in the write
// path below is permitted to leak into it, and nothing here permits an edit inside the
// Playground iframe's DOM — the fixture edit below goes through `client.run`, the same
// channel `read-posts.mjs` and `import.mjs` already use, never DOM access, which the
// cross-origin boundary forecloses.
//
// Asserts, in order:
//   1. preview has no control, and the five that remain are labelled editorially
//   2. sign-in (through the popup control, not `signIn()`) leaves a non-empty status
//   3. start a change creates the ref and THEN opens the draft PR, before any editing
//   4. save with nothing edited issues zero GitHub requests and says so
//   5. an edit made through the sandbox database — never separately exported — is
//      committed by save, in one commit, onto the change's own branch
//   6. send for review issues the GraphQL `markPullRequestReadyForReview` mutation
//      (no REST route clears `draft`)
//   7. publish issues the merge, and a 409 renders the waiting-for-approval message,
//      never API wording
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { VOCAB } from '../../lib/vocabulary.mjs';
import { CONTENT_REPO } from '../../config.mjs';
import { listSeedEntities } from './seed-entities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

// The same repository entry.mjs targets for every GitHub call — both now read it from the
// one place the fork declares it, so this stub cannot go on matching a repository the shell
// has stopped asking for. (It matters here: a stub whose route pattern no longer matches
// falls through to this file's own 404 branch, which several assertions accept.)
const REPO = CONTENT_REPO;

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, { cwd: editorDir, stdio: 'pipe' });
}

function startServer() {
  // The OAuth callback lands back on `/` carrying a query string (`?code=…&state=…`),
  // so routing has to look at the pathname alone rather than comparing the whole
  // `req.url` — the same fix signin.test.mjs's server already needed.
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

// Waits for the status line to hold a NEW non-empty message — never an empty one, which
// is the exact confusion (signing in and nothing happening look identical) this task
// exists to remove.
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

// Waits for window.jamgroundLastAction to record a given action type. Needed once below:
// the empty-change refusal shows the identical VOCAB.noContentChange text for both
// sendForReview and publish, so waitForStatusChange's "text changed" test never fires for
// the second of that back-to-back pair even though the click did its work.
async function waitForLastActionType(page, type, { timeout = 20000 } = {}) {
  await page.waitForFunction(
    (t) => window.jamgroundLastAction && window.jamgroundLastAction.type === t,
    type,
    { timeout },
  );
  return page.evaluate(() => window.jamgroundLastAction);
}

test('the write path: start a change, save, send for review, publish — through the real controls only', async () => {
  await buildBundle();

  // Asked of the repository, not written down — see ./seed-entities.mjs.
  const seedEntities = await listSeedEntities();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // --- Stubs: everything outside our own code, nothing inside it. ---

    // GitHub's authorize screen (same shape as signin.test.mjs): captures what the shell
    // sent and answers with a 302 back to the shell's own callback, echoing the real
    // `state` — there is no mismatch scenario to exercise here, that is signin.test.mjs's.
    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const url = new URL(route.request().url());
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = url.searchParams.get('state');
      const location = `${baseUrl}/?code=write-path-fake-code&state=${encodeURIComponent(state)}`;
      await route.fulfill({ status: 302, headers: { location } });
    });

    // The broker (a stateless POST /token), proxied at the shell's own origin.
    const brokerRequests = [];
    await context.route(`${baseUrl}/token`, async (route) => {
      brokerRequests.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'gho_write_path_token', token_type: 'bearer', scope: 'repo' }),
      });
    });

    // GitHub's REST and GraphQL APIs. A minimal in-memory model of refs, so the same
    // sequence git-writer.mjs actually drives — create the branch, then later find it
    // already exists and fall back to PATCH — is reproduced rather than assumed away.
    const apiCalls = [];
    const blobsPosted = [];
    const branches = { main: 'sha-main-0' };
    const commits = {};
    const createdCommits = []; // Track shas of created commits in order
    let prNumber = 0;
    let mergeShouldSucceed = false;
    let lastMergeRequest = null;

    // Helper to check if targetSha is a descendant of ancestorSha through the parent chain.
    // Treats unknown shas as roots (not descendants of anything).
    function isDescendantOf(targetSha, ancestorSha, commitsMap) {
      if (targetSha === ancestorSha) return true;
      if (!commitsMap[targetSha]) return false; // Unknown sha is a root
      const parents = commitsMap[targetSha].parents || [];
      for (const parent of parents) {
        if (isDescendantOf(parent, ancestorSha, commitsMap)) {
          return true;
        }
      }
      return false;
    }

    await context.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const bodyText = req.postData();
      const body = bodyText ? JSON.parse(bodyText) : null;

      // The one call OUR code does not make: content-source.mjs's unauthenticated read
      // of the content tree on boot. Passed straight through to the real network.
      if (method === 'GET' && url.pathname.includes('/git/trees/main')) {
        await route.continue();
        return;
      }

      if (url.pathname === '/graphql') {
        apiCalls.push({ method, path: url.pathname, body });
        // Check if this is a GetPullRequest query (checking changed_files) or a mutation
        if (body.query && body.query.includes('GetPullRequest')) {
          const changedFiles = blobsPosted.length > 0 ? 1 : 0;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                node: {
                  changedFiles,
                },
              },
            }),
          });
        } else {
          // This is the markPullRequestReadyForReview mutation
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
          });
        }
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
        const force = body.force === true; // defaults to false, must be explicitly true to force
        // Check for fast-forward: if force is false (default), the current branch tip must be
        // reachable from the new commit through parents.
        if (!force && currentBranchSha && !isDescendantOf(body.sha, currentBranchSha, commits)) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Update is not a fast forward' }) });
          return;
        }
        branches[branch] = body.sha;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: body.sha } }) });
        return;
      }

      if (method === 'POST' && p === '/pulls') {
        // GitHub returns 422 when head and base refs point to the same commit.
        const headRef = body.head;
        const baseRef = body.base;
        const headSha = branches[headRef];
        const baseSha = branches[baseRef];
        if (headSha === baseSha) {
          await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'No commits between ' + baseRef + ' and ' + headRef }] }) });
          return;
        }
        prNumber += 1;
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ number: prNumber, node_id: `PR_kwABCwritepath${prNumber}`, draft: true }) });
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
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: `tree-result-${apiCalls.length}` }) });
        return;
      }

      if (method === 'POST' && p === '/git/commits') {
        const commitSha = `commit-${apiCalls.length}`;
        // Record the parents from the request body so we can check ancestry later.
        commits[commitSha] = { parents: body.parents || [] };
        createdCommits.push(commitSha);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: commitSha }) });
        return;
      }

      const pullMatch = p.match(/^\/pulls\/(\d+)$/);
      if (method === 'GET' && pullMatch) {
        const changedFiles = blobsPosted.length > 0 ? 1 : 0;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            number: parseInt(pullMatch[1]),
            draft: true,
            changed_files: changedFiles,
          }),
        });
        return;
      }

      const mergeMatch = p.match(/^\/pulls\/(\d+)\/merge$/);
      if (method === 'PUT' && mergeMatch) {
        lastMergeRequest = body;
        if (mergeShouldSucceed) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'final-merge-sha', merged: true }) });
        } else {
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Pull Request is not mergeable' }) });
        }
        return;
      }

      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `unstubbed in test: ${method} ${p}` }) });
    });

    // --- Boot. The write path needs a real, imported database — unlike sign-in, which
    // needs nothing from Playground at all. ---
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
    // One row per entity the repository holds, derived rather than the literal 2 — which was a
    // fact about a seed that no longer exists, and would be wrong again the next time it moves.
    assert(
      importMap && Object.keys(importMap).length === seedEntities.length,
      `import should have produced one row per entity (${seedEntities.length}), got ${importMap && Object.keys(importMap).length}`,
    );

    // 1. preview has no control; the five that remain are labelled editorially.
    const controls = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.jamground-control-button')).map((b) => ({ id: b.id, text: b.textContent.trim() })),
    );
    assert.equal(controls.length, 5, 'exactly five controls once preview is removed');
    assert.ok(!controls.some((c) => c.id === 'jamground-control-preview'), 'no preview control should exist');
    assert.deepEqual(
      controls.map((c) => c.text),
      ['sign in', 'start a change', 'save this change', 'send for review', 'publish'],
    );

    // 2. Sign in through the popup control — never `window.jamgroundShell.signIn()`.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#jamground-control-signIn'),
    ]);
    await popup.waitForEvent('close', { timeout: 10000 });
    await page.waitForFunction(() => window.jamgroundShell.getToken() !== null, { timeout: 10000 });
    assert.equal(brokerRequests.length, 1, 'sign-in should call the broker exactly once');
    let status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.equal(status, VOCAB.signedIn, 'the status line reports success rather than clearing');
    assert.ok(status.length > 0, 'status is non-empty after sign-in');

    // 3. Start a change: the ref, THEN the draft PR — before any editing.
    status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    const beforeStart = status;
    await page.click('#jamground-control-startAChange');
    status = await waitForStatusChange(page, beforeStart);
    assert.equal(status, VOCAB.changeStarted);

    // After starting a change, the startAChange control should be disabled: a change is
    // open and the control must track token && !change.
    const startAChangeDisabled = await page.evaluate(() =>
      document.getElementById('jamground-control-startAChange').disabled,
    );
    assert.equal(startAChangeDisabled, true, 'startAChange control should be disabled after a successful start');

    const startCalls = apiCalls.slice();
    const baselineCommitIdx = startCalls.findIndex((c) => c.method === 'POST' && c.path === '/git/commits');
    const refCreateIdx = startCalls.findIndex((c) => c.method === 'POST' && c.path === '/git/refs');
    const pullsIdx = startCalls.findIndex((c) => c.method === 'POST' && c.path === '/pulls');
    assert.ok(baselineCommitIdx !== -1, 'starting a change should create a baseline commit');
    assert.ok(refCreateIdx !== -1, 'starting a change should create a ref');
    assert.ok(pullsIdx !== -1, 'starting a change should open a draft pull request');
    assert.ok(baselineCommitIdx < refCreateIdx, 'the baseline commit must be created before the ref');
    assert.ok(refCreateIdx < pullsIdx, 'the ref must be created before the draft pull request is opened');
    const afterStartLen = apiCalls.length;

    // 3.5 — Empty change refusal: before any edits, send for review and publish both refuse.
    // At this point, changed_files is 0 because only the baseline commit exists (no blobs posted).
    const beforeSendForReviewOnEmpty = status;
    await page.click('#jamground-control-sendForReview');
    status = await waitForStatusChange(page, beforeSendForReviewOnEmpty);
    assert.equal(status, VOCAB.noContentChange, 'send for review should refuse with the shared editor-facing string, not a literal in publish.mjs');
    const sendForReviewEmptyCallsIdx = apiCalls.length;
    // Verify that only the GET PR query was issued, not the mutation
    const queriesSinceStart = apiCalls.slice(afterStartLen);
    const graphqlQueriesThatAreMutations = queriesSinceStart.filter(
      (c) => c.path === '/graphql' && c.body.query && c.body.query.includes('markPullRequestReadyForReview'),
    );
    assert.equal(graphqlQueriesThatAreMutations.length, 0, 'send for review on empty change should not issue mutation');

    await page.click('#jamground-control-publish');
    // Both refusals show the identical VOCAB.noContentChange text, so "the status text
    // changed" never fires here — wait on the action record instead.
    await waitForLastActionType(page, 'publish');
    status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.equal(status, VOCAB.noContentChange, 'publish should refuse with the shared editor-facing string, not a literal in publish.mjs');
    const publishEmptyCallsIdx = apiCalls.length;
    // Verify that only the GET PR was issued, not a merge
    const callsSinceSendForReview = apiCalls.slice(sendForReviewEmptyCallsIdx);
    const publishEmptyMergeCalls = callsSinceSendForReview.filter(
      (c) => c.method === 'PUT' && /\/pulls\/\d+\/merge$/.test(c.path),
    );
    assert.equal(publishEmptyMergeCalls.length, 0, 'publish on empty change should not issue merge');

    // The empty change stays OPEN: neither refusal clears it, so start-a-change must
    // still be disabled — this is the exact regression that would tell the operator
    // they had published when nothing was merged.
    const startAChangeDisabledAfterEmptyRefusals = await page.evaluate(() =>
      document.getElementById('jamground-control-startAChange').disabled,
    );
    assert.equal(startAChangeDisabledAfterEmptyRefusals, true, 'startAChange control must stay disabled — the empty change is still open');

    const afterEmptyChangeTestLen = apiCalls.length;

    // 4. Save with nothing edited: zero requests, and the editorial reason why. The
    // baseline is the count after the empty-change refusals above (afterStartLen would
    // wrongly count those checks as regressions here).
    const beforeEmptySave = status;
    await page.click('#jamground-control-save');
    status = await waitForStatusChange(page, beforeEmptySave);
    assert.equal(status, VOCAB.nothingToSave);
    assert.equal(apiCalls.length, afterEmptyChangeTestLen, 'a save with nothing edited issues no GitHub request');

    // 5. An edit made through the sandbox database — never separately exported — reaches
    // the committed set. This is the shape wp-admin's own Save/Update takes: a write to
    // the WASM instance's MySQL through the Playground client API, the same channel
    // read-posts.mjs already reads from. It is not DOM access, which the cross-origin
    // boundary forecloses.
    const MARKER = 'JamgroundWritePathEdit';
    const editedContractId = Object.keys(importMap)[0];
    const editedPostId = importMap[editedContractId];
    await page.evaluate(async ({ postId, marker }) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const code = `<?php require '${root}/wp-load.php'; ` +
        `wp_update_post(['ID' => ${postId}, 'post_content' => '<!-- wp:paragraph --><p>${marker}</p><!-- /wp:paragraph -->']);`;
      await c.run({ code });
    }, { postId: editedPostId, marker: MARKER });

    // Extract the change branch name from the start calls (look for the ref creation).
    const refCreateCall = startCalls.find((c) => c.method === 'POST' && c.path === '/git/refs');
    const changeBranch = refCreateCall.body.ref.replace('refs/heads/', '');
    // The branch tip before the first save is the baseline commit created during start-a-change.
    const branchTipBeforeFirstSave = branches[changeBranch];

    const firstSaveCreatedCommitsStart = createdCommits.length;
    const beforeSave = status;
    await page.click('#jamground-control-save');
    status = await waitForStatusChange(page, beforeSave);
    assert.equal(status, VOCAB.saved);

    const lastAction = await page.evaluate(() => window.jamgroundLastAction);
    assert.equal(lastAction.type, 'save');
    assert.ok(lastAction.changed >= 1, 'save should report at least the one changed post');

    const saveCalls = apiCalls.slice(afterStartLen);
    const commitPosts = saveCalls.filter((c) => c.method === 'POST' && c.path === '/git/commits');
    assert.equal(commitPosts.length, 1, 'the changed-file set is committed in exactly one commit');
    const blobsThisSave = blobsPosted.slice(); // only one save with edits has happened so far
    assert.ok(blobsThisSave.some((b) => b.content.includes(MARKER)), 'the edit made in wp-admin reaches the committed blob');
    const afterSaveLen = apiCalls.length;

    // The save commit must be parented on the branch tip at the time of save, not on main's head.
    // Get the first save commit sha — it's the one created during this save.
    const firstSaveCommitSha = createdCommits[firstSaveCreatedCommitsStart];
    const firstSaveCommit = commits[firstSaveCommitSha];
    assert.ok(firstSaveCommit, 'the first save commit should be tracked');
    assert.ok(
      firstSaveCommit.parents && firstSaveCommit.parents.length > 0,
      'the first save commit should have a parent',
    );
    // The parent should be the branch tip at the time of the save, not main.
    assert.ok(
      firstSaveCommit.parents.includes(branchTipBeforeFirstSave),
      'the first save commit should be parented on the branch tip, not main',
    );

    // Make a second edit and save to verify commits accumulate.
    const afterFirstSaveLen = apiCalls.length;
    const secondSaveCreatedCommitsStart = createdCommits.length;
    const MARKER2 = 'JamgroundWritePathEdit2';
    await page.evaluate(async ({ postId, marker }) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const code = `<?php require '${root}/wp-load.php'; ` +
        `wp_update_post(['ID' => ${postId}, 'post_content' => '<!-- wp:paragraph --><p>${marker}</p><!-- /wp:paragraph -->']);`;
      await c.run({ code });
    }, { postId: editedPostId, marker: MARKER2 });

    await page.click('#jamground-control-save');
    // Wait a bit for the save to complete and requests to be made
    await new Promise(resolve => setTimeout(resolve, 500));
    // Poll for commits to be created (with a timeout)
    let attempts = 0;
    while (createdCommits.length === secondSaveCreatedCommitsStart && attempts < 40) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts += 1;
    }
    assert.ok(createdCommits.length > secondSaveCreatedCommitsStart, 'second save should create a commit within timeout');
    status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.equal(status, VOCAB.saved);

    const secondSaveCommitCalls = apiCalls.slice(afterFirstSaveLen).filter((c) => c.method === 'POST' && c.path === '/git/commits');
    assert.equal(secondSaveCommitCalls.length, 1, 'the second save should create exactly one commit');
    const secondSaveCommitSha = createdCommits[secondSaveCreatedCommitsStart];
    const secondSaveCommit = commits[secondSaveCommitSha];
    assert.ok(secondSaveCommit, 'the second save commit should be tracked');
    // The second commit should be parented on the first save commit, accumulating.
    assert.ok(
      secondSaveCommit.parents.includes(firstSaveCommitSha),
      'the second save commit should be parented on the first save commit, accumulating',
    );

    const afterSecondSaveLen = apiCalls.length;

    // 6. Send for review: the GraphQL mutation, because no REST route clears `draft`.
    const beforeReview = status;
    await page.click('#jamground-control-sendForReview');
    status = await waitForStatusChange(page, beforeReview);
    assert.equal(status, VOCAB.sentForReview);

    const reviewCalls = apiCalls.slice(afterSecondSaveLen);
    const graphqlCalls = reviewCalls.filter((c) => c.path === '/graphql');
    // Two: the changed_files check (the emptiness read, always issued first) and,
    // because the change is non-empty by now, the markPullRequestReadyForReview mutation.
    assert.equal(graphqlCalls.length, 2, 'sending for review checks emptiness, then issues the ready-for-review mutation');
    assert.match(graphqlCalls[0].body.query, /GetPullRequest/);
    assert.match(graphqlCalls[1].body.query, /markPullRequestReadyForReview/);
    const afterReviewLen = apiCalls.length;

    // 7. Publish: the merge, and a 409 renders the waiting-for-approval message —
    // never API wording (405/409/"merge").
    const beforePublish = status;
    await page.click('#jamground-control-publish');
    status = await waitForStatusChange(page, beforePublish);
    assert.match(status, /waiting/i);
    assert.match(status, /approve/i);
    assert.ok(!/40\d/.test(status), 'the status line must not carry API wording');

    const publishCalls = apiCalls.slice(afterReviewLen);
    const mergeCalls = publishCalls.filter((c) => c.method === 'PUT' && /\/pulls\/\d+\/merge$/.test(c.path));
    assert.equal(mergeCalls.length, 1, 'publish issues the merge');
    assert.equal(lastMergeRequest.merge_method, 'squash', 'the merge body must carry squash merge method');

    const publishAction = await page.evaluate(() => window.jamgroundLastAction);
    assert.equal(publishAction.type, 'publish');
    assert.equal(publishAction.waiting, true);

    // The 409 does not clear the change, so the startAChange control should still be
    // disabled — a change is still open, so the control must stay disabled.
    const startAChangeStillDisabled = await page.evaluate(() =>
      document.getElementById('jamground-control-startAChange').disabled,
    );
    assert.equal(startAChangeStillDisabled, true, 'startAChange control should stay disabled when publish fails');
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
