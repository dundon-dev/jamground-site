/* The auth broker. The ENTIRE server-side surface of the system.
   Stateless: no database, no session, no cache, no file. Never sees content or the
   repository name, never logs a token, and answers `Cache-Control: no-store`. */
import http from 'node:http';

const ORIGIN = process.env.SHELL_ORIGIN || 'https://edit.example.com';
const TOKEN_URL = process.env.GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token';

export function createBroker({ clientId, clientSecret, allowedOrigin = ORIGIN, tokenUrl = TOKEN_URL }) {
  return http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,     // exact origin, never *
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.method !== 'POST' || !req.url.startsWith('/token'))
      return res.writeHead(404, cors).end();
    if (req.headers.origin !== allowedOrigin)
      return res.writeHead(403, { ...cors, 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: 'origin_not_allowed' }));

    let body = ''; for await (const c of req) { body += c; if (body.length > 4096) return res.writeHead(413, cors).end(); }
    let code, code_verifier;
    try { ({ code, code_verifier } = JSON.parse(body)); } catch { return res.writeHead(400, cors).end(); }
    if (!code || !code_verifier)
      return res.writeHead(400, { ...cors, 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: 'missing_parameters' }));

    const gh = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier }),
    });
    const data = await gh.json();
    // Deliberately narrow: pass the token through, nothing else, and never log it.
    if (!data.access_token)
      return res.writeHead(400, { ...cors, 'Content-Type': 'application/json' })
                .end(JSON.stringify({ error: data.error || 'exchange_failed' }));
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
       .end(JSON.stringify({ access_token: data.access_token, token_type: data.token_type, scope: data.scope }));
  });
}
