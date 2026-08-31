/* Invariant: the deploy path's `npm ci && npm run build` runs as jamground-build, and only the
 * flip runs privileged.
 *
 * WHY THIS EXISTS. jamground-deploy's header stated exactly that property for the whole of its
 * earlier life, and the script did not do it: `npm ci && npm run build` ran in the script's own
 * process, as whoever invoked it, and roles/content_repos invoked it with no `become_user` — as
 * root. Every artefact a build writes into the SHARED site checkout therefore came out root-owned:
 * .astro/, node_modules/, dist/.
 *
 * WHY IT STAYED HIDDEN, which is the whole reason it is worth a gate. Nothing went red. Production
 * kept deploying, because root can write what root owns, and the site it served was correct. The
 * only thing that could notice was a build by some OTHER account, and there had never been one.
 * The day there was — jamground-preview-build, which correctly runs as jamground-build because it
 * executes the contents of a pull request — it failed with
 *
 *     EACCES: permission denied, open '/srv/jamground/repos/site/.astro/content.d.ts'
 *
 * and the failure surfaced on the preview, several roles away from the deploy that caused it. A
 * privilege defect whose only symptom is a permission error in a different feature is one that
 * waits, so this gate does not read the header's sentence — it runs the shipped script and watches
 * who the build actually runs as.
 *
 * HOW. The script is executed with a PATH of stubs in front of it: `id` decides whether it thinks
 * it is root, `sudo` records the account it was asked to become and — faithfully — runs the rest
 * in a RESET environment, the way `env_reset` does on a real box, and `npm` records the identity
 * and environment it was reached with and then fails, so the run stops before `cp`, the manifest
 * or the flip. `mkdir` and `rm` are stubbed to record and do nothing, so a run of this gate cannot
 * touch /srv on a machine that happens to have one.
 *
 * The environment assertion is the sharp one. Because the stub `sudo` resets the environment, an
 * implementation that sources the identity file and exports JAMGROUND_CONTENT_DIR in the PARENT
 * and then merely sudos would reach `npm` with neither — which is precisely the mistake that is
 * easy to make while fixing this, and it fails here rather than on the box.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'infra/ansible/roles/deploy/files/jamground-deploy');
const TASKS = join(ROOT, 'infra/ansible/roles/content_repos/tasks/main.yml');
const DEFAULTS = join(ROOT, 'infra/ansible/roles/content_repos/defaults/main.yml');
const DEPLOY_SCRIPT_PATH = '/usr/local/bin/jamground-deploy';

/** The account the build must run as — this box's unprivileged one, holding no sudo at all
 *  (roles/users), because a build executes repository content. */
const BUILD_USER = 'jamground-build';

/** The three things a build writes into the shared site checkout. Both scripts that build in it
 *  run as BUILD_USER, so all three must be owned by it. */
const BUILD_OUTPUTS = ['.astro', 'node_modules', 'dist'];

const stub = (dir, name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}`, 'utf8');
  chmodSync(path, 0o755);
};

/** Runs the shipped jamground-deploy with a stubbed world, pretending to be `uid`/`user`.
 *
 *  The stubs are deliberately few: everything else — bash, env, date, readlink — is the real
 *  thing, so what runs is the script's own control flow and not a re-description of it. */
function runDeployAs({ uid, user }) {
  // realpath, because the script resolves the content checkout with `readlink -f` and macOS's
  // /var is a symlink to /private/var — a difference that is the platform's, not the script's.
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'jamground-deploy-gate-')));
  const bin = join(box, 'bin');
  const site = join(box, 'repos/site');
  const content = join(box, 'repos/content');
  const rootHome = join(box, 'home-root');
  for (const d of [bin, site, content, rootHome]) mkdirSync(d, { recursive: true });

  const npmLog = join(box, 'npm.log');
  const sudoLog = join(box, 'sudo.log');
  const mkdirLog = join(box, 'mkdir.log');
  const flockLog = join(box, 'flock.log');
  const orderLog = join(box, 'order.log');

  stub(bin, 'id', `case "$1" in\n  -u) echo ${uid} ;;\n  *) echo ${user} ;;\nesac\n`);
  stub(bin, 'git', 'echo abc1234\n');
  stub(bin, 'mkdir', `echo "argv=$*" >> ${JSON.stringify(mkdirLog)}\n`);
  stub(bin, 'rm', `echo "argv=$*" >> ${JSON.stringify(join(box, 'rm.log'))}\n`);

  // The script re-execs itself under flock to take the build lock it now shares with
  // jamground-preview-build. Stubbed rather than real for two reasons: macOS has no flock(1) at
  // all, and the lock path is inside a checkout that on a developer machine is this temp
  // directory rather than the box's. Faithful in the two respects the script depends on — the
  // options are consumed and the rest is exec'd — so what runs after it is the script's own
  // second pass, not a description of one.
  stub(bin, 'flock', [
    'opts=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -w|-E) opts="$opts $1 $2"; shift 2 ;;',
    '    -*) opts="$opts $1"; shift ;;',
    '    *) break ;;',
    '  esac',
    'done',
    `echo "opts=$opts lock=$1" >> ${JSON.stringify(flockLog)}`,
    `echo "flock" >> ${JSON.stringify(orderLog)}`,
    'shift',
    'exec "$@"',
    '',
  ].join('\n'));

  // Faithful in the one respect that matters: real sudo runs the command in a reset environment,
  // so nothing this script exported before the drop arrives on the far side of it. HOME is set
  // from the TARGET user, which is what `env_reset` (and `-H`) both do.
  stub(bin, 'sudo', [
    `echo "argv=$*" >> ${JSON.stringify(sudoLog)}`,
    'target=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -n|-H|-E) shift ;;',
    '    -u) target=$2; shift 2 ;;',
    '    *) break ;;',
    '  esac',
    'done',
    `echo "target=$target" >> ${JSON.stringify(sudoLog)}`,
    `exec env -i PATH="$PATH" HOME=${JSON.stringify(box)}/home-"$target" JG_SUDO_TARGET="$target" "$@"`,
    '',
  ].join('\n'));

  // Records who reached it and with what, then fails the SECOND call, so the script takes its
  // own `fail()` path and never reaches the copy, the manifest or the flip.
  stub(bin, 'npm', [
    '{',
    '  echo "--"',
    '  echo "argv=$*"',
    '  echo "ranAs=${JG_SUDO_TARGET-not-dropped}"',
    '  echo "contentDir=${JAMGROUND_CONTENT_DIR-<unset>}"',
    '  echo "home=${HOME-<unset>}"',
    '  echo "cwd=$PWD"',
    `} >> ${JSON.stringify(npmLog)}`,
    `echo "npm $1" >> ${JSON.stringify(orderLog)}`,
    'case "$1" in',
    '  ci) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: box,
    // BOUNDED, because the failure this gate now watches for can HANG rather than fail. The script
    // re-execs itself under flock and stops only because JAMGROUND_DEPLOY_LOCKED is set on the way
    // in; remove that guard and it re-execs for ever. Unbounded, this gate would then sit until
    // whatever runs it gives up — a gate that hangs reports nothing, which is worse than one that
    // is merely absent. 30s is ~20x the honest run measured here, so it cannot fire on a slow
    // machine.
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: rootHome,
      JAMGROUND_SITE_CHECKOUT: site,
      JAMGROUND_CONTENT_CHECKOUT: content,
    },
  });

  const readIfAny = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const npmCalls = readIfAny(npmLog).split('--\n').slice(1).map((block) => Object.fromEntries(
    block.trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  ));

  const flock = readIfAny(flockLog).trim().split('\n').filter(Boolean);
  const order = readIfAny(orderLog).trim().split('\n').filter(Boolean);

  return {
    result, box, site, content, rootHome, npmCalls, flock, order,
    sudo: readIfAny(sudoLog), mkdir: readIfAny(mkdirLog),
  };
}

test('invoked as root, the build runs as the unprivileged account and the environment survives', () => {
  const run = runDeployAs({ uid: 0, user: 'root' });

  assert.equal(run.npmCalls.length, 2, 'the script did not reach `npm ci` and `npm run build` — it '
    + `exited ${run.result.status} first.\nstdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);

  for (const call of run.npmCalls) {
    assert.equal(call.ranAs, BUILD_USER, `\`npm ${call.argv}\` ran as ${call.ranAs}. Invoked as `
      + `root, ${relative(ROOT, SCRIPT)} must drop to ${BUILD_USER} for the build: it is the flip `
      + 'that is privileged, not the build. A root-run build leaves .astro/, node_modules/ and '
      + 'dist/ in the SHARED site checkout owned by root, which production never notices (root '
      + 'writes what root owns) and jamground-preview-build cannot write at all.');
  }

  assert.match(run.sudo, new RegExp(`^target=${BUILD_USER}$`, 'm'),
    `the drop did not name ${BUILD_USER}. sudo saw: ${JSON.stringify(run.sudo)}`);

  // The sharp one. The stub sudo resets the environment exactly as a real one does, so this fails
  // for an implementation that sources the identity and exports the content directory in the
  // PARENT shell and then simply sudos — the build would reach npm with neither.
  for (const call of run.npmCalls) {
    assert.equal(call.contentDir, run.content, `\`npm ${call.argv}\` was reached with `
      + `JAMGROUND_CONTENT_DIR=${call.contentDir}, not ${run.content}. \`sudo\` runs the command in `
      + 'a RESET environment, so anything exported before the privilege drop does not cross it. '
      + 'The build finds content/ through that one variable and nothing else: it must be carried '
      + 'over the drop, not exported on the near side of it.');
    assert.notEqual(call.home, run.rootHome, `\`npm ${call.argv}\` was reached with HOME still set `
      + "to the INVOKER's home. npm writes a cache and a log directory under HOME, so the build "
      + 'would fail with an EACCES naming ~/.npm rather than the account, or worse, write into '
      + "root's home as jamground-build.");
    assert.equal(call.cwd, run.site, `\`npm ${call.argv}\` ran in ${call.cwd}, not the site checkout`);
  }

  // A failed build still never becomes current: the `fail()` discipline has to survive the drop.
  assert.equal(run.result.status, 1, 'a build that exited non-zero did not fail the deploy');
  assert.match(run.result.stderr, /the build exited non-zero; current is unchanged/);
  assert.doesNotMatch(run.result.stdout, /flipping current/,
    'the script reached the flip after a build that exited non-zero');
});

test('invoked as the build account already, it does not drop again', () => {
  const run = runDeployAs({ uid: 1000, user: BUILD_USER });

  assert.equal(run.npmCalls.length, 2, 'the script did not reach `npm ci` and `npm run build` — it '
    + `exited ${run.result.status} first.\nstdout: ${run.result.stdout}\nstderr: ${run.result.stderr}`);
  assert.equal(run.sudo, '', `${relative(ROOT, SCRIPT)} tried to drop privileges while already `
    + `running as ${BUILD_USER}: sudo saw ${JSON.stringify(run.sudo)}. Neither ${BUILD_USER} nor `
    + 'jamground holds a `sudo -u` grant — jamground-build holds no sudo at all and jamground holds '
    + 'exactly three no-argument entries — so a second drop cannot succeed, and it is not needed: '
    + 'the build is already running without privilege.');
  for (const call of run.npmCalls) {
    assert.equal(call.contentDir, run.content,
      `\`npm ${call.argv}\` was reached with JAMGROUND_CONTENT_DIR=${call.contentDir}`);
  }
  assert.equal(run.result.status, 1, 'a build that exited non-zero did not fail the deploy');
});

/** The role's tasks, and its defaults expanded into each one, so this reads the literals the box
 *  is actually handed rather than `{{ … }}` strings — the same move test/gates/deploy-env-names
 *  makes for the same reason. */
function convergeTasks() {
  const tasks = YAML.parse(readFileSync(TASKS, 'utf8'));
  const defaults = YAML.parse(readFileSync(DEFAULTS, 'utf8'));
  assert.ok(Array.isArray(tasks), `${relative(ROOT, TASKS)} did not parse to a list of tasks`);
  return tasks.map((task) => {
    let text = YAML.stringify(task);
    for (let i = 0; i < 10 && text.includes('{{'); i += 1) {
      text = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name) => {
        if (!(name in defaults)) return whole;
        const value = defaults[name];
        return Array.isArray(value) ? value.join(' ') : String(value);
      });
    }
    return { task, text };
  });
}

test('the converge runs the deploy script as root, the one account that can drop', () => {
  const tasks = convergeTasks();
  const deploy = tasks.findIndex(({ task, text }) => task
    && (task.command || task['ansible.builtin.command']) && text.includes(DEPLOY_SCRIPT_PATH));
  assert.notEqual(deploy, -1, `${relative(ROOT, TASKS)} has no task running ${DEPLOY_SCRIPT_PATH}, `
    + 'so this gate is reading the wrong file or the converge no longer performs the deploy');

  const becomeUser = tasks[deploy].task.become_user;
  assert.ok(becomeUser === undefined || becomeUser === 'root',
    `${relative(ROOT, TASKS)} runs ${DEPLOY_SCRIPT_PATH} as ${becomeUser}. It must run as root: `
    + `the script drops to ${BUILD_USER} for the build itself (\`sudo -u\`, which only root can `
    + 'do here) and calls the two privileged wrappers directly. Run as any other account it '
    + 'cannot drop, so the build inherits that account and leaves the shared site checkout owned '
    + 'by it — the defect this gate exists for, in a new colour.');
});

test('the converge repairs ownership of the build outputs before it builds', () => {
  const tasks = convergeTasks();
  const deploy = tasks.findIndex(({ task, text }) => task
    && (task.command || task['ansible.builtin.command']) && text.includes(DEPLOY_SCRIPT_PATH));
  assert.notEqual(deploy, -1, `${relative(ROOT, TASKS)} has no task running ${DEPLOY_SCRIPT_PATH}`);

  const before = tasks.slice(0, deploy);
  const repairs = before.filter(({ text }) => /owner: jamground-build/.test(text) && /recurse: true/.test(text));
  assert.notEqual(repairs.length, 0, `${relative(ROOT, TASKS)} has no task before the deploy that `
    + `recursively gives ${BUILD_USER} ownership of anything. A script that now builds unprivileged `
    + 'cannot chown what an earlier root-run build already left behind, so the box stays broken '
    + 'until something on the converge repairs it.');

  const covered = before.map(({ text }) => text).join('\n');
  for (const output of BUILD_OUTPUTS) {
    assert.ok(covered.includes(output), `${relative(ROOT, TASKS)} never names ${output} before the `
      + `deploy task. All three of ${BUILD_OUTPUTS.join(', ')} are written into the SHARED site `
      + 'checkout by both jamground-deploy and jamground-preview-build, and both run as '
      + `${BUILD_USER}; one left owned by root is one the preview build dies on.`);
  }
});

/* Invariant: the deploy takes the shared build lock, once, before it deletes the dependency tree.
 *
 * WHY IT IS PART OF *THIS* GATE. The two facts are one fact. `npm ci` deletes node_modules in the
 * SHARED site checkout, and the account that is hurt by that is jamground-build — the same account
 * this file exists to keep the build running as, mid-flight in a preview build that this deploy
 * knows nothing about. Before the lock, that overlap was a choice an operator made by running the
 * deploy at a bad moment; a merged pull request now makes it on its own, at a moment nobody picks.
 *
 * The re-exec is also the thing most likely to go wrong quietly. Without the JAMGROUND_DEPLOY_LOCKED
 * guard the script re-execs forever, taking the lock recursively and never reaching a build — which
 * from outside looks like a deploy that hangs, not one that is broken.
 */
test('the deploy takes the shared build lock exactly once, before npm ci', () => {
  const run = runDeployAs({ uid: 0, user: 'root' });

  assert.notEqual(run.result.signal, 'SIGKILL',
    'the script did not terminate and was killed on the harness timeout. That is the shape of a '
    + 'lost JAMGROUND_DEPLOY_LOCKED guard: the flock re-exec has nothing to stop it, so the script '
    + 're-execs itself for ever and never reaches a build. From the outside it reads as a deploy '
    + 'that hangs rather than one that is broken.');

  assert.equal(run.flock.length, 1,
    `flock ran ${run.flock.length} times, expected exactly 1. More than one means the `
    + 'JAMGROUND_DEPLOY_LOCKED guard is not stopping the re-exec, and the script never reaches a '
    + 'build; zero means it is not taking the lock at all and a preview build can have its '
    + 'dependency tree deleted underneath it.');

  assert.match(run.flock[0], /lock=.*\/\.build\.lock$/,
    `flock was given ${run.flock[0]}. The lock must be "$JAMGROUND_SITE_CHECKOUT/.build.lock" — `
    + 'the same path jamground-preview-build takes, which test/gates/shared-build-lock.test.mjs '
    + 'holds the two scripts to.');
  assert.ok(run.flock[0].includes(`lock=${run.site}/`),
    `the lock is at ${run.flock[0]}, not under the site checkout ${run.site}. Every other location `
    + 'is unopenable by one of the two accounts that must take it — the previews image is a '
    + 'separate filesystem, and /srv/jamground is not in the queue consumer\'s ReadWritePaths.');

  assert.equal(run.order[0], 'flock',
    `the first thing the script reached was ${run.order[0]}, not flock. The lock exists for the `
    + '`npm ci` below it; taken afterwards it protects nothing.');
  assert.ok(run.order.indexOf('flock') < run.order.indexOf('npm ci'),
    `observed order was ${run.order.join(' -> ')}`);
});
