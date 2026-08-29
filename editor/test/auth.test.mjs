import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getToken,
  clearToken,
} from '../lib/auth.mjs';

test('code verifier is RFC 7636 shape: 43 chars, unreserved set only', () => {
  const verifier = generateCodeVerifier();
  assert.equal(verifier.length, 43);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
});

test('two verifiers are not the same', () => {
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());
});

test('code challenge is the base64url SHA-256 of the verifier (S256)', async () => {
  // RFC 7636 appendix B worked example.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await generateCodeChallenge(verifier);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('authorize URL carries S256, the challenge, and no client secret anywhere', () => {
  const url = buildAuthorizeUrl({
    clientId: 'abc123',
    redirectUri: 'https://edit.example.com/callback',
    codeChallenge: 'challenge-value',
    state: 'xyz',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'abc123');
  assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), 'xyz');
  assert.doesNotMatch(url, /client_secret/);
});

test('buildAuthorizeUrl refuses to build without the required parameters', () => {
  assert.throws(() => buildAuthorizeUrl({ redirectUri: 'x', codeChallenge: 'y' }));
  assert.throws(() => buildAuthorizeUrl({ clientId: 'x', codeChallenge: 'y' }));
  assert.throws(() => buildAuthorizeUrl({ clientId: 'x', redirectUri: 'y' }));
});

test('exchangeCodeForToken posts code and verifier, never a secret, and stores the token only in memory', async () => {
  let seenBody = null;
  let seenUrl = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ access_token: 'gho_test', token_type: 'bearer', scope: 'repo' }),
    };
  };

  const token = await exchangeCodeForToken({
    brokerUrl: 'https://broker.example.com/token',
    code: 'auth-code',
    codeVerifier: 'verifier-value',
    fetchImpl,
  });

  assert.equal(seenUrl, 'https://broker.example.com/token');
  assert.deepEqual(seenBody, { code: 'auth-code', code_verifier: 'verifier-value' });
  assert.ok(!('client_secret' in seenBody));
  assert.deepEqual(token, { access_token: 'gho_test', token_type: 'bearer', scope: 'repo' });
  assert.deepEqual(getToken(), { access_token: 'gho_test', token_type: 'bearer', scope: 'repo' });

  clearToken();
  assert.equal(getToken(), null);
});

test('exchangeCodeForToken throws and stores nothing when the broker refuses', async () => {
  clearToken();
  const fetchImpl = async () => ({
    ok: false,
    json: async () => ({ error: 'bad_verifier' }),
  });

  await assert.rejects(
    exchangeCodeForToken({
      brokerUrl: 'https://broker.example.com/token',
      code: 'auth-code',
      codeVerifier: 'wrong',
      fetchImpl,
    }),
    /bad_verifier/,
  );
  assert.equal(getToken(), null);
});

test('getToken is null before any sign-in', () => {
  clearToken();
  assert.equal(getToken(), null);
});

test('the module never reaches for localStorage, sessionStorage or document.cookie', async () => {
  const source = await (await import('node:fs')).promises.readFile(
    new URL('../lib/auth.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /sessionStorage/);
  assert.doesNotMatch(source, /document\.cookie/);
});
