/**
 * consumer — turns a queued delivery into a build decision, which is the one thing
 * `receiver.mjs` deliberately refuses to do. Its header says so in as many words: it stores the
 * raw bytes verbatim and "turning that into a build decision is the consumer's job". This is
 * that job.
 *
 * The split is the same one `server.mjs`/`receiver.mjs` already draw. Everything that decides
 * anything lives here, takes its inputs as arguments and returns a value; `../consume.mjs` is a
 * thin runner that reads the environment, calls `runOnce` and reports. A decision that can only
 * be exercised by starting a process, on a box, with a queue on disk, is a decision nothing
 * tests.
 *
 * WHY A JOB MAY NEVER JUST DISAPPEAR. The queue is the only record that a delivery arrived —
 * GitHub's own retry stops at the 202 the receiver already returned. So a consumer that deletes
 * a job it could not handle leaves a queue that is empty for the same reason a fully-succeeded
 * one is empty: the two states are indistinguishable, and the failure is invisible from every
 * angle. Every job here therefore ends in exactly one of two places — deleted because it was
 * genuinely handled (built, torn down, or an event this pipeline has no opinion about), or moved
 * intact into `failedDir` and named in the summary, which the runner turns into a non-zero exit
 * so systemd records the failure rather than a clean run.
 *
 * WHY AN ENVIRONMENT FAULT IS NOT A JOB FAULT. `runOnce` refuses to touch a single job until the
 * previews root exists and the build command is executable. Otherwise the first converge — where
 * roles/webhook (and this timer) converge four roles before roles/isolation creates
 * /srv/previews — would quarantine every real delivery that happened to arrive during it, and
 * those jobs are exactly the ones nobody gets back. A missing precondition is retried on the next
 * tick, with the queue untouched; a job that is genuinely bad is quarantined once.
 *
 * WHY THE DEPLOY-REQUEST DIRECTORY IS NOT ONE OF THOSE PRECONDITIONS. It is checked nowhere, on
 * purpose: `enqueue` creates it if it can, and if it cannot, exactly one merged job fails and is
 * quarantined. Promoting it to a precondition would stop the whole pass — taking every preview
 * build down with it — over a directory only the rarest job needs.
 *
 * WHY THIS PROCESS RUNS THE BUILD DIRECTLY, rather than starting
 * `jamground-preview-build@<N>.service`. This runs as jamground-build, and roles/users grants
 * that account no sudo at all — the no-argument wrappers belong to `jamground`, and each takes
 * no arguments precisely so there is no path or option injection surface to widen. That is
 * still true of the production deploy this file now requests: it writes a file, and the
 * `jamground`-side unit that reads it invokes a wrapper that takes no arguments either.
 * `systemctl start jamground-preview-build@<N>` is an argument-taking privileged command, so
 * routing the automatic path through systemd would mean widening the one grant this box has.
 * The unit stays real and instantiable by hand; the automatic path calls the same script.
 */
import {
  accessSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withLock, enqueue } from './queue.mjs';

/** The script roles/isolation ships. Repeated as a literal for the same reason every cross-role
 *  path in this tree is: application code cannot read a role's variables. */
export const DEFAULT_BUILD_COMMAND = '/usr/local/bin/jamground-preview-build';

/** Where a merged pull request's deploy REQUEST is written. roles/deploy creates it; roles/webhook
 *  names it too and hands it to this process through the environment. A literal here for the same
 *  reason DEFAULT_BUILD_COMMAND is one, and gated against both roles by
 *  test/gates/deploy-request-path-unit.test.mjs rather than promised. */
export const DEFAULT_DEPLOY_REQUESTS_DIR = '/var/lib/jamground/deploy-requests';

/** A pull request in one of these states has a head commit that should be on the web. `synchronize`
 *  is GitHub's name for "the head moved" — a push to the branch — and is the one that makes a
 *  preview track an edit rather than only its opening. */
const BUILD_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

/** A ref reaches `git fetch` as an argument. Refusing rather than sanitising, the same rule
 *  `replay.mjs` states for delivery ids and `queue.mjs` for lock keys — with one addition that is
 *  specific to being an ARGV element: a value starting with `-` is an option, not a ref, and git
 *  would read it as one. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A pull-request number becomes a path segment under the previews root, and the teardown path
 *  removes that segment recursively. Digits only, so it can never be `..`, an absolute path, or a
 *  sibling directory. */
function previewNumber(raw) {
  const value = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`refusing to use pull-request number as a path segment: ${JSON.stringify(raw)}`);
  }
  return value;
}

function headRef(raw) {
  if (typeof raw !== 'string' || !SAFE_REF.test(raw) || raw.split('/').includes('..')) {
    throw new Error(`refusing to use head ref as a git argument: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * THE PRODUCTION-DEPLOY SEAM. A merged pull request is the moment production rebuilds, and this is
 * where that is triggered from — by writing a REQUEST, and never by deploying.
 *
 * This function used to be empty, and its comment gave three reasons why: a production deploy runs
 * `npm ci` in the SHARED site checkout with nothing serialising it against a preview build; the
 * flip needs privileges this process deliberately does not hold; and a failed automatic deploy
 * needs a policy a failed manual one does not. All three are now answered — the two build scripts
 * share one flock, roles/deploy owns a `jamground`-side unit that watches this directory, and that
 * unit quarantines a request whose deploy failed — but the third reason is the one that shaped
 * this function, so it is worth being precise about what it does NOT do.
 *
 * IT WRITES A SIGNAL, NOT A COMMAND. This process runs as jamground-build and holds no sudo at
 * all. What it can say is "a merge happened"; what it cannot say is what to run. Nothing on the
 * privileged side parses this file: the unit's ExecStart is fixed, the wrapper it reaches takes no
 * arguments, and the two checkout paths are literals in a root-owned 0700 script. The number and
 * the job name below are for the journal and for whoever reads a quarantined request — no byte of
 * them reaches an argv. That asymmetry IS the privilege separation, and it is why this is a
 * directory of files rather than a call.
 *
 * IT REUSES `enqueue` RATHER THAN WRITING A FILE. Complete or absent, never partial — the request
 * is written `.<name>.tmp` and renamed, so the `.path` unit's `*.json` glob cannot fire on a
 * request that does not exist yet. Same primitive, same property, as the delivery queue.
 *
 * A FAILURE HERE QUARANTINES THE DELIVERY, and that is correct rather than a rough edge. It runs
 * after the teardown succeeded, so the throw reaches `runOnce`'s catch, the delivery moves intact
 * into `failedDir`, and the run exits non-zero. Re-running tears down again (idempotent) and
 * re-requests. The one outcome ruled out everywhere in this file is a merge that stops existing
 * without having been acted on, and a deploy request that could not be written is exactly that.
 */
export function deployProductionOnMerge({ number, job } = {}, requestsDir = DEFAULT_DEPLOY_REQUESTS_DIR) {
  return enqueue(requestsDir, {
    reason: 'pull request merged',
    number,
    job,
    requestedAt: new Date().toISOString(),
  });
}

/**
 * The whole decision, as a pure function of one job. Returns
 * `{ action: 'build' | 'teardown' | 'ignore', … }` and throws only when the job is malformed in a
 * way that cannot be a decision — which is what puts it in `failedDir` rather than silently
 * through.
 *
 * `payload` is the raw request body as a string, exactly as the receiver stored it, so parsing it
 * happens HERE and only for an event this consumer actually acts on: a `push` delivery with a
 * body this consumer cannot parse is still a job it has no opinion about, and inventing an error
 * for it would quarantine deliveries that are merely uninteresting.
 */
export function decide(job) {
  if (!job || typeof job !== 'object') {
    throw new Error(`job is not an object: ${JSON.stringify(job)}`);
  }
  if (job.event !== 'pull_request') {
    return { action: 'ignore', reason: `event ${JSON.stringify(job.event)} is not pull_request` };
  }

  const payload = JSON.parse(job.payload);
  const what = payload?.action;

  if (what === 'closed') {
    return {
      action: 'teardown',
      number: previewNumber(payload.number),
      // GitHub distinguishes the two ways a pull request closes with this one boolean. A closed
      // preview comes down either way; only a MERGED one is production's business.
      merged: payload.pull_request?.merged === true,
      reason: 'pull request closed',
    };
  }

  if (!BUILD_ACTIONS.has(what)) {
    return { action: 'ignore', reason: `pull_request action ${JSON.stringify(what)} changes no preview` };
  }

  return {
    action: 'build',
    number: previewNumber(payload.number),
    ref: headRef(payload.pull_request?.head?.ref),
    reason: `pull_request ${what}`,
  };
}

/** The real build: the script roles/isolation ships, invoked with the pull-request number and the
 *  head ref as two argv elements — never a shell string, so neither value is ever parsed by a
 *  shell on the way. Its own `set -euo pipefail` and `fail()` decide what a failed build means;
 *  a non-zero exit throws here, which quarantines the job. */
export function previewBuilder(buildCommand) {
  return function build({ number, ref }) {
    execFileSync(buildCommand, [String(number), ref], { stdio: 'inherit' });
  };
}

/** The real teardown: the preview root for that pull request, removed whole. `<previews_root>/<N>`
 *  is a plain directory rather than a symlink into a releases tree precisely so this one call
 *  reclaims everything the preview ever occupied — see jamground-preview-build's header. */
export function previewTeardown(previewsRoot) {
  return function teardown({ number }) {
    rmSync(join(previewsRoot, String(number)), { recursive: true, force: true });
  };
}

/** Moves a job that could not be handled out of the queue, intact, and says so. If even the move
 *  fails the job STAYS in the queue — retried next tick, still visible — because the one outcome
 *  ruled out everywhere here is a job that stops existing without having been handled. */
function quarantine(queuePath, failedDir, name, log) {
  try {
    mkdirSync(failedDir, { recursive: true });
    renameSync(queuePath, join(failedDir, name));
    return join(failedDir, name);
  } catch (err) {
    log.error(`consumer: could not move ${name} to ${failedDir} (${err.message}); `
      + 'leaving it in the queue rather than losing it');
    return null;
  }
}

/**
 * One pass over the queue, oldest first. `enqueue` names every job
 * `<epoch-ms>-<uuid>.json`, so a plain lexicographic sort of the directory IS chronological order
 * — the millisecond field is fixed-width until the year 2286 — and a redelivery that arrived
 * while an earlier job was still queued is applied in the order the box learned about it.
 *
 * Every side effect is injectable (`build`, `teardown`, `onMerged`) so the decisions above can be
 * exercised without a box, a systemd unit or a git remote in the loop.
 */
export async function runOnce({
  queueDir,
  failedDir,
  locksDir,
  previewsRoot,
  deployRequestsDir = DEFAULT_DEPLOY_REQUESTS_DIR,
  buildCommand = DEFAULT_BUILD_COMMAND,
  build,
  teardown,
  onMerged = (decision) => deployProductionOnMerge(decision, deployRequestsDir),
  log = console,
} = {}) {
  for (const [name, value] of Object.entries({ queueDir, failedDir, locksDir, previewsRoot })) {
    if (typeof value !== 'string' || value === '') throw new Error(`runOnce requires ${name}`);
  }

  // Preconditions, checked before a single job is read — see this file's header. Each of these is
  // a fact about the box, so a failure here must leave the queue exactly as it found it.
  if (!existsSync(previewsRoot)) {
    throw new Error(`previews root ${previewsRoot} does not exist; refusing to process any job — `
      + 'a job quarantined for a missing mount is a job nobody gets back');
  }
  if (!build) {
    try {
      accessSync(buildCommand, fsConstants.X_OK);
    } catch {
      throw new Error(`${buildCommand} is not executable; refusing to process any job`);
    }
  }

  const doBuild = build ?? previewBuilder(buildCommand);
  const doTeardown = teardown ?? previewTeardown(previewsRoot);

  const summary = { seen: 0, built: [], tornDown: [], ignored: [], failed: [], deployRequested: [] };
  if (!existsSync(queueDir)) return summary;

  // `.`-prefixed names are enqueue's own half-written temp files, which it renames into place;
  // reading one would be reading a job that is not there yet.
  const names = readdirSync(queueDir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort();

  for (const name of names) {
    const queuePath = join(queueDir, name);
    summary.seen += 1;
    let decision;
    try {
      decision = decide(JSON.parse(readFileSync(queuePath, 'utf8')));

      if (decision.action === 'build') {
        // Serialised per preview, not globally: two deliveries for the same pull request (an open
        // immediately followed by a push) must not build into one directory at once, and two
        // different pull requests have no reason to wait for each other here.
        await withLock(locksDir, `preview-${decision.number}`, () => doBuild(decision));
      } else if (decision.action === 'teardown') {
        await withLock(locksDir, `preview-${decision.number}`, () => doTeardown(decision));
        // The job NAME goes with the request, so a quarantined deploy can be traced back to the
        // delivery that caused it without correlating two directories by timestamp.
        if (decision.merged) {
          onMerged({ ...decision, job: name });
          summary.deployRequested.push(decision.number);
        }
      }
    } catch (err) {
      const moved = quarantine(queuePath, failedDir, name, log);
      summary.failed.push({ job: name, movedTo: moved, error: err.message });
      log.error(`consumer: ${name} failed: ${err.message}`);
      continue;
    }

    // Handled. Only now does the job stop existing.
    rmSync(queuePath, { force: true });
    if (decision.action === 'build') summary.built.push(decision.number);
    else if (decision.action === 'teardown') summary.tornDown.push(decision.number);
    else summary.ignored.push(decision.reason);
  }

  return summary;
}
