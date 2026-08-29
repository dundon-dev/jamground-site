/* Invariant: the slice roles/webhook puts the queue consumer into is a slice roles/isolation
 * actually creates.
 *
 * WHY THIS EXISTS. The consumer invokes jamground-preview-build directly rather than starting
 * jamground-preview-build@<N>.service — it runs as jamground-build, which holds no sudo, and
 * `systemctl start` on an instance is an argument-taking privileged command this box deliberately
 * does not grant. The consequence is that the per-build unit's own MemoryMax and RuntimeMaxSec do
 * NOT apply on the automatic path. The slice is the only thing that still does, because every
 * build is a child process of the consumer and inherits its slice.
 *
 * WHY IT IS WORTH GATING. Getting this wrong is silent in the worst direction. systemd creates a
 * slice on demand from the name in a unit file, so a typo does not fail — it produces a real,
 * separate, UNCAPPED slice, the unit starts, `systemctl status` is green, and the first preview
 * build large enough to matter competes with production for memory on a box with nothing left to
 * stop it. The failure surfaces as the site going down, at build time, with nothing anywhere
 * naming the cause. Repeating the literal is the tree's convention for a value two roles need;
 * gating it is the tree's convention for a repeated literal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const valueOf = (yaml, key) => {
  const line = yaml.split('\n').find((l) => l.startsWith(`${key}:`));
  assert.ok(line, `${key} is not declared`);
  return line.slice(key.length + 1).trim();
};

test('the consumer runs in a slice roles/isolation actually creates', () => {
  const webhook = valueOf(read('infra/ansible/roles/webhook/defaults/main.yml'), 'webhook_preview_slice');
  const isolation = valueOf(read('infra/ansible/roles/isolation/defaults/main.yml'), 'isolation_preview_slice');
  assert.equal(webhook, isolation,
    `roles/webhook puts the consumer in "${webhook}" but roles/isolation creates "${isolation}". `
    + 'systemd would create the first name on demand as a separate, uncapped slice: the unit starts, '
    + 'status is green, and preview builds run with no memory ceiling beside production.');
});

test('the consume unit actually joins that slice', () => {
  const unit = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.service.j2');
  assert.match(unit, /^Slice=\{\{ webhook_preview_slice \}\}$/m,
    'the consume unit must set Slice, or every preview build it spawns is uncapped');
});

test('the slice it names is the one carrying the aggregate memory cap', () => {
  const slice = read('infra/ansible/roles/isolation/templates/jamground-preview.slice.j2');
  assert.match(slice, /^MemoryMax=/m, 'the preview slice must cap memory, or joining it buys nothing');
});
