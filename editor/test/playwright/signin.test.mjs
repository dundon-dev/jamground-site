// Begin the OAuth flow — driven only through the shell's own sign-in
// control, never a test helper. GitHub's own consent screen is the one hop no exit
// code can drive; everything on our side of it is asserted here:
//
//   1. a sign-in control exists, is labelled from vocabulary.mjs, and is the only
//      control operable before sign-in
//   2. a blocked popup gets a plain-language message, not silence
//   3. driving the control produces a request to GitHub's authorize endpoint
//      carrying client_id, redirect_uri, code_challenge_method=S256, a code_challenge
//      that is the S256 of the verifier the shell held, and a state
//   4. a return whose state does not match is refused WITHOUT the broker being called
//   5. a matching return against a stubbed broker yields a token and unlocks the
//      five controls
//   6. neither storage holds an access token afterwards
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { generateCodeChallenge } from '../../lib/auth.mjs';
import { EDITOR_ORIGIN, OAUTH_CLIENT_ID, REDIRECT_URI } from '../../config.mjs';

// Measured off a real GitHub OAuth App client id: `Ov23li` then fourteen more
// alphanumerics, twenty characters. Asserted next to the derivation because the
// derivation on its own could not tell an id from an empty string.
const CLIENT_ID_SHAPE = /^Ov23li[A-Za-z0-9]{14}$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, {
    cwd: editorDir,
    stdio: 'pipe',
  });
}

// Unlike the other Playwright fixtures in this directory, the callback lands back
// on `/` carrying a query string, so routing has to look at the pathname alone
// rather than comparing the whole `req.url`.
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

// `preview` has no control (see entry.mjs) — previews were dropped for this release,
// leaving four action controls behind sign-in.
const ACTION_CONTROL_IDS = ['startAChange', 'save', 'sendForReview', 'publish'];

async function readControls(page) {
  return page.evaluate((ids) => ids.map((id) => {
    const el = document.getElementById(`jamground-control-${id}`);
    return { id, text: el && el.textContent.trim(), disabled: el ? el.disabled : null };
  }), ['signIn', ...ACTION_CONTROL_IDS]);
}

test('sign-in begins the OAuth flow through the control, verifies state before calling the broker, and leaves no token in storage', async () => {
  await buildBundle();
  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    // Simulates GitHub's authorize endpoint: captures what the shell sent, then
    // answers with a 302 back to the shell's own callback — exactly the shape a
    // real authorize response takes — carrying either the `state` GitHub was
    // actually handed (the honest case) or a forced value (the mismatch case).
    let authorizeUrl = null;
    let forcedState = null;
    await context.route('https://github.com/login/oauth/authorize**', async (route) => {
      const url = new URL(route.request().url());
      authorizeUrl = url;
      // A real round trip to github.com and back has far more latency than this;
      // the delay only guarantees the test has read what the shell is holding
      // in memory before the popup answers and clears it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const echoedState = url.searchParams.get('state');
      const state = forcedState !== null ? forcedState : echoedState;
      const location = `${baseUrl}/?code=fake-code-123&state=${encodeURIComponent(state)}`;
      await route.fulfill({ status: 302, headers: { location } });
    });

    // Simulates the broker (a stateless POST /token), proxied at the
    // shell's own origin in production (infra/ansible/roles/editor_shell).
    const brokerRequests = [];
    await context.route(`${baseUrl}/token`, async (route) => {
      brokerRequests.push(JSON.parse(route.request().postData() || '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'gho_test_token_98765', token_type: 'bearer', scope: 'repo' }),
      });
    });

    await page.goto(baseUrl);
    await page.waitForSelector('#jamground-control-signIn');

    // 1. Present, labelled from vocabulary.mjs, and the only control operable
    //    before sign-in.
    const before = await readControls(page);
    const signInBefore = before.find((c) => c.id === 'signIn');
    assert.equal(signInBefore.text, 'sign in');
    assert.equal(signInBefore.disabled, false, 'sign-in control should be enabled before sign-in');
    for (const id of ACTION_CONTROL_IDS) {
      assert.equal(before.find((c) => c.id === id).disabled, true, `${id} should be disabled before sign-in`);
    }

    // 2. A blocked popup is a real editor-facing failure, not silence.
    await page.evaluate(() => { window.__realOpen = window.open; window.open = () => null; });
    await page.click('#jamground-control-signIn');
    await page.waitForFunction(() => document.getElementById('jamground-status').textContent.length > 0);
    const blockedMessage = await page.evaluate(() => document.getElementById('jamground-status').textContent);
    assert.match(blockedMessage, /pop-?up/i);
    await page.evaluate(() => { window.open = window.__realOpen; delete window.__realOpen; });

    // 3. Driving the control produces a request to GitHub's authorize endpoint
    //    carrying everything the broker's exact-origin check requires, and a `state` that
    //    does not match what comes back is refused WITHOUT the broker being called.
    forcedState = 'a-state-that-was-never-issued-by-this-shell';
    const [popup1] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#jamground-control-signIn'),
    ]);

    const pendingAuth = await page.evaluate(() => window.jamgroundShell.getPendingAuthorization());
    assert.ok(pendingAuth && pendingAuth.verifier && pendingAuth.state, 'the shell should hold a verifier and state while the popup is open');

    await popup1.waitForEvent('close', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('jamground-status').textContent.length > 0);

    assert.ok(authorizeUrl, 'the control should have opened GitHub\'s authorize endpoint');
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://github.com/login/oauth/authorize');
    // The fork's own two values reach GitHub — derived, then shape-checked, so this
    // stays a test rather than becoming a restatement of the config it reads.
    const sentClientId = authorizeUrl.searchParams.get('client_id');
    assert.equal(sentClientId, OAUTH_CLIENT_ID);
    assert.match(sentClientId, CLIENT_ID_SHAPE);
    const sentRedirect = authorizeUrl.searchParams.get('redirect_uri');
    assert.equal(sentRedirect, REDIRECT_URI);
    const parsedRedirect = new URL(sentRedirect);
    assert.equal(parsedRedirect.protocol, 'https:');
    assert.equal(parsedRedirect.pathname, '/');
    assert.equal(parsedRedirect.origin, EDITOR_ORIGIN);
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorizeUrl.searchParams.get('state'), pendingAuth.state);

    const expectedChallenge = await generateCodeChallenge(pendingAuth.verifier);
    assert.equal(authorizeUrl.searchParams.get('code_challenge'), expectedChallenge);

    assert.equal(brokerRequests.length, 0, 'a state mismatch must never reach the broker');
    const afterMismatch = await readControls(page);
    assert.equal(afterMismatch.find((c) => c.id === 'signIn').disabled, false, 'sign-in should still be available after a refused return');
    for (const id of ACTION_CONTROL_IDS) {
      assert.equal(afterMismatch.find((c) => c.id === id).disabled, true, `${id} should stay disabled after a refused return`);
    }
    assert.equal(await page.evaluate(() => window.jamgroundShell.getToken()), null);

    // 4. A matching state against the stubbed broker yields a token and unlocks
    //    the five controls.
    forcedState = null; // echo the real state back, the honest case
    authorizeUrl = null;
    const [popup2] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#jamground-control-signIn'),
    ]);
    await popup2.waitForEvent('close', { timeout: 10000 });
    await page.waitForFunction(() => window.jamgroundShell.getToken() !== null, { timeout: 10000 });

    assert.equal(brokerRequests.length, 1, 'a matching return should call the broker exactly once');
    assert.ok(!('client_secret' in brokerRequests[0]), 'the browser must never hold or send a client secret');

    const afterSignIn = await readControls(page);
    assert.equal(afterSignIn.find((c) => c.id === 'signIn').disabled, true, 'sign-in should be disabled once signed in');
    for (const id of ACTION_CONTROL_IDS) {
      assert.equal(afterSignIn.find((c) => c.id === id).disabled, false, `${id} should be enabled once signed in`);
    }
    const token = await page.evaluate(() => window.jamgroundShell.getToken());
    assert.equal(token.access_token, 'gho_test_token_98765');

    // 5. Neither storage holds an access token afterwards.
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
    for (const [store, items] of Object.entries(storageContents)) {
      for (const [key, value] of Object.entries(items)) {
        assert.ok(!/gho_|access_token/.test(value), `${store}Storage should hold no token: ${key}=${value}`);
      }
    }
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
