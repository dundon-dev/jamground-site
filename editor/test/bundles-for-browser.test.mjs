/* What actually ships to the browser.
 *
 * The first two tests are the original ones: entry.mjs and lib/change.mjs bundle at all. They
 * pass no `define`, and on their own they assert only that output exists — which is precisely
 * the weakness ../jamground.config.mjs's header used to cite as the reason that module could
 * never read the environment. The last two tests are what removed that weakness, so the
 * config module can be driven from a gitignored `.env` while the tree stays generic:
 *
 *   · the bundle built the way editor/build.mjs builds it carries the deployment's identity as
 *     STRING LITERALS, and no module authored in this repository contributes a `process.env`
 *     to it; and
 *   · the same module bundled with NO `define` at all still resolves — to its committed
 *     placeholders — inside a context that has no `process` global, rather than throwing.
 *
 * HOW "OURS" IS TOLD FROM "VENDORED", which is the whole difficulty. The bundle legitimately
 * contains `process.env` from dependencies we do not author (editor/node_modules/yaml and
 * lib0, three occurrences at the time of writing), so a bare `output.includes('process.env')`
 * would be red on a correct tree, and a hand-tuned occurrence count would be red on the next
 * dependency bump. Neither is a real assertion. Instead the output is split into per-module
 * regions on esbuild's own `// <path>` banners, with the set of valid banner paths taken from
 * esbuild's METAFILE rather than guessed at — so `node_modules` classification is applied to
 * the authoritative list of inputs, and comment lines that merely look like banners (vendored
 * bundles carry plenty) are not mistaken for module boundaries. Every occurrence in the output
 * must fall inside one of those regions, which is what stops the scan from having a blind
 * spot, and none of the regions belonging to an input of ours may contain one.
 *
 * The positive half matters as much: each declared value is defined to a distinct sentinel and
 * that sentinel is asserted to appear in the config module's own region. Without it the scan
 * above would stay green if the module simply stopped reading the environment altogether.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import { browserDefines } from '../build.mjs';
import { declarations } from '../../jamground.config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '..');

/** One distinct, recognisable value per declared variable. Derived from the declarations, so a
 *  seventh value added to the config module is covered here without editing this file. */
const SENTINELS = Object.fromEntries(
  Object.values(declarations).map(({ env }) => [env, `sentinel-${env.toLowerCase()}`]),
);

/** Splits an esbuild bundle into per-module regions, keyed by input path.
 *
 *  A line is a module boundary only when it is `// <p>` AND `<p>` is one of the build's own
 *  inputs; anything else — `// @__NO_SIDE_EFFECTS__`, a vendored bundle's own path comments —
 *  stays inside the region it was found in. */
function regionsOf(text, inputPaths) {
  const regions = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const banner = /^\/\/ (.+)$/.exec(line);
    if (banner && inputPaths.has(banner[1])) {
      current = banner[1];
      if (!regions.has(current)) regions.set(current, []);
      continue;
    }
    if (current !== null) regions.get(current).push(line);
  }
  return regions;
}

const occurrences = (text) => text.split('process.env').length - 1;

test('editor/entry.mjs bundles for browser without jsdom errors', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(editorDir, 'entry.mjs')],
    format: 'esm',
    bundle: true,
    platform: 'browser',
    external: ['https://unpkg.com/*'],
    write: false,
  });
  assert(result.outputFiles, 'Bundle output should be present');
  assert(result.outputFiles.length > 0, 'Bundle should produce output files');
});

test('editor/lib/change.mjs bundles for browser without jsdom errors', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(editorDir, 'lib', 'change.mjs')],
    format: 'esm',
    bundle: true,
    platform: 'browser',
    external: ['https://unpkg.com/*'],
    write: false,
  });
  assert(result.outputFiles, 'Bundle output should be present');
  assert(result.outputFiles.length > 0, 'Bundle should produce output files');
});

test('the shipped bundle carries the identity as literals, and no `process.env` of ours', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(editorDir, 'entry.mjs')],
    format: 'esm',
    bundle: true,
    platform: 'browser',
    external: ['https://unpkg.com/*'],
    // The very map editor/build.mjs passes — imported, not restated, so a define dropped there
    // is dropped here too and this test goes red instead of quietly checking a stale copy.
    define: browserDefines(SENTINELS),
    metafile: true,
    write: false,
  });

  const text = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs);
  const ours = inputs.filter((p) => !p.includes('node_modules/') && !p.startsWith('(disabled):'));
  const regions = regionsOf(text, new Set(inputs));

  // The scan is only worth anything if it found our modules and left no gap. Both are checked
  // before the assertion that depends on them, so a banner format esbuild changed one day
  // fails here — loudly — rather than turning the real assertion vacuously green.
  const configPath = ours.find((p) => p.endsWith('jamground.config.mjs'));
  assert.ok(configPath, `the config module should be an input of the bundle; inputs of ours: ${ours}`);
  for (const p of ours) assert.ok(regions.has(p), `no region found for our own input ${p}`);
  const attributed = [...regions.values()].reduce((n, lines) => n + occurrences(lines.join('\n')), 0);
  assert.equal(attributed, occurrences(text),
    'every `process.env` in the output should fall inside an identified module region — '
    + 'an unattributed one is a blind spot in this scan, not a clean bundle');

  // The assertion itself: nothing we wrote leaves a `process.env` in the browser.
  for (const p of ours) {
    const region = regions.get(p).join('\n');
    assert.equal(occurrences(region), 0,
      `${p} contributes \`process.env\` to the browser bundle: `
      + `${region.split('\n').filter((l) => l.includes('process.env')).join(' | ')}`);
  }

  // And the other half: the defines really did substitute. Without this, a config module that
  // stopped reading the environment at all would pass everything above.
  const configRegion = regions.get(configPath).join('\n');
  for (const { env } of Object.values(declarations)) {
    assert.ok(configRegion.includes(SENTINELS[env]),
      `${env} was not substituted into the bundle — ${configPath} should carry `
      + `${JSON.stringify(SENTINELS[env])} as a literal`);
  }
});

test('with no `define` at all, the config falls back rather than throwing where `process` is absent', async () => {
  // The failure mode the old design was built to avoid, watched directly: a browser has no
  // `process`, so an unsubstituted read must be absent, not a ReferenceError. `vm` gives a
  // context with no `process` global, which is exactly that browser.
  const built = await esbuild.build({
    entryPoints: [path.join(editorDir, '..', 'jamground.config.mjs')],
    format: 'iife',
    globalName: 'jamgroundConfig',
    bundle: true,
    platform: 'browser',
    write: false,
  });
  const context = vm.createContext({});
  assert.equal(vm.runInContext('typeof process', context), 'undefined', 'the context must have no `process`');
  vm.runInContext(built.outputFiles[0].text, context);

  const resolved = vm.runInContext('jamgroundConfig', context);
  for (const [name, { fallback }] of Object.entries(declarations)) {
    assert.equal(resolved[name], fallback,
      `${name} should fall back to its committed placeholder in a browser with no defines`);
  }
});
