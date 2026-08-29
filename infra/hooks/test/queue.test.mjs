/**
 * queue.test — not run by this task's `verify:`, but `lib/queue.mjs` is a filesystem primitive
 * and deserves the same direct coverage `tools/*.mjs` gets under `test/tools/`. Run directly:
 * `node --test infra/hooks/test/queue.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, withLock } from '../lib/queue.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'jamground-queue-'));
}

test('enqueue writes exactly one complete job file, no temp file left behind', () => {
  const dir = tmpDir();
  try {
    const name = enqueue(dir, { hello: 'world' });
    const entries = readdirSync(dir);
    assert.deepEqual(entries, [name]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, name), 'utf8')), { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two enqueues never collide on a name', () => {
  const dir = tmpDir();
  try {
    const a = enqueue(dir, { n: 1 });
    const b = enqueue(dir, { n: 2 });
    assert.notEqual(a, b);
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock serialises two holders of the same key', async () => {
  const dir = tmpDir();
  try {
    const order = [];
    const slow = withLock(dir, 'branch-main', async () => {
      order.push('slow-start');
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('slow-end');
    });
    // Give the first call a head start so it reliably wins the race for the lock file.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fast = withLock(dir, 'branch-main', async () => {
      order.push('fast-ran');
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['slow-start', 'slow-end', 'fast-ran']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock releases even when the wrapped function throws', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(withLock(dir, 'branch-x', async () => { throw new Error('boom'); }));
    // The lock must not be wedged — a second acquisition on the same key succeeds promptly.
    let ran = false;
    await withLock(dir, 'branch-x', async () => { ran = true; }, { timeoutMs: 200 });
    assert.equal(ran, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLock times out rather than waiting forever on a held lock', async () => {
  const dir = tmpDir();
  try {
    const holder = withLock(dir, 'branch-y', () => new Promise((resolve) => setTimeout(resolve, 300)));
    await assert.rejects(
      withLock(dir, 'branch-y', () => {}, { timeoutMs: 50, pollMs: 10 }),
      /timed out waiting for lock/,
    );
    await holder;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unsafe key is refused rather than used as a path', async () => {
  const dir = tmpDir();
  try {
    for (const bad of ['../escape', 'a/b', '']) {
      await assert.rejects(withLock(dir, bad, () => {}));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
