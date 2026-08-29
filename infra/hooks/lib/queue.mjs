/**
 * queue — a filesystem queue for verified webhook deliveries, with a per-key advisory lock.
 *
 * Why a lock at all: two deliveries that share a key (a branch, a repository — `keyOf` in
 * `receiver.mjs` decides which) can arrive close enough together that enqueueing them races.
 * The lock only ever serialises the enqueue step; it knows nothing about builds and does not
 * need to, which keeps it cheap. Node has no binding for the kernel's `flock(2)`, so this uses
 * the standard pure-Node substitute: exclusive file creation is atomic on a POSIX filesystem, so
 * "the lock file didn't exist and now it does" IS the lock, with no separate check-then-act step
 * for a second process to land in between.
 *
 * Why enqueue writes to a temp name and renames: `consumer.mjs` reads
 * this directory on a timer and must never see a job file that is half-written. `rename` within one
 * directory is atomic on the same filesystem, so a job either isn't there yet or is there whole.
 */
import {
  mkdirSync, closeSync, openSync, writeSync, renameSync, unlinkSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Lock keys become filenames; the same refusal-not-sanitisation rule as replay.mjs's delivery ids.
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

function lockPath(locksDir, key) {
  if (typeof key !== 'string' || key === '' || !SAFE_KEY.test(key)) {
    throw new Error(`refusing to use lock key as a filename: ${JSON.stringify(key)}`);
  }
  return join(locksDir, `${key}.lock`);
}

// Blocks the caller (via a bounded busy-wait, not a real futex — there is nothing cheaper
// without a native binding) until the lock is free or `timeoutMs` elapses, runs `fn`, and always
// releases — even if `fn` throws — so one failed enqueue can never wedge a key forever.
export async function withLock(locksDir, key, fn, { timeoutMs = 5000, pollMs = 20 } = {}) {
  mkdirSync(locksDir, { recursive: true });
  const path = lockPath(locksDir, key);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${key}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    closeSync(fd);
    try {
      return await fn();
    } finally {
      try { unlinkSync(path); } catch { /* already gone; nothing left to clean up */ }
    }
  }
}

// Writes `job` (anything JSON-serialisable) into `queueDir` under a unique name — complete or
// not present at all, never partial. Returns the final filename.
export function enqueue(queueDir, job) {
  mkdirSync(queueDir, { recursive: true });
  const name = `${Date.now()}-${randomUUID()}.json`;
  const tmp = join(queueDir, `.${name}.tmp`);
  const dest = join(queueDir, name);
  const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
  try {
    writeSync(fd, JSON.stringify(job));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  return name;
}
