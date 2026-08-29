/* Invariant: a preview is BUILT on the same filesystem as the site checkout, and only its finished
 * output crosses onto the previews image.
 *
 * WHY. roles/isolation mounts a fixed-size loopback image at isolation_previews_root so previews
 * can never fill the disk. Astro's own ssrMoveAssets step RENAMES assets out of the site
 * checkout's .astro/.prerender/ into the build's out directory, and rename(2) cannot cross a mount
 * point. So an out directory under the previews root fails — every time, for every preview:
 *
 *   EXDEV: cross-device link not permitted, rename
 *     '<site checkout>/.astro/.prerender/_astro/BaseLayout.*.css' -> '<previews>/…/_astro/…'
 *
 * WHY IT IS WORTH GATING. The error surfaces from inside Astro, names neither this script nor a
 * mount point, and arrives only on a box where the image is actually mounted — never on a
 * developer's machine and never in check mode. This exact defect shipped, converged clean, and was
 * found only by running a real preview build on the box. Anyone tidying the work directory back
 * under the previews root would reintroduce it, and every gate in this repo would stay green.
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

const isolation = read('infra/ansible/roles/isolation/defaults/main.yml');
const script = read('infra/ansible/roles/isolation/files/jamground-preview-build');

test('the work root is not on the previews filesystem', () => {
  const previews = valueOf(isolation, 'isolation_previews_root');
  const work = valueOf(isolation, 'isolation_preview_work_root');
  assert.ok(!work.startsWith(`${previews}/`) && work !== previews,
    `isolation_preview_work_root (${work}) is under isolation_previews_root (${previews}), which is a `
    + 'separate mount. Astro renames assets out of the site checkout into the out directory, and '
    + 'rename(2) cannot cross a mount point: every preview build would die with EXDEV inside Astro.');
});

test('the script builds into that work root, not into the previews root', () => {
  const workRoot = script.split('\n').find((l) => l.startsWith('work_root='));
  assert.ok(workRoot, 'the script must declare work_root');
  assert.ok(!workRoot.includes('previews_root'),
    `work_root is derived from previews_root (${workRoot.trim()}), which puts the build output on the `
    + 'previews mount and reintroduces the EXDEV failure.');
  assert.equal(workRoot.trim(), `work_root=${valueOf(isolation, 'isolation_preview_work_root')}`,
    'the script and the role must name the same work root; the role is what creates the directory');
});

test('the finished output is COPIED onto the previews image, never renamed onto it', () => {
  assert.match(script, /cp -a -- "\$work\/dist" "\$staging"/,
    'publishing must copy across the device boundary — a mv from the work root to the previews '
    + 'root is the same cross-device rename, just written by us instead of by Astro.');
  assert.ok(!/mv -T -- "\$work\/[^"]*" "\$(live|previews_root)/.test(script),
    'nothing may be renamed directly from the work root onto the previews root');
});
