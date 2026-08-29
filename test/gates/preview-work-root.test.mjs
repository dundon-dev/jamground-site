/* Invariant: a preview is built INSIDE the site checkout, so Astro's asset rename never crosses a
 * mount point.
 *
 * WHY, precisely — the obvious version of this rule is wrong and cost two rounds on the box.
 *
 * Astro's ssrMoveAssets RENAMES assets out of "<site checkout>/.astro/.prerender/" into the build's
 * out directory. rename(2) refuses to cross a MOUNT POINT. That is a stricter rule than "cannot
 * cross a filesystem", and both halves bit here in turn:
 *
 *   1. /srv/previews is a fixed-size loopback image (roles/isolation) — a genuinely different
 *      filesystem. Building into it failed with EXDEV.
 *   2. Moving the out directory to /var/lib/... on the SAME disk did not fix it. The consumer runs
 *      under ProtectSystem=strict with ReadWritePaths (roles/webhook), and systemd bind-mounts
 *      every ReadWritePath separately — so two writable directories on one disk are two mount
 *      points. Proven on the box: the identical rename(2) succeeds outside the sandbox and returns
 *      EXDEV inside it. (A shell `mv` masks this entirely, because it falls back to copy+unlink on
 *      EXDEV. Node's fs.rename does not, and neither does Astro.)
 *
 * The only placement that holds under both is a subdirectory of the site checkout itself: it is
 * inside the same bind mount as .astro/.prerender by construction. Hence the work root is DERIVED
 * from $JAMGROUND_SITE_CHECKOUT rather than being a path of its own that has to be kept in step.
 *
 * WHY IT IS WORTH GATING. This reproduces on no developer machine, in no unit test, and in no
 * --check run. It needs the loopback image mounted and the systemd sandbox applied. Every gate in
 * this repo stayed green through both failures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const script = read('infra/ansible/roles/isolation/files/jamground-preview-build');
const workRootLine = script.split('\n').find((l) => l.startsWith('work_root='));

test('the work root is derived from the site checkout, not a path of its own', () => {
  assert.ok(workRootLine, 'the script must declare work_root');
  assert.match(workRootLine, /^work_root="\$JAMGROUND_SITE_CHECKOUT\//,
    `work_root is ${workRootLine.trim()}. It must be a subdirectory of $JAMGROUND_SITE_CHECKOUT: `
    + 'Astro renames assets out of that checkout into the out directory, and any other location is '
    + 'a separate mount — either a different filesystem, or a different systemd bind mount under '
    + 'ProtectSystem=strict. Both return EXDEV.');
});

test('the work root is not on the previews image', () => {
  assert.ok(!/previews_root/.test(workRootLine ?? ''),
    'the previews root is a separate loopback filesystem; building into it is the first version of '
    + 'this defect.');
});

test('the finished output is COPIED onto the previews image, never renamed onto it', () => {
  assert.match(script, /cp -a -- "\$work\/dist" "\$staging"/,
    'publishing crosses a real filesystem boundary, so it must copy — a rename there is the same '
    + 'EXDEV, written by us instead of by Astro.');
});

test('the sandbox does not need a writable path the build no longer uses', () => {
  const unit = read('infra/ansible/roles/webhook/templates/jamground-hooks-consume.service.j2');
  assert.ok(!unit.includes('preview_work_root'),
    'the separate work root is gone; a leftover ReadWritePath for it would add a bind mount that '
    + 'is exactly what this invariant exists to avoid.');
});

/* The address the editor hands an editor must be the address nginx actually serves.
 *
 * These are two independent derivations of one string — `previewUrlFor` in jamground.config.mjs,
 * and the server_name regex in roles/nginx — and nothing else compares them. If they drift, the
 * editor shows a confident link to a host that resolves and 404s, which reads as "the preview
 * feature is broken" rather than as a configuration error, and no gate on the box would fire.
 */
test('the preview URL the editor shows matches the host nginx serves', async () => {
  const { previewUrlFor } = await import('../../jamground.config.mjs');
  const url = new URL(previewUrlFor(42));
  const conf = read('infra/ansible/roles/nginx/templates/nginx.conf.j2');

  assert.equal(url.protocol, 'https:', 'the certificate covers the preview names; the link must use them');
  assert.match(url.hostname, /^pr-42\.preview\./,
    `previewUrlFor(42) produced host ${url.hostname}; nginx matches ^pr-<digits>.preview.<domain>$`);
  assert.match(conf, /server_name\s+~\^pr-\(\?<prnum>\[0-9\]\+\)\\\.preview\\\./,
    'the nginx preview server_name no longer has the shape previewUrlFor builds against');
  assert.equal(url.pathname, '/', 'the preview root is what is served; a deeper path may not exist');
});
