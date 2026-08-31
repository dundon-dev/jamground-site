#!/usr/bin/env node
/**
 * consume — one pass over the receiver's queue, run by jamground-hooks-consume.timer about once a
 * minute. Deployed to the box with Ansible as courier only, exactly like `server.mjs`.
 *
 * Thin on purpose, the same way `server.mjs` is thin: read the environment, call `runOnce`, print
 * what happened, exit. Every decision it reports lives in `lib/consumer.mjs`, where it can be
 * tested without a queue on disk or a systemd timer.
 *
 * A oneshot rather than a daemon. The work is bursty and idempotent per job, a crash is a missed
 * tick rather than a stuck process, and systemd restarts nothing that has already exited — which
 * is also what makes the exit code meaningful: non-zero here means at least one job was
 * quarantined, and `systemctl status` and the journal both keep saying so.
 */
import { runOnce } from './lib/consumer.mjs';

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const state = env('WEBHOOK_STATE_DIR', '/var/lib/jamground-hooks');

let summary;
try {
  summary = await runOnce({
    queueDir: env('WEBHOOK_QUEUE_DIR', `${state}/queue`),
    failedDir: env('WEBHOOK_FAILED_DIR', `${state}/failed`),
    locksDir: env('WEBHOOK_LOCKS_DIR', `${state}/locks`),
    previewsRoot: env('JAMGROUND_PREVIEWS_ROOT', '/srv/previews'),
    deployRequestsDir: env('JAMGROUND_DEPLOY_REQUESTS', '/var/lib/jamground/deploy-requests'),
    buildCommand: env('JAMGROUND_PREVIEW_BUILD', '/usr/local/bin/jamground-preview-build'),
  });
} catch (err) {
  // A precondition about the BOX, not about any job — the previews root is not mounted yet, or
  // the build script is not shipped yet. `runOnce` throws before it reads a single job, so the
  // queue is exactly as it was and the next tick retries. One line, not a stack: this runs every
  // minute, and the journal has to stay readable while a converge finishes.
  console.error(`consume: ${err.message}`);
  process.exit(1);
}

// Silent on an empty queue — this runs every minute, and a line per tick would bury the ticks
// that did something under the ones that did not.
if (summary.seen > 0) {
  console.log(`consume: ${summary.seen} job(s) — built ${JSON.stringify(summary.built)}, `
    + `torn down ${JSON.stringify(summary.tornDown)}, ignored ${summary.ignored.length}, `
    + `failed ${summary.failed.length}, `
    + `requested deploy ${JSON.stringify(summary.deployRequested)}`);
}

for (const failure of summary.failed) {
  console.error(`consume: ${failure.job} → ${failure.movedTo ?? 'still queued'}: ${failure.error}`);
}

process.exit(summary.failed.length > 0 ? 1 : 0);
