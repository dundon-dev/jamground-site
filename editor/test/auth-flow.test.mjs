// Begin the OAuth flow — the first half of PKCE: the module constants that reach
// editor/dist/shell.js, the anti-forgery `state`, and the function that ties a
// verifier/challenge/state and the two settled constants into the one authorize URL GitHub
// accepts.
//
// What crosses GitHub's own authorize screen — the popup, the postMessage handoff,
// the callback recognising itself — is a browser behaviour and belongs to
// editor/test/playwright/signin.test.mjs, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_CLIENT_ID,
  REDIRECT_URI,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  stateMatches,
  buildAuthorizeUrl,
  beginAuthorization,
} from '../lib/auth.mjs';
import { EDITOR_ORIGIN, OAUTH_CLIENT_ID, REDIRECT_URI as CONFIGURED_REDIRECT_URI } from '../config.mjs';

/* The shape of a GitHub OAuth App Client ID, MEASURED off the one this project registered
 * rather than guessed at: `Ov23li`, then fourteen more alphanumerics, twenty characters in
 * total. It is asserted alongside the derivation on purpose. The derivation alone is a
 * tautology — of course auth.mjs re-exports what config.mjs handed it — and would stay green
 * if a fork put its repository name, an empty string or a whole URL in the field. The shape
 * is what makes the pair a test: together they say the shell sends the fork's own id AND
 * that the fork put something that could actually be an id there. */
const CLIENT_ID_SHAPE = /^Ov23li[A-Za-z0-9]{14}$/;

test('the public Client ID is the fork\'s own, and is shaped like a real one', () => {
  assert.equal(GITHUB_CLIENT_ID, OAUTH_CLIENT_ID);
  assert.equal(GITHUB_CLIENT_ID.length, 20);
  assert.match(GITHUB_CLIENT_ID, CLIENT_ID_SHAPE);
});

test('the redirect_uri is the shell\'s own origin, and nothing but its own origin', () => {
  // Derivation: the value auth.mjs exports is the one the fork declared.
  assert.equal(REDIRECT_URI, CONFIGURED_REDIRECT_URI);

  // Shape: HTTPS, the root path, no query and no fragment — and equal to its own origin
  // with that root path, which is the property that actually matters. GitHub matches the
  // registered callback exactly, and the broker's exact-origin CORS assertion is only
  // meaningful if the callback and the origin the broker echoes are the same thing. A
  // redirect carrying a path, a query, or a different host would pass a bare string
  // comparison against config and still break both.
  const parsed = new URL(REDIRECT_URI);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.pathname, '/');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
  assert.equal(parsed.origin, EDITOR_ORIGIN);
  assert.equal(REDIRECT_URI, `${parsed.origin}/`);
});

test('generateState is RFC-7636-shaped like the verifier: 43 chars, unreserved set only', () => {
  const state = generateState();
  assert.equal(state.length, 43);
  assert.match(state, /^[A-Za-z0-9\-._~]+$/);
});

test('two states are not the same, and a state is not a verifier', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.notEqual(a, generateCodeVerifier());
});

test('stateMatches requires an exact, non-empty match', () => {
  assert.equal(stateMatches('abc', 'abc'), true);
  assert.equal(stateMatches('abc', 'xyz'), false);
  assert.equal(stateMatches('', 'abc'), false);
  assert.equal(stateMatches(undefined, 'abc'), false);
  assert.equal(stateMatches(null, 'abc'), false);
  assert.equal(stateMatches('abc', ''), false);
});

test('beginAuthorization ties a fresh verifier, challenge and state into one authorize URL', async () => {
  const { url, verifier, state } = await beginAuthorization();

  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(state.length, 43);

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), GITHUB_CLIENT_ID);
  assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), state);

  // The challenge in the URL is the S256 of the verifier beginAuthorization held —
  // not merely challenge-shaped, but the actual challenge for that actual verifier.
  const expectedChallenge = await generateCodeChallenge(verifier);
  assert.equal(parsed.searchParams.get('code_challenge'), expectedChallenge);

  assert.doesNotMatch(url, /client_secret/);
});

test('beginAuthorization never repeats a verifier or a state across calls', async () => {
  const first = await beginAuthorization();
  const second = await beginAuthorization();
  assert.notEqual(first.verifier, second.verifier);
  assert.notEqual(first.state, second.state);
});

test('beginAuthorization honours an overridden clientId/redirectUri without touching the constants', async () => {
  const { url } = await beginAuthorization({ clientId: 'other-id', redirectUri: 'https://other.example.com/' });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('client_id'), 'other-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://other.example.com/');
  // The constants are untouched by the override — still the fork's own declared values.
  assert.equal(GITHUB_CLIENT_ID, OAUTH_CLIENT_ID);
  assert.equal(REDIRECT_URI, CONFIGURED_REDIRECT_URI);
});

test('buildAuthorizeUrl still refuses to build without the required parameters (R1b-16 unchanged)', () => {
  assert.throws(() => buildAuthorizeUrl({ redirectUri: 'x', codeChallenge: 'y' }));
});
