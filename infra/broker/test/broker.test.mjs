/**
 * broker.test — nine assertions covering the broker's whole behavior: exact-origin CORS, PKCE
 * verification, secret containment, response narrowness, `no-store`, and rejection of a wrong
 * verifier, a foreign origin and missing parameters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createBroker } from '../broker.mjs';

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

// Mock GitHub token endpoint: asserts PKCE + secret arrive as GitHub requires.
let seen = null;
const fakeGh = http.createServer(async (req, res) => {
  let s = ''; for await (const c of req) s += c; seen = JSON.parse(s);
  const ok = seen.client_secret === 'SECRET' && seen.code === 'CODE'
    && b64url(crypto.createHash('sha256').update(seen.code_verifier).digest()) === challenge;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { access_token: 'gho_TOKEN', token_type: 'bearer', scope: 'repo' } : { error: 'bad_verifier' }));
});
await new Promise(r => fakeGh.listen(0, r));
const tokenUrl = `http://127.0.0.1:${fakeGh.address().port}/`;

const broker = createBroker({ clientId: 'CID', clientSecret: 'SECRET', allowedOrigin: 'https://edit.example.com', tokenUrl });
await new Promise(r => broker.listen(0, r));
const url = `http://127.0.0.1:${broker.address().port}/token`;

const post = (body, origin = 'https://edit.example.com') => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify(body),
});

test('preflight allows the exact shell origin, never a wildcard', async () => {
  const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://edit.example.com' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://edit.example.com');
  assert.notEqual(pre.headers.get('access-control-allow-origin'), '*');
});

test('valid PKCE exchange returns a token, and the secret never leaves the broker', async () => {
  const good = await post({ code: 'CODE', code_verifier: verifier });
  const gj = await good.json();
  assert.equal(gj.access_token, 'gho_TOKEN');
  assert.equal(seen.client_secret, 'SECRET');
  assert.equal(JSON.stringify(gj).includes('SECRET'), false);
});

test('response carries only token/type/scope, with no-store', async () => {
  const good = await post({ code: 'CODE', code_verifier: verifier });
  const gj = await good.json();
  assert.equal(Object.keys(gj).sort().join(','), 'access_token,scope,token_type');
  assert.equal(good.headers.get('cache-control'), 'no-store');
});

test('a wrong verifier is rejected', async () => {
  const bad = await post({ code: 'CODE', code_verifier: b64url(crypto.randomBytes(32)) });
  assert.equal(bad.status, 400);
});

test('a foreign origin is refused', async () => {
  const other = await post({ code: 'CODE', code_verifier: verifier }, 'https://evil.example.com');
  assert.equal(other.status, 403);
});

test('missing parameters are rejected', async () => {
  const empty = await post({});
  assert.equal(empty.status, 400);
});

test('teardown', () => {
  broker.close();
  fakeGh.close();
});
