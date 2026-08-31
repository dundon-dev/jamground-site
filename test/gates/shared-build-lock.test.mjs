/* Invariant: one lock serialises everything that builds in the shared site checkout, and both
 * scripts name the same one.
 *
 * WHY IT MATTERS, AND WHY IT ONLY STARTED MATTERING NOW. jamground-deploy begins with `npm ci`,
 * which DELETES node_modules before repopulating it — in the site checkout that
 * jamground-preview-build reads for every preview. Preview builds have serialised against each
 * other since they existed; a production deploy took no lock at all, so that one overlap was
 * unprotected. It was survivable while a deploy was an operator's deliberate act, at a moment a
 * person chose. It stopped being survivable when a merged pull request could start one on its own.
 *
 * WHY IT IS A GATE AND NOT A COMMENT. The two scripts are separate files, systemd invokes each
 * with no control node in the loop, and each spells its paths out as literals for that reason. Two
 * literals in two files that must agree is the drift shape this repo already gates elsewhere
 * (check-config's Rule A, hooks-vhost, preview-slice). And a drifted lock fails SILENTLY in the
 * worst direction: two locks are two locks that are each taken successfully, so both builds run,
 * both report success, and what is wrong is a dependency tree one of them was using.
 *
 * WHY THE PATH IS WHAT IT IS. It is derived from $JAMGROUND_SITE_CHECKOUT, and every other
 * candidate is unopenable by one of the two accounts that must take it:
 *
 *   - /srv/previews/.build.lock, where the preview lock used to live, is on the fixed-size
 *     loopback image (roles/isolation). A production deploy has no business writing it, and it
 *     does not exist at all before that role converges.
 *   - /srv/jamground/... would need /srv/jamground in the queue consumer's ReadWritePaths
 *     (roles/webhook runs it under ProtectSystem=strict, which bind-mounts each one). That would
 *     hand a build that executes pull-request content write access to releases/ and the `current`
 *     symlink — the blast radius this whole tree is arranged to avoid.
 *   - The site checkout is ALREADY a ReadWritePath, because the build writes it. So it is the one
 *     inode both accounts can open, inside the sandbox and outside it. Same derivation, and the
 *     same argument, as work_root in preview-work-root.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const deploy = read('infra/ansible/roles/deploy/files/jamground-deploy');
const preview = read('infra/ansible/roles/isolation/files/jamground-preview-build');

/** The `build_lock=` assignment, as a whole line, from a script. Comments are stripped first: both
 *  files explain at length which paths were rejected and why, and a naive scan finds
 *  `previews_root` in that prose and fails on the explanation rather than on the configuration —
 *  the lesson consume-path-unit.test.mjs already records. */
const uncommented = (script) => script
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

const lockLine = (script) => uncommented(script)
  .split('\n')
  .find((line) => line.startsWith('build_lock='));

test('both scripts declare the same build lock, byte for byte', () => {
  const a = lockLine(deploy);
  const b = lockLine(preview);
  assert.ok(a, 'jamground-deploy must declare build_lock');
  assert.ok(b, 'jamground-preview-build must declare build_lock');
  assert.equal(a, b,
    `jamground-deploy has ${a} and jamground-preview-build has ${b}. Two different lock files are `
    + 'two locks that are each taken successfully — so a production deploy and a preview build run '
    + 'at the same time in the same checkout, both report success, and the `npm ci` deletes a '
    + 'dependency tree the other one is using.');
});

test('the lock is derived from the site checkout, not from a path of its own', () => {
  const line = lockLine(deploy);
  assert.match(line, /^build_lock="\$JAMGROUND_SITE_CHECKOUT\//,
    `build_lock is ${line}. It must be inside $JAMGROUND_SITE_CHECKOUT: that is the only path both `
    + 'jamground-build and root can open, because it is already a ReadWritePath in the queue '
    + "consumer's systemd sandbox. See this file's header for why each alternative is not.");
});

test('the lock is not on the previews image, which only one side can write', () => {
  for (const [name, line] of [['jamground-deploy', lockLine(deploy)], ['jamground-preview-build', lockLine(preview)]]) {
    assert.ok(!/previews_root|\/srv\/previews/.test(line),
      `${name}'s build_lock is ${line}. The previews root is a separate loopback filesystem that a `
      + 'production deploy has no business writing, and that does not exist before roles/isolation '
      + 'converges. This is where the preview lock used to live, and moving it is the change that '
      + 'let the two scripts share one.');
  }
});

test('each script takes the lock before the command the lock exists for', () => {
  // In jamground-deploy that command is `npm ci`, which deletes node_modules. Taken afterwards,
  // the lock protects nothing that was worth protecting.
  // Comments stripped first, for the reason lockLine strips them: both scripts discuss `npm ci`
  // and `npm run build` at length in their headers — jamground-preview-build's point 2 is entirely
  // about the fact that it never runs `npm ci` — so a scan over the raw text finds the PROSE and
  // reports an ordering that is nowhere in the code.
  const deployCode = uncommented(deploy);
  const previewCode = uncommented(preview);

  const deployLock = deployCode.indexOf('flock -w');
  const npmCi = deployCode.indexOf('\nnpm ci');
  assert.ok(deployLock > 0 && npmCi > 0, 'jamground-deploy must both take the lock and run npm ci');
  assert.ok(deployLock < npmCi,
    'jamground-deploy runs `npm ci` before it takes the build lock, so a preview build can still '
    + 'have its dependency tree deleted underneath it — which is the entire reason for the lock.');

  // In jamground-preview-build it is the build itself, whose Astro caches live in the same
  // checkout: two interleaving builds are a corrupt build, not a slow one.
  const previewLock = previewCode.indexOf('flock -w');
  const previewBuild = previewCode.indexOf('npm run build');
  assert.ok(previewLock > 0 && previewBuild > 0, 'jamground-preview-build must both take the lock and build');
  assert.ok(previewLock < previewBuild,
    'jamground-preview-build builds before it takes the lock');
});

test("the consumer's sandbox can open the lock at all", () => {
  const unit = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.service.j2');
  assert.match(unit, /^ReadWritePaths=-?\{\{ webhook_site_checkout \}\}$/m,
    'the queue consumer runs under ProtectSystem=strict, and every preview build it spawns is its '
    + 'child. Without the site checkout as a ReadWritePath the build cannot open the lock at all — '
    + 'it fails with EROFS, on the automatic path, which is the one nobody is watching.');
});

/* The ownership race, which is the half of this that no amount of care in the two scripts can fix.
 *
 * Neither script CREATES the lock deliberately: `flock` and `exec 9>` each create it on first use,
 * as whoever got there first. That is very often root — this role's own deploy, or an operator
 * following the RUNBOOK — which leaves a root-owned file jamground-build cannot open for write.
 * From then on every preview build dies with EACCES on the lock, which reads as nothing to do with
 * a lock at all. So the converge creates it first, owned by the account that could not.
 */
test('the converge creates the lock owned by the build account, before anything can take it', () => {
  const tasks = YAML.parse(read('infra/ansible/roles/content_repos/tasks/main.yml'));
  const touchAt = tasks.findIndex((t) => t['ansible.builtin.file']?.path?.includes('.build.lock'));
  const deployAt = tasks.findIndex((t) => t['ansible.builtin.command'] === '{{ content_repos_deploy_script }}');

  assert.notEqual(touchAt, -1, 'roles/content_repos must create the shared build lock');
  assert.notEqual(deployAt, -1, 'roles/content_repos must still be the role that runs the deploy');

  const file = tasks[touchAt]['ansible.builtin.file'];
  assert.equal(file.owner, 'jamground-build',
    `the lock is created owned by ${file.owner}. It must be jamground-build: root can open a file `
    + 'owned by anyone, and jamground-build cannot open one owned by root — so the account that '
    + 'cannot is the one it has to belong to.');
  assert.equal(file.state, 'touch');
  assert.equal(file.modification_time, 'preserve',
    '`state: touch` without preserved timestamps reports changed on every single converge, which '
    + 'is how a converge stops meaning anything');
  assert.equal(file.access_time, 'preserve');

  assert.ok(touchAt < deployAt,
    'the lock is created after the task that runs jamground-deploy, so on a first converge the '
    + 'deploy creates it as root and every preview build after that fails with EACCES.');
});
