/**
 * receiver — the HTTP entry point for one webhook delivery: verify, dedupe, enqueue. Nothing
 * else, and in this order:
 *
 *   1. reject on the DECLARED length, before a single body byte is read
 *   2. read the body, aborting mid-stream if it exceeds the cap regardless of what was declared
 *      (a chunked request with no Content-Length skips step 1 entirely)
 *   3. verify the HMAC over the raw bytes — reject here, before anything downstream ever
 *      interprets the payload as data
 *   4. only THEN check the delivery id against the replay markers — trusting a header before
 *      authentication would let an attacker plant a marker that blocks a legitimate later
 *      delivery of the same id
 *   5. only THEN take the per-key lock and enqueue
 *
 * This receiver never parses the payload. It stores the raw bytes and the headers it was told to
 * keep, verbatim, in the queued job; turning that into a build decision is the consumer's job,
 * which does not exist yet. Ships live and unused: this process runs, answers
 * requests, and queues real jobs from day one, but nothing yet reads the queue it writes.
 */
import { verifySignature } from './hmac.mjs';
import { claim } from './replay.mjs';
import { withLock, enqueue } from './queue.mjs';

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // one webhook payload, generously bounded

function readHeader(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Reads the request body into one Buffer, refusing to buffer past `maxBytes` even if the client
// never sent — or lied about — Content-Length. This is the cap that closes the disk/CPU
// exhaustion path an unauthenticated caller otherwise has against the box that serves production.
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error('body exceeds cap'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

export function createHandler({
  secret,
  queueDir,
  markersDir,
  locksDir,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  keyOf = () => 'default',
  deliveryHeader = 'x-github-delivery',
  signatureHeader = 'x-hub-signature-256',
  eventHeader = 'x-github-event',
}) {
  if (!secret) throw new Error('createHandler requires a secret');

  return async function handleWebhook(req, res) {
    const respond = (code, body) => {
      res.statusCode = code;
      res.end(body ?? '');
    };

    // Step 1 — declared size, zero bytes read yet.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      respond(413, 'payload too large');
      req.destroy();
      return;
    }

    // Step 2 — actual bytes, capped regardless of what was declared.
    let body;
    try {
      body = await readBodyCapped(req, maxBodyBytes);
    } catch (err) {
      respond(err.statusCode ?? 400, 'bad request');
      return;
    }

    // Step 3 — HMAC over the raw bytes. Nothing above this line has looked at content, and
    // nothing below it runs unless this passes.
    const signature = readHeader(req, signatureHeader);
    if (!verifySignature(secret, body, signature)) {
      respond(401, 'signature invalid');
      return;
    }

    // Step 4 — replay, only trusted now that the request is authenticated.
    const deliveryId = readHeader(req, deliveryHeader);
    if (typeof deliveryId !== 'string' || deliveryId === '') {
      respond(400, 'missing delivery id');
      return;
    }
    if (!claim(markersDir, deliveryId)) {
      respond(200, 'already processed');
      return;
    }

    // Step 5 — enqueue, serialised per key.
    const event = readHeader(req, eventHeader) ?? 'unknown';
    const key = keyOf({ event, headers: req.headers, body });
    await withLock(locksDir, key, () => enqueue(queueDir, {
      deliveryId,
      event,
      receivedAt: new Date().toISOString(),
      payload: body.toString('utf8'),
    }));

    respond(202, 'queued');
  };
}
