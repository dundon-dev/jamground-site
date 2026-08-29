/* Sign-in. The shell holds the token, not Playground; one stateless broker does the
   code-for-token exchange, with PKCE S256 required.

   This module never persists a token. It is held in a closure variable — memory
   only, gone on reload — never browser storage, never a cookie.
   The broker is stateless and sees only `{ code, code_verifier }`; it never sees
   content or a repository name. */

import { OAUTH_CLIENT_ID, REDIRECT_URI as EDITOR_REDIRECT_URI } from '../config.mjs';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

// Public by design — it belongs in the shell's source, in git,
// under review, and esbuild carries it into editor/dist/shell.js unchanged. Re-exported
// from ../config.mjs rather than written here: the fork declares it once, in
// jamground.config.mjs, and every consumer derives.
export const GITHUB_CLIENT_ID = OAUTH_CLIENT_ID;

// The registered callback — the shell's own origin, which is what
// makes exact-origin CORS assertable and is also the
// page that recognises a popup landing on it as a callback rather than a fresh boot.
// Derived from the fork's domain: `https://edit.<domain>/`.
export const REDIRECT_URI = EDITOR_REDIRECT_URI;

// Held only here. No module-scope export gives a caller a reference to write it
// anywhere durable; `getToken`/`clearToken` are the only doors.
let currentToken = null;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 code_verifier: 43-128 chars from the unreserved set. 32 random bytes,
 *  base64url-encoded, land at 43 — the minimum and the simplest choice. */
export function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** S256 only — GitHub accepts it, and `plain` is deliberately not offered. */
export async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** Anti-forgery `state`, same shape as the verifier — a fresh 32 random bytes,
 *  base64url-encoded — and generated independently of it, so a leaked challenge
 *  reveals nothing about `state` or vice versa. */
export function generateState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** `state` must be present and must match exactly. An absent or empty value is never
 *  treated as a match — that is what lets a refusal happen without ever calling the
 *  broker. */
export function stateMatches(received, expected) {
  return typeof received === 'string' && received.length > 0 && received === expected;
}

/** Builds the GitHub authorize URL. Never touches the network or the broker — that
 *  is the one hop the browser must never make itself. */
export function buildAuthorizeUrl({ clientId, redirectUri, scope, state, codeChallenge }) {
  if (!clientId) throw new Error('buildAuthorizeUrl: clientId is required');
  if (!redirectUri) throw new Error('buildAuthorizeUrl: redirectUri is required');
  if (!codeChallenge) throw new Error('buildAuthorizeUrl: codeChallenge is required');
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope || 'repo');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Begins the flow: a fresh verifier/challenge pair and a fresh `state`, built into
 *  the one authorize URL GitHub accepts. Touches no network and no storage — the
 *  caller (the shell's sign-in control) is what opens the popup; this only builds
 *  what that popup navigates to and what the caller must hold in memory until the
 *  popup answers. */
export async function beginAuthorization({ clientId = GITHUB_CLIENT_ID, redirectUri = REDIRECT_URI, scope } = {}) {
  const verifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const url = buildAuthorizeUrl({ clientId, redirectUri, scope, state, codeChallenge });
  return { url, verifier, state };
}

/** The one call the broker answers. Exchanges an authorization code for a token by
 *  posting `{ code, code_verifier }` — never a client secret, which the browser never
 *  holds — and keeps the result only in memory. `fetchImpl` defaults to the global
 *  `fetch` and is overridable for tests. */
export async function exchangeCodeForToken({ brokerUrl, code, codeVerifier, fetchImpl = fetch }) {
  if (!brokerUrl) throw new Error('exchangeCodeForToken: brokerUrl is required');
  if (!code) throw new Error('exchangeCodeForToken: code is required');
  if (!codeVerifier) throw new Error('exchangeCodeForToken: codeVerifier is required');

  const response = await fetchImpl(brokerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`exchangeCodeForToken: ${data.error || response.status}`);
  }
  currentToken = { access_token: data.access_token, token_type: data.token_type, scope: data.scope };
  return currentToken;
}

/** Returns the in-memory token, or `null` before sign-in / after `clearToken`. */
export function getToken() {
  return currentToken;
}

/** Signs out: drops the only copy. There is nowhere else it was written. */
export function clearToken() {
  currentToken = null;
}
