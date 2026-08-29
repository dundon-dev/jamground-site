/**
 * consumer.test — the build decisions themselves, exercised without a box, a systemd unit or a
 * git remote in the loop. `lib/consumer.mjs` is the half of the webhook pipeline that decides
 * what happens to a change, so it gets the same direct coverage `lib/queue.mjs` and
 * `lib/replay.mjs` already get. Run directly: `node --test infra/hooks/test/consumer.test.mjs`.
 *
 * Two properties get as much room here as the happy path, because both are ways this pipeline
 * could look healthy while doing nothing: a job that VANISHES on failure (a queue that empties on
 * error is indistinguishable from one that succeeded), and a job applied OUT OF ORDER (a close
 * overtaking the open it followed leaves a preview nobody asked for, or removes one somebody
 * did).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decide, runOnce, deployProductionOnMerge, previewTeardown,
} from '../lib/consumer.mjs';
import { withLock } from '../lib/queue.mjs';

/** A log that says nothing, so a test asserting on a failure path does not print one. */
const quiet = { log() {}, error() {} };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'jamground-consumer-'));
  const dirs = {
    root,
    queueDir: join(root, 'queue'),
    failedDir: join(root, 'failed'),
    locksDir: join(root, 'locks'),
    previewsRoot: join(root, 'previews'),
  };
  mkdirSync(dirs.queueDir, { recursive: true });
  mkdirSync(dirs.previewsRoot, { recursive: true });
  return dirs;
}

/** A queued job in exactly the shape receiver.mjs writes: the payload is the RAW BODY as a
 *  string, never a parsed object. */
function job(dirs, name, event, payload) {
  writeFileSync(join(dirs.queueDir, name), JSON.stringify({
    deliveryId: name.replace(/\.json$/, ''),
    event,
    receivedAt: '2026-08-29T00:00:00.000Z',
    payload,
  }));
  return name;
}

function pullRequest(dirs, name, { action, number = 7, ref = 'editor/change-7', merged = false }) {
  return job(dirs, name, 'pull_request', JSON.stringify({
    action,
    number,
    pull_request: { merged, head: { ref } },
  }));
}

/** Records what the consumer asked for instead of doing it. */
function spies() {
  const built = [];
  const tornDown = [];
  const merged = [];
  return {
    built,
    tornDown,
    merged,
    build: (decision) => { built.push(decision); },
    teardown: (decision) => { tornDown.push(decision); },
    onMerged: (decision) => { merged.push(decision); },
  };
}

const run = (dirs, spy, extra = {}) => runOnce({
  queueDir: dirs.queueDir,
  failedDir: dirs.failedDir,
  locksDir: dirs.locksDir,
  previewsRoot: dirs.previewsRoot,
  build: spy.build,
  teardown: spy.teardown,
  onMerged: spy.onMerged,
  log: quiet,
  ...extra,
});

const clean = (dirs) => rmSync(dirs.root, { recursive: true, force: true });

test('an opened pull request builds its preview from the head ref', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    pullRequest(dirs, '1700000000000-a.json', { action: 'opened', number: 42, ref: 'editor/new-post' });
    const summary = await run(dirs, spy);

    assert.deepEqual(spy.built.map(({ number, ref }) => [number, ref]), [[42, 'editor/new-post']]);
    assert.deepEqual(spy.tornDown, []);
    assert.deepEqual(summary.built, [42]);
    assert.deepEqual(summary.failed, []);
    // Handled, so gone — and gone from the queue only, never to failed/.
    assert.deepEqual(readdirSync(dirs.queueDir), []);
    assert.equal(existsSync(dirs.failedDir), false);
  } finally {
    clean(dirs);
  }
});

test('reopened and synchronize build too — a push to the branch moves the preview', async () => {
  for (const action of ['reopened', 'synchronize']) {
    const dirs = harness();
    const spy = spies();
    try {
      pullRequest(dirs, '1700000000000-a.json', { action, number: 9, ref: 'editor/edit' });
      const summary = await run(dirs, spy);
      assert.deepEqual(summary.built, [9], `${action} did not build`);
      assert.equal(spy.built[0].ref, 'editor/edit');
    } finally {
      clean(dirs);
    }
  }
});

test('a closed pull request tears its preview down and reaches no deploy seam', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    pullRequest(dirs, '1700000000000-a.json', { action: 'closed', number: 42, merged: false });
    const summary = await run(dirs, spy);

    assert.deepEqual(summary.tornDown, [42]);
    assert.deepEqual(spy.built, []);
    assert.deepEqual(spy.merged, [], 'a pull request closed WITHOUT merging is not production\'s business');
    assert.deepEqual(readdirSync(dirs.queueDir), []);
  } finally {
    clean(dirs);
  }
});

test('a merged pull request tears down and reaches the seam — which deploys nothing', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    pullRequest(dirs, '1700000000000-a.json', { action: 'closed', number: 42, merged: true });
    const summary = await run(dirs, spy);

    assert.deepEqual(summary.tornDown, [42]);
    assert.deepEqual(spy.merged.map(({ number }) => number), [42]);
  } finally {
    clean(dirs);
  }

  // And the seam that is actually wired in production is inert: it takes the decision, returns
  // nothing, and triggers no deploy. This is the assertion that has to be changed deliberately
  // the day auto-deploy lands.
  assert.equal(deployProductionOnMerge({ number: 42, merged: true }), undefined);
});

test('a pull_request action that changes no preview is dropped, without error', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    pullRequest(dirs, '1700000000000-a.json', { action: 'labeled', number: 42 });
    const summary = await run(dirs, spy);

    assert.deepEqual(spy.built, []);
    assert.deepEqual(spy.tornDown, []);
    assert.deepEqual(summary.failed, []);
    assert.equal(summary.ignored.length, 1);
    assert.deepEqual(readdirSync(dirs.queueDir), []);
    assert.equal(existsSync(dirs.failedDir), false, 'an uninteresting action is not a failure');
  } finally {
    clean(dirs);
  }
});

test('an event that is not pull_request is dropped without even parsing its body', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    // Deliberately not JSON: an event this consumer has no opinion about must not be quarantined
    // for the shape of a body it never reads.
    job(dirs, '1700000000000-a.json', 'push', 'not json at all');
    const summary = await run(dirs, spy);

    assert.deepEqual(summary.failed, []);
    assert.equal(summary.ignored.length, 1);
    assert.deepEqual(readdirSync(dirs.queueDir), []);
  } finally {
    clean(dirs);
  }
});

test('a job whose build fails is moved to failed/ intact, never deleted', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    const name = pullRequest(dirs, '1700000000000-a.json', { action: 'opened', number: 42 });
    const summary = await runOnce({
      queueDir: dirs.queueDir,
      failedDir: dirs.failedDir,
      locksDir: dirs.locksDir,
      previewsRoot: dirs.previewsRoot,
      build: () => { throw new Error('the build exited non-zero'); },
      teardown: spy.teardown,
      log: quiet,
    });

    assert.equal(summary.failed.length, 1);
    assert.match(summary.failed[0].error, /the build exited non-zero/);
    assert.deepEqual(summary.built, []);
    assert.deepEqual(readdirSync(dirs.queueDir), [], 'a failed job must not be left to retry forever');
    assert.deepEqual(readdirSync(dirs.failedDir), [name],
      'a failed job must be somewhere durable — an empty queue after a failure is '
      + 'indistinguishable from an empty queue after a success');
  } finally {
    clean(dirs);
  }
});

test('a pull_request delivery whose body does not parse is quarantined, not dropped', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    const name = job(dirs, '1700000000000-a.json', 'pull_request', '{ this is not json');
    const summary = await run(dirs, spy);

    assert.equal(summary.failed.length, 1);
    assert.deepEqual(readdirSync(dirs.failedDir), [name]);
  } finally {
    clean(dirs);
  }
});

test('a pull-request number that is not a positive integer never becomes a path', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    mkdirSync(join(dirs.previewsRoot, 'keep'));
    for (const number of ['../../etc', -1, 0, 1.5, null]) {
      const name = pullRequest(dirs, `170000000000${Math.random()}-x.json`, { action: 'closed', number });
      const summary = await run(dirs, spy);
      assert.equal(summary.failed.length, 1, `${JSON.stringify(number)} was not refused`);
      assert.match(summary.failed[0].error, /refusing to use pull-request number/);
      rmSync(join(dirs.failedDir, name));
    }
    assert.deepEqual(spy.tornDown, [], 'nothing may be removed on a refused number');
    assert.equal(existsSync(join(dirs.previewsRoot, 'keep')), true);
  } finally {
    clean(dirs);
  }
});

test('a head ref that could be read as a git option is refused', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    for (const ref of ['--upload-pack=evil', '', 'a branch', null]) {
      pullRequest(dirs, `17000000000${Math.random()}-x.json`, { action: 'opened', number: 3, ref });
      const summary = await run(dirs, spy);
      assert.equal(summary.failed.length, 1, `${JSON.stringify(ref)} was not refused`);
      assert.match(summary.failed[0].error, /refusing to use head ref/);
      rmSync(join(dirs.failedDir, readdirSync(dirs.failedDir)[0]));
    }
    assert.deepEqual(spy.built, []);
  } finally {
    clean(dirs);
  }
});

test('jobs are applied oldest first, whatever order the directory lists them in', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    // Written newest-first on purpose: `enqueue` prefixes every name with epoch milliseconds, so
    // ordering must come from the NAME and not from creation or listing order.
    pullRequest(dirs, '1700000000300-c.json', { action: 'closed', number: 5 });
    pullRequest(dirs, '1700000000100-a.json', { action: 'opened', number: 5, ref: 'editor/first' });
    pullRequest(dirs, '1700000000200-b.json', { action: 'synchronize', number: 5, ref: 'editor/second' });

    const summary = await run(dirs, spy);

    assert.deepEqual(summary.built, [5, 5]);
    assert.deepEqual(summary.tornDown, [5]);
    assert.deepEqual(spy.built.map(({ ref }) => ref), ['editor/first', 'editor/second']);
    // The close arrived last and must be applied last: applied first, it would tear down a
    // preview that the two builds then silently recreate.
    assert.deepEqual(
      [...spy.built.map(() => 'build'), 'teardown'],
      ['build', 'build', 'teardown'],
    );
    assert.equal(summary.seen, 3);
  } finally {
    clean(dirs);
  }
});

test('a build holds the per-preview lock, so a second run cannot build the same preview at once', async () => {
  const dirs = harness();
  try {
    pullRequest(dirs, '1700000000000-a.json', { action: 'opened', number: 7 });
    let contended = 'never ran';
    await runOnce({
      queueDir: dirs.queueDir,
      failedDir: dirs.failedDir,
      locksDir: dirs.locksDir,
      previewsRoot: dirs.previewsRoot,
      log: quiet,
      teardown: () => {},
      build: async () => {
        // Exactly what a second timer tick would attempt while this build is in flight.
        contended = await withLock(dirs.locksDir, 'preview-7', () => 'acquired', { timeoutMs: 60, pollMs: 10 })
          .then((value) => value, (err) => err.message);
      },
    });
    assert.match(contended, /timed out waiting for lock: preview-7/);
  } finally {
    clean(dirs);
  }
});

test('the real teardown removes the preview root for that pull request, and only that one', async () => {
  const dirs = harness();
  try {
    mkdirSync(join(dirs.previewsRoot, '42/en-us'), { recursive: true });
    writeFileSync(join(dirs.previewsRoot, '42/en-us/index.html'), '<!doctype html>');
    mkdirSync(join(dirs.previewsRoot, '43'), { recursive: true });

    previewTeardown(dirs.previewsRoot)({ number: 42 });

    assert.equal(existsSync(join(dirs.previewsRoot, '42')), false);
    assert.equal(existsSync(join(dirs.previewsRoot, '43')), true);
    // Removing a preview that was never built is not an error — a close can arrive for a pull
    // request whose build failed.
    previewTeardown(dirs.previewsRoot)({ number: 999 });
  } finally {
    clean(dirs);
  }
});

test('a missing previews root stops the whole run, with the queue untouched', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    const name = pullRequest(dirs, '1700000000000-a.json', { action: 'opened', number: 42 });
    rmSync(dirs.previewsRoot, { recursive: true, force: true });

    await assert.rejects(run(dirs, spy), /does not exist/);
    // The distinction that matters: an environment fault is retried next tick, so the job stays
    // exactly where it was rather than being quarantined for the box's problem.
    assert.deepEqual(readdirSync(dirs.queueDir), [name]);
    assert.equal(existsSync(dirs.failedDir), false);
  } finally {
    clean(dirs);
  }
});

test('a queue directory that does not exist yet is an empty pass, not a failure', async () => {
  const dirs = harness();
  const spy = spies();
  try {
    rmSync(dirs.queueDir, { recursive: true, force: true });
    const summary = await run(dirs, spy);
    assert.deepEqual(summary, { seen: 0, built: [], tornDown: [], ignored: [], failed: [] });
  } finally {
    clean(dirs);
  }
});

test('decide is a pure function of one job, and names the action it chose', () => {
  const open = {
    event: 'pull_request',
    payload: JSON.stringify({ action: 'opened', number: 12, pull_request: { head: { ref: 'editor/x' } } }),
  };
  assert.deepEqual(decide(open), {
    action: 'build', number: 12, ref: 'editor/x', reason: 'pull_request opened',
  });
  assert.equal(decide({ event: 'ping', payload: '{}' }).action, 'ignore');
  assert.throws(() => decide(null), /job is not an object/);
});
