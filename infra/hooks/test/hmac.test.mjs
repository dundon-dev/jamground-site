/**
 * hmac.test — the file `verify:` runs for this task. It carries two layers on purpose:
 *
 *   - the pure signature check in `lib/hmac.mjs`
 *   - the receiver wired end to end, because the load-bearing property isn't "the signature
 *     check works in isolation", it's "nothing runs before it" — the order in `lib/receiver.mjs`
 *     is the actual deliverable, and the only way to prove a rejection happened BEFORE a body was
 *     read into memory is to send one that would hang forever if the implementation read it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSignature, verifySignature } from '../lib/hmac.mjs';
import { createHandler } from '../lib/receiver.mjs';

const SECRET = 'shared-secret-do-not-log';

// ---------------------------------------------------------------------------------------------
// lib/hmac.mjs in isolation
// ---------------------------------------------------------------------------------------------

test('verifySignature accepts a correctly signed payload', () => {
  const payload = Buffer.from('{"ref":"refs/heads/main"}', 'utf8');
  const header = computeSignature(SECRET, payload);
  assert.equal(verifySignature(SECRET, payload, header), true);
});

test('verifySignature rejects the wrong secret', () => {
  const payload = Buffer.from('{"ref":"refs/heads/main"}', 'utf8');
  const header = computeSignature('a-different-secret', payload);
  assert.equal(verifySignature(SECRET, payload, header), false);
});

test('verifySignature rejects a payload altered after signing', () => {
  const signed = Buffer.from('{"ref":"refs/heads/main"}', 'utf8');
  const header = computeSignature(SECRET, signed);
  const tampered = Buffer.from('{"ref":"refs/heads/mAin"}', 'utf8');
  assert.equal(verifySignature(SECRET, tampered, header), false);
});

test('verifySignature rejects malformed headers without throwing', () => {
  const payload = Buffer.from('x', 'utf8');
  for (const header of [
    undefined,
    null,
    '',
    'not-a-signature',
    'sha1=deadbeef',              // wrong algorithm prefix
    'sha256=',                    // empty digest
    computeSignature(SECRET, payload).slice(0, -2), // truncated digest, same prefix
    computeSignature(SECRET, payload) + 'ff',        // extended digest
  ]) {
    assert.doesNotThrow(() => verifySignature(SECRET, payload, header));
    assert.equal(verifySignature(SECRET, payload, header), false, JSON.stringify(header));
  }
});

test('verifySignature rejects an empty or missing secret rather than treating it as a match', () => {
  const payload = Buffer.from('x', 'utf8');
  const header = computeSignature('', payload);
  assert.equal(verifySignature('', payload, header), false);
  assert.equal(verifySignature(undefined, payload, header), false);
});

// ---------------------------------------------------------------------------------------------
// The receiver, wired end to end over a real socket — so "before parsing" and "before reading
// the body into memory" are properties of actual bytes on the wire, not of a mocked call graph.
// ---------------------------------------------------------------------------------------------

function tmpDirs() {
  const root = mkdtempSync(join(tmpdir(), 'jamground-hooks-'));
  return {
    root,
    queueDir: join(root, 'queue'),
    markersDir: join(root, 'markers'),
    locksDir: join(root, 'locks'),
  };
}

function jobsIn(dir) {
  try { return readdirSync(dir).filter((n) => n.endsWith('.json')); }
  catch { return []; }
}

function markersIn(dir) {
  try { return readdirSync(dir); }
  catch { return []; }
}

async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => { res.statusCode = 500; res.end(String(err)); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A raw socket, not node:http's client — an http client would compute and enforce its own
// Content-Length from the body it's given, which makes it impossible to send a request that
// LIES about its length, and lying about length is exactly the case step 1 of the receiver
// exists to catch.
function rawRequest(port, { headers, body }) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = Buffer.alloc(0);
    const finish = () => {
      socket.destroy();
      const text = response.toString('utf8');
      const statusLine = text.split('\r\n', 1)[0] ?? '';
      const statusCode = Number(statusLine.split(' ')[1]);
      resolve({ statusCode, raw: text });
    };
    socket.on('connect', () => {
      const headerBlock = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n');
      socket.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n${headerBlock}\r\nConnection: close\r\n\r\n`);
      if (body && body.length) socket.write(body);
    });
    socket.on('data', (chunk) => { response = Buffer.concat([response, chunk]); });
    socket.on('end', finish);
    socket.on('error', reject);
    // If the receiver is buggy and blocks waiting for bytes that never arrive, this is what
    // turns that into a failing assertion instead of a hung test process.
    socket.setTimeout(1500, finish);
  });
}

test('a correctly signed request is queued exactly once, with a delivery marker', async () => {
  const dirs = tmpDirs();
  try {
    const handler = createHandler({ secret: SECRET, ...dirs });
    await withServer(handler, async (port) => {
      const payload = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');
      const signature = computeSignature(SECRET, payload);
      const res = await rawRequest(port, {
        headers: {
          'Content-Length': payload.length,
          'X-Hub-Signature-256': signature,
          'X-GitHub-Delivery': 'aaaaaaaa-1111-2222-3333-444444444444',
          'X-GitHub-Event': 'push',
        },
        body: payload,
      });
      assert.equal(res.statusCode, 202);
      const jobs = jobsIn(dirs.queueDir);
      assert.equal(jobs.length, 1);
      const job = JSON.parse(readFileSync(join(dirs.queueDir, jobs[0]), 'utf8'));
      assert.equal(job.deliveryId, 'aaaaaaaa-1111-2222-3333-444444444444');
      assert.equal(job.event, 'push');
      assert.equal(job.payload, payload.toString('utf8'));
      assert.equal(markersIn(dirs.markersDir).length, 1);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a signature that does not verify is rejected before the delivery id is ever trusted', async () => {
  const dirs = tmpDirs();
  try {
    const handler = createHandler({ secret: SECRET, ...dirs });
    await withServer(handler, async (port) => {
      const payload = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');
      const res = await rawRequest(port, {
        headers: {
          'Content-Length': payload.length,
          'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
          'X-GitHub-Delivery': 'bbbbbbbb-1111-2222-3333-444444444444',
          'X-GitHub-Event': 'push',
        },
        body: payload,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(jobsIn(dirs.queueDir).length, 0);
      // No marker for the rejected id — an attacker must not be able to plant a marker that
      // later blocks a legitimately signed delivery of the same id.
      assert.equal(markersIn(dirs.markersDir).length, 0);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a redelivered id (same signature, resent) is a no-op, not a second job', async () => {
  const dirs = tmpDirs();
  try {
    const handler = createHandler({ secret: SECRET, ...dirs });
    await withServer(handler, async (port) => {
      const payload = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');
      const signature = computeSignature(SECRET, payload);
      const send = () => rawRequest(port, {
        headers: {
          'Content-Length': payload.length,
          'X-Hub-Signature-256': signature,
          'X-GitHub-Delivery': 'cccccccc-1111-2222-3333-444444444444',
          'X-GitHub-Event': 'push',
        },
        body: payload,
      });
      const first = await send();
      const second = await send();
      assert.equal(first.statusCode, 202);
      assert.equal(second.statusCode, 200);
      assert.equal(jobsIn(dirs.queueDir).length, 1);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a declared length over the cap is rejected without reading a body that never arrives', async () => {
  const dirs = tmpDirs();
  try {
    const handler = createHandler({ secret: SECRET, maxBodyBytes: 1024, ...dirs });
    await withServer(handler, async (port) => {
      // Content-Length claims 10 MiB; nothing that large is ever written to the socket. A
      // receiver that read-before-checking would hang here until the 1.5s socket timeout and
      // this assertion would see statusCode `NaN`, not 413 — that's what makes this a real test
      // of "reject before reading the body into memory" rather than of the cap arithmetic alone.
      const res = await rawRequest(port, {
        headers: {
          'Content-Length': 10 * 1024 * 1024,
          'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
          'X-GitHub-Delivery': 'dddddddd-1111-2222-3333-444444444444',
        },
        body: Buffer.alloc(0),
      });
      assert.equal(res.statusCode, 413);
      assert.equal(jobsIn(dirs.queueDir).length, 0);
      assert.equal(markersIn(dirs.markersDir).length, 0);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
