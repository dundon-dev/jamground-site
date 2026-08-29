// Wire the shell — sign in, start a change, save with nothing edited
//
// Verifies that:
// 1. The shell boots and presents five controls, labelled editorially
// 2. The token stays in host-page scope closure, never in localStorage/sessionStorage
// 3. A save with nothing edited issues no GitHub request — driven through the real
//    sign-in and start-a-change controls first, never `window.jamgroundShell.*` and
//    never an argument the test hands the method itself. Calling `save()` on a shell
//    that has never signed in or started a change would throw before ever reaching
//    the comparison — that would make "no request" trivially true of a broken control,
//    rather than a real assertion about the save path (write-path.test.mjs
//    carries the richer flow: an edit reaching a real commit, review, and publish).
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

// The OAuth callback lands back on `/` carrying a query string (`?code=…&state=…`), so
// routing has to look at the pathname alone rather than comparing the whole `req.url`.
function startServer() {
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

test('shell: five controls, a closure-only token, and a no-op save', async () => {
  await buildBundle();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // GitHub's authorize screen: same shape as signin.test.mjs, echoing the real state.
    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const url = new URL(route.request().url());
      const state = url.searchParams.get('state');
      const location = `${baseUrl}/?code=save-test-fake-code&state=${encodeURIComponent(state)}`;
      await route.fulfill({ status: 302, headers: { location } });
    });

    // The broker (a stateless POST /token), proxied at the shell's own origin.
    let brokerCalls = 0;
    await context.route(`${baseUrl}/token`, async (route) => {
      brokerCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'gho_save_test_token', token_type: 'bearer', scope: 'repo' }),
      });
    });

    // GitHub's REST API — only what starting a change needs. Save-with-nothing-edited
    // must never reach any of this, which the assertion below checks directly.
    const apiCalls = [];
    const branches = { main: 'sha-main-0' };
    const commits = {};
    const createdCommits = []; // Track shas of created commits in order
    let prNumber = 0;

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

      // content-source.mjs's own unauthenticated read on boot — real network, untouched.
      if (method === 'GET' && url.pathname.includes('/git/trees/main')) {
        await route.continue();
        return;
      }

      const bodyText = req.postData();
      const body = bodyText ? JSON.parse(bodyText) : null;
      apiCalls.push({ method, path: url.pathname, body });

      const refHeadsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/);
      if (method === 'GET' && refHeadsMatch) {
        const branch = refHeadsMatch[1];
        if (branches[branch]) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: branches[branch] } }) });
        } else {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) });
        }
        return;
      }

      if (method === 'POST' && /\/git\/refs$/.test(url.pathname)) {
        const branch = body.ref.replace('refs/heads/', '');
        branches[branch] = body.sha;
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ref: body.ref, object: { sha: body.sha } }) });
        return;
      }

      const refsHeadsMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/);
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

      if (method === 'POST' && /\/pulls$/.test(url.pathname)) {
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
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ number: prNumber, node_id: `PR_kwABCsave${prNumber}`, draft: true }) });
        return;
      }

      const commitMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/);
      if (method === 'GET' && commitMatch) {
        const sha = commitMatch[1];
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha, tree: { sha: `tree-${sha}` } }) });
        return;
      }

      if (method === 'POST' && /\/git\/commits$/.test(url.pathname)) {
        const commitSha = `commit-${apiCalls.length}`;
        // Record the parents from the request body so we can check ancestry later.
        commits[commitSha] = { parents: body.parents || [] };
        createdCommits.push(commitSha);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sha: commitSha }) });
        return;
      }

      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `unstubbed in test: ${method} ${url.pathname}` }) });
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => {
      const ready = typeof window.jamgroundReady !== 'undefined';
      const err = typeof window.jamgroundBootError !== 'undefined';
      return ready || err;
    }, { timeout: 240000 });

    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    // 1. Five controls, labelled editorially — sign in plus the four actions, preview gone.
    const controls = await page.evaluate(() => {
      const buttons = document.querySelectorAll('.jamground-control-button');
      return Array.from(buttons).map((b) => ({ id: b.id, text: b.textContent.trim() }));
    });

    assert.equal(controls.length, 5, 'should have exactly 5 controls');

    const expectedLabels = ['sign in', 'start a change', 'save this change', 'send for review', 'publish'];
    controls.forEach((control, i) => {
      assert.equal(control.text, expectedLabels[i], `control ${i} should have label "${expectedLabels[i]}"`);
    });

    // Verify no git vocabulary in control labels
    const gitTerms = ['branch', 'commit', 'merge', 'rebase', 'pull request'];
    controls.forEach((control) => {
      gitTerms.forEach((term) => {
        assert(!control.text.toLowerCase().includes(term), `control label should not contain git term "${term}"`);
      });
    });

    // 2. Sign in through the popup control — never `window.jamgroundShell.signIn()`.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#jamground-control-signIn'),
    ]);
    await popup.waitForEvent('close', { timeout: 10000 });
    await page.waitForFunction(() => window.jamgroundShell.getToken() !== null, { timeout: 10000 });
    assert.equal(brokerCalls, 1, 'sign-in should call the broker exactly once');

    // Token handling: closure only, never storage. `getToken()` inspects what the real
    // control already set; it does not drive the sign-in itself.
    const storageContents = await page.evaluate(() => {
      const dump = (store) => {
        const items = {};
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          items[key] = store.getItem(key);
        }
        return items;
      };
      return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
    });
    for (const [storeName, items] of Object.entries(storageContents)) {
      for (const [key, value] of Object.entries(items)) {
        assert(!value.includes('gho_'), `${storeName}Storage should not contain a token: ${key}=${value}`);
        assert(!/access_token/i.test(value), `${storeName}Storage should not contain a token-like value: ${key}=${value}`);
      }
    }

    const hasToken = await page.evaluate(() => {
      const t = window.jamgroundShell.getToken();
      return t !== null && t.access_token === 'gho_save_test_token';
    });
    assert(hasToken, 'token should be held in shell closure, not in storage');

    // 3. Start a change through the real control, then save with nothing edited.
    await page.click('#jamground-control-startAChange');
    await page.waitForFunction(() => window.jamgroundLastAction?.type === 'startAChange', { timeout: 15000 });

    const apiCallsBeforeSave = apiCalls.length;
    assert.ok(apiCallsBeforeSave > 0, 'starting a change should have issued GitHub requests');

    await page.click('#jamground-control-save');
    await page.waitForFunction(
      () => window.jamgroundLastAction?.type === 'save',
      { timeout: 15000 },
    );

    assert.equal(apiCalls.length, apiCallsBeforeSave, 'save with nothing edited should not issue a GitHub request');

    const lastAction = await page.evaluate(() => window.jamgroundLastAction);
    assert.equal(lastAction.type, 'save', 'save action should be tracked');
    assert.equal(lastAction.changed, 0, 'nothing should have been reported as changed');

    const status = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.ok(status.length > 0, 'the status line reports the outcome rather than clearing');
    assert.match(status, /nothing new to save/);
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
