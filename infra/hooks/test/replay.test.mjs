/**
 * replay.test — not run by this task's `verify:`, but `lib/replay.mjs` is a filesystem primitive
 * and deserves the same direct coverage `tools/*.mjs` gets under `test/tools/`. Run directly:
 * `node --test infra/hooks/test/replay.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim } from '../lib/replay.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'jamground-replay-'));
}

test('the first claim of an id succeeds and leaves a marker', () => {
  const dir = tmpDir();
  try {
    assert.equal(claim(dir, 'aaaaaaaa-1111-2222-3333-444444444444'), true);
    assert.deepEqual(readdirSync(dir), ['aaaaaaaa-1111-2222-3333-444444444444']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same id claimed again fails — a redelivery is detected', () => {
  const dir = tmpDir();
  try {
    assert.equal(claim(dir, 'bbbbbbbb-1111-2222-3333-444444444444'), true);
    assert.equal(claim(dir, 'bbbbbbbb-1111-2222-3333-444444444444'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('distinct ids do not collide', () => {
  const dir = tmpDir();
  try {
    assert.equal(claim(dir, 'id-one'), true);
    assert.equal(claim(dir, 'id-two'), true);
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a concurrent race on one id is won exactly once', async () => {
  const dir = tmpDir();
  try {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => claim(dir, 'raced-id'))),
    );
    assert.equal(attempts.filter(Boolean).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an id that is not a bare UUID-shaped token is refused rather than used as a path', () => {
  const dir = tmpDir();
  try {
    for (const bad of ['../escape', 'a/b', '', null, undefined, 'has space']) {
      assert.throws(() => claim(dir, bad));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
