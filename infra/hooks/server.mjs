#!/usr/bin/env node
/**
 * server — the receiver as application code, deployed to the box with Ansible as courier only.
 *
 * The secret is read from a FILE, never an argument (arguments are visible in `ps`) and never
 * logged ("never log tokens"). Ships live and unused — nothing consumes the
 * queue this writes yet.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHandler } from './lib/receiver.mjs';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const secretFile = env('WEBHOOK_SECRET_FILE');
if (!secretFile) {
  console.error('WEBHOOK_SECRET_FILE is required — the secret is a file path, never an argument');
  process.exit(3);
}

const handler = createHandler({
  secret: readFileSync(secretFile, 'utf8').trim(),
  queueDir: env('WEBHOOK_QUEUE_DIR', '/var/lib/jamground-hooks/queue'),
  markersDir: env('WEBHOOK_MARKERS_DIR', '/var/lib/jamground-hooks/markers'),
  locksDir: env('WEBHOOK_LOCKS_DIR', '/var/lib/jamground-hooks/locks'),
});

const port = Number(env('WEBHOOK_PORT', '9000'));
createServer((req, res) => {
  handler(req, res).catch(() => {
    res.statusCode = 500;
    res.end('internal error');
  });
}).listen(port, () => {
  console.log(`webhook receiver listening on ${port}`);
});
