/* Invariant: a merged pull request actually reaches a production deploy.
 *
 * WHY THIS IS WORTH A GATE, AND WHY IT IS SHAPED LIKE consume-path-unit's. Every failure mode in
 * this chain is silent, and the chain is four hops long across three roles and one Node module:
 *
 *   consumer.mjs (jamground-build, no sudo)  ->  a request file
 *     ->  jamground-deploy-request.path      ->  jamground-deploy-request.service (jamground)
 *     ->  sudo jamground-deploy-now          ->  jamground-deploy
 *
 * systemd loads a `.path` unit whose PathExistsGlob names a directory that does not exist without
 * complaint — it waits, for ever, for a file that will never appear. `systemctl status` is green.
 * The consumer keeps returning success. Merges keep landing. And unlike the preview path, there is
 * no backstop timer here to make the outage look like latency instead of silence: production
 * simply stops moving, which is the exact condition this whole pass exists to end and which
 * nothing on the box reported for three merges.
 *
 * Two of the assertions below are for defects that would look like something else entirely:
 * TimeoutStartSec (systemd's 90s default kills every deploy mid-build, and reports it as the
 * script failing) and NoNewPrivileges (sudo is setuid, so setting it — as every other unit here
 * does — breaks the grant rather than narrowing it).
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
const yaml = (p) => YAML.parse(read(p));

const deployDefaults = yaml('infra/ansible/roles/deploy/defaults/main.yml');
const webhookDefaults = yaml('infra/ansible/roles/webhook/defaults/main.yml');
const isolationDefaults = yaml('infra/ansible/roles/isolation/defaults/main.yml');
const deployTasks = yaml('infra/ansible/roles/deploy/tasks/main.yml');

const pathUnit = read('infra/ansible/roles/deploy/templates/jamground-deploy-request.path.j2');
const service = read('infra/ansible/roles/deploy/templates/jamground-deploy-request.service.j2');
const consumeUnit = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.service.j2');

/* Directives only. Both units argue in their comments about the systemd options they do NOT use —
 * DirectoryNotEmpty in one, NoNewPrivileges in the other — so a scan of the whole file finds the
 * word inside the paragraph rejecting it and fails on the explanation rather than on the
 * configuration. consume-path-unit.test.mjs learned this on its own first run. */
const directives = (unit) => unit
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  .join('\n');

const pathDirectives = directives(pathUnit);
const serviceDirectives = directives(service);

const value = (unit, key) => {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(unit);
  return match ? match[1] : undefined;
};

test('the path unit watches the directory the consumer writes into', () => {
  assert.equal(value(pathDirectives, 'PathExistsGlob'), '{{ deploy_requests_dir }}/*.json',
    'the path unit must watch {{ deploy_requests_dir }}/*.json — the same directory '
    + 'deployProductionOnMerge enqueues into. A glob naming anything else waits for ever, in '
    + 'silence, and production stops moving with every signal on the box still green.');
  assert.ok(!/DirectoryNotEmpty/.test(pathDirectives),
    'the request is written `.<name>.tmp` and renamed (infra/hooks/lib/queue.mjs), so '
    + 'DirectoryNotEmpty fires on a request that does not exist yet');
  assert.equal(value(pathDirectives, 'Unit'), '{{ deploy_request_service_name }}.service');
});

test('the path unit is enabled and the oneshot service is not', () => {
  const enabled = deployTasks.filter((t) => t['ansible.builtin.systemd']?.enabled === true)
    .map((t) => t['ansible.builtin.systemd'].name);
  assert.ok(enabled.includes('{{ deploy_request_path_name }}'),
    'the path unit must be enabled, or it does not survive a reboot and nothing ever starts the '
    + 'service');
  assert.ok(!enabled.some((name) => name.includes('deploy_request_service_name')),
    'a Type=oneshot that is `enabled` runs once at boot and never again — it would deploy on every '
    + 'reboot for no reason and still never deploy on a merge');
});

test('the service runs as the account that holds the sudo wrappers, never the build account', () => {
  assert.equal(value(serviceDirectives, 'User'), '{{ deploy_orchestrator_user }}');
  assert.equal(deployDefaults.deploy_orchestrator_user, 'jamground',
    'the orchestrator account is the one roles/users grants the no-argument wrappers to');
  assert.notEqual(deployDefaults.deploy_orchestrator_user, 'jamground-build',
    'jamground-build holds no sudo at all and could not flip the release symlink');
});

test('NoNewPrivileges is absent, because sudo is setuid', () => {
  assert.ok(!/^NoNewPrivileges=/m.test(serviceDirectives),
    'NoNewPrivileges=yes makes a setuid binary ineffective, so the deploy would die with '
    + '"sudo: effective uid is not 0" before doing anything. It narrows nothing here — the grant '
    + 'is already three fixed commands taking no arguments — and only breaks it. Every other unit '
    + 'in this tree sets it, which is exactly why its absence needs a gate saying it is deliberate.');
});

test('TimeoutStartSec is set, and is longer than the build plus the lock wait', () => {
  const templated = value(serviceDirectives, 'TimeoutStartSec');
  assert.equal(templated, '{{ deploy_request_timeout_sec }}',
    'a Type=oneshot with no TimeoutStartSec gets systemd\'s 90-second default, which kills every '
    + 'automatic deploy part-way through `npm ci && npm run build` and reports it as the script '
    + 'having failed');
  const seconds = deployDefaults.deploy_request_timeout_sec;
  assert.ok(Number.isInteger(seconds) && seconds > 900,
    `deploy_request_timeout_sec is ${seconds}. It must exceed the shared build lock's own 900s `
    + 'wait, because a deploy can be queued behind a preview build before its build even starts.');
});

test('the deploy joins the production slice roles/isolation owns', () => {
  assert.equal(value(serviceDirectives, 'Slice'), '{{ deploy_production_slice }}');
  assert.equal(deployDefaults.deploy_production_slice, isolationDefaults.isolation_production_slice,
    'roles/deploy and roles/isolation name the production slice separately, because a role cannot '
    + 'read a sibling\'s variables. A typo in either is accepted silently by systemd, and the '
    + 'deploy then runs as a child of nothing in particular — with no CPU weight against a preview '
    + 'build beside it.');
});

test('the request directory is one path, named the same in all three places', () => {
  assert.equal(webhookDefaults.webhook_deploy_requests_dir, deployDefaults.deploy_requests_dir,
    'roles/webhook writes it and roles/deploy drains it; two literals that disagree are a queue '
    + 'nothing ever reads');
  assert.match(consumeUnit, /^Environment=JAMGROUND_DEPLOY_REQUESTS=\{\{ webhook_deploy_requests_dir \}\}$/m);
  assert.match(consumeUnit, /^ReadWritePaths=-?\{\{ webhook_deploy_requests_dir \}\}$/m,
    'the consumer runs under ProtectSystem=strict; without this the write fails with EROFS, on '
    + 'the automatic path, and the merge is quarantined for a reason that has nothing to do with '
    + 'the merge');
  assert.match(read('infra/hooks/consume.mjs'), /env\('JAMGROUND_DEPLOY_REQUESTS'/,
    'the runner must read the environment name the unit sets');
  assert.match(read('infra/hooks/lib/consumer.mjs'),
    new RegExp(`DEFAULT_DEPLOY_REQUESTS_DIR = '${deployDefaults.deploy_requests_dir}'`),
    'the module default is what applies when the unit does not set the environment at all — it '
    + 'must be the same directory, not a plausible-looking sibling');
});

test('the three request directories are created with ownership the two accounts can actually use', () => {
  const files = deployTasks.flatMap((t) => {
    const f = t['ansible.builtin.file'];
    if (!f) return [];
    return f.path ? [f] : [];
  });
  const incoming = files.find((f) => f.path === '{{ deploy_requests_dir }}');
  assert.ok(incoming, 'roles/deploy must create the request queue');
  assert.equal(incoming.owner, 'jamground-build', 'the consumer writes here');
  assert.equal(incoming.group, '{{ deploy_orchestrator_user }}');
  assert.equal(incoming.mode, '0770',
    'the reader MOVES files out of this directory, which needs write on the directory itself. '
    + '0750 leaves every merge quarantined, silently, for ever.');

  const looped = deployTasks.find((t) => Array.isArray(t.loop)
    && t.loop.some((item) => item?.path === '{{ deploy_requests_failed_dir }}'));
  assert.ok(looped, 'roles/deploy must create the claimed and failed directories');
  const failed = looped.loop.find((item) => item.path === '{{ deploy_requests_failed_dir }}');
  assert.equal(failed.group, 'jamground-build',
    'jamground-selfcheck runs as jamground-build and counts what is in here — that count is the '
    + 'alarm for a merge that never reached production');
});

test('the runner script names the same directories the role creates', () => {
  const runner = read('infra/ansible/roles/deploy/files/jamground-deploy-requests');
  for (const [name, path] of [
    ['deploy_requests_dir', deployDefaults.deploy_requests_dir],
    ['deploy_requests_claimed_dir', deployDefaults.deploy_requests_claimed_dir],
    ['deploy_requests_failed_dir', deployDefaults.deploy_requests_failed_dir],
  ]) {
    assert.ok(runner.includes(`=${path}\n`),
      `the runner does not name ${path}. It spells its paths out as literals because systemd `
      + `invokes it with no control node in the loop, so ${name} in roles/deploy/defaults and the `
      + 'literal in the script are two declarations that must agree.');
  }
  assert.ok(runner.includes(`=${'/usr/local/sbin/jamground-deploy-now'}\n`),
    'the runner must reach the deploy through the no-argument wrapper, never jamground-deploy '
    + 'directly with an environment it chose');
});
