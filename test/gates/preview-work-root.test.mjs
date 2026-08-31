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

/* Invariant: a preview host and production answer `/` identically.
 *
 * WHY THIS IS A SEPARATE TEST FROM THE ONE ABOVE, WHICH ALMOST CAUGHT IT. That test asserts the
 * editor's link points at `/` — "the preview root is what is served" — and that nginx has a
 * server_name shaped to receive it. Neither half asks whether anything ANSWERS `/`, and nothing
 * else did either: this site emits no bare-root index.html (only the default locale's, which
 * jamground-deploy and jamground-preview-build each assert on), so `/` on a preview host fell
 * through try_files with no index and nginx answered 403. Measured on the box, 2026-08-31:
 * https://<domain>/ was 301 and https://pr-14.preview.<domain>/ was 403, while
 * https://pr-14.preview.<domain>/en-us/ was 200 — the preview was built and correct the whole
 * time, at every address except the one the editor was handed.
 *
 * WHY IT IS DERIVED RATHER THAN LITERAL. Asserting `/en-us/` here would let production and
 * preview drift apart the moment Settings.defaultLocale changed in one of the four infra files
 * that hard-code it. The invariant is not "preview redirects to /en-us/", it is "preview
 * redirects wherever production redirects", so the expected value is read off the production
 * blocks in the same file.
 *
 * verify/nginx.yml asserts the same property against the RENDERED configuration on the box, with
 * a preview Host header — this gate is the offline half, that one is the half that would notice a
 * template that never converged.
 */

/** Every `server { … }` block in the template, as raw text. They all sit at one indent level and
 *  none nests another, so cutting at the first line that closes at that indent is exact — there
 *  is no brace counting to get wrong, and a future nested block would fail loudly here rather
 *  than being silently truncated. */
function serverBlocks(conf) {
  return conf.split(/^ {4}server \{$/m).slice(1).map((rest) => {
    const end = rest.indexOf('\n    }');
    assert.notEqual(end, -1, 'a server block in nginx.conf.j2 is not closed at its own indent');
    return rest.slice(0, end);
  });
}

/** The redirect, with its target captured. Written to match the one-line form the template uses
 *  on both sides, so a reformat that split it across lines fails here and is looked at rather
 *  than passing on a laxer pattern. */
const ROOT_REDIRECT = /location = \/ \{ return 301 (\S+); \}/;

test('a preview host answers / exactly as production does', () => {
  const conf = read('infra/ansible/roles/nginx/templates/nginx.conf.j2');
  const blocks = serverBlocks(conf);

  const production = blocks.filter((b) => /server_name\s+\{\{ nginx_domain \}\};/.test(b));
  const previews = blocks.filter((b) => /server_name\s+~\^pr-/.test(b));

  assert.equal(production.length, 2,
    `found ${production.length} production server blocks, expected 2 (plain and TLS). The `
    + 'expected redirect target below is read off them, so a change in their number means this '
    + 'gate is no longer reading what it thinks it is.');
  assert.equal(previews.length, 2,
    `found ${previews.length} preview server blocks, expected 2 (plain and TLS).`);

  const targets = new Set(production.map((block) => {
    const match = ROOT_REDIRECT.exec(block);
    assert.ok(match, 'a production server block has no `location = / { return 301 …; }` — this '
      + 'gate derives the expected preview target from it, and the site has no bare-root '
      + 'index.html for try_files to find either way.');
    return match[1];
  }));
  assert.equal(targets.size, 1,
    `the two production server blocks redirect / to different places (${[...targets].join(', ')})`);
  const [expected] = targets;

  for (const block of previews) {
    const match = ROOT_REDIRECT.exec(block);
    assert.ok(match,
      'a preview server block has no `location = / { return 301 …; }`. Without it `/` on '
      + `pr-<N>.preview.<domain> falls through try_files to a root with no index.html and nginx `
      + `answers 403 — and that is the exact URL jamground.config.mjs's previewUrlFor() gives an `
      + 'editor, so the whole preview feature reads as broken while the preview behind it is '
      + 'fine. Production redirects to ' + expected + '; this block must too.');
    assert.equal(match[1], expected,
      `a preview server block redirects / to ${match[1]} while production redirects to `
      + `${expected}. The two must answer / identically, or a change looks fine in preview and `
      + 'broken in production, or the reverse.');
  }
});
