/* Invariant: the path unit watches the directory the receiver actually writes into.
 *
 * WHY THIS IS WORTH A GATE. Every failure mode here is silent. systemd loads a `.path` unit whose
 * PathExistsGlob names a directory that does not exist without complaint — it simply waits, for
 * ever, for a file that will never appear there. `systemctl status` is green. The receiver keeps
 * returning 202. Jobs keep landing in the real queue. And the five-minute timer picks them up, so
 * the pipeline still works — just at the latency this unit exists to remove, with nothing anywhere
 * reporting that the fast path is dead.
 *
 * That is the same shape as the defect that started this: a receiver nothing routed to, healthy by
 * every local signal, discovered only from GitHub's delivery log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const pathUnit = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.path.j2');

/* Directives only. The unit's own comments explain which systemd options were rejected and why,
 * so a naive scan of the whole file finds `DirectoryNotEmpty` in the paragraph arguing against it
 * and fails on the explanation rather than on the configuration. Caught by this gate failing on
 * its first run — the same lesson check-config learned when it flagged its own literal list. */
const directives = pathUnit
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  .join('\n');
const timer = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.timer.j2');
const tasks = read('infra/ansible/roles/webhook/tasks/main.yml');
const service = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.service.j2');

test('the path unit watches the queue the receiver writes to', () => {
  const glob = /^PathExistsGlob=(.+)$/m.exec(directives);
  assert.ok(glob, 'the path unit must declare PathExistsGlob');
  assert.equal(glob[1], '{{ webhook_queue_dir }}/*.json',
    `the path unit watches ${glob[1]}. It must watch {{ webhook_queue_dir }}/*.json — the same `
    + 'variable the service is handed as WEBHOOK_QUEUE_DIR and the receiver writes into. A unit '
    + 'watching anywhere else loads cleanly and never fires.');
  assert.match(service, /Environment=WEBHOOK_QUEUE_DIR=\{\{ webhook_queue_dir \}\}/,
    'the service must read the same variable the path unit watches');
});

test('it starts the consumer service, not something else', () => {
  assert.match(directives, /^Unit=\{\{ webhook_consumer_service_name \}\}\.service$/m,
    'the path unit must start the consumer service by its declared name');
});

test('it matches the final job name, never the temp file mid-rename', () => {
  assert.ok(!/DirectoryNotEmpty/.test(directives),
    'DirectoryNotEmpty fires on the `.<name>.tmp` file enqueue writes before renaming it into '
    + 'place (infra/hooks/lib/queue.mjs), which is a job that does not exist yet. The glob must '
    + 'match only the final `.json` name.');
});

test('the path unit is installed and enabled, not merely templated', () => {
  assert.match(tasks, /dest: "\/etc\/systemd\/system\/\{\{ webhook_consumer_path_name \}\}"/,
    'the path unit must be shipped to /etc/systemd/system');
  assert.match(tasks, /name: "\{\{ webhook_consumer_path_name \}\}"[\s\S]{0,120}enabled: true/,
    'a shipped-but-not-enabled path unit is exactly the silent failure this gate exists for');
});

test('the timer remains, as the backstop a path unit cannot replace', () => {
  const interval = /^OnUnitActiveSec=(.+)$/m.exec(timer);
  assert.ok(interval, 'the timer must keep an interval');
  assert.notEqual(interval[1], '1min',
    'the timer is no longer the mechanism; leaving it at the old interval means the path unit '
    + 'buys nothing measurable and its failure stays invisible');
});
