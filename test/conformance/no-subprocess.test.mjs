/* The build spawns no subprocess. Every
 * child_process.* entry point is patched to throw, and the build must still succeed — this
 * is what turns "no PHP *runs*" from a claim into a test, and it also catches a dependency
 * shelling out.
 *
 * esbuild needs one documented exception: a load-bearing claim about an external
 * system deserves verification before the code that depends on it relies on it. esbuild's Node API
 * keeps a single long-lived native-binary service per process (`longLivedService` in
 * esbuild/lib/main.js) and spawns it exactly once, over stdio, reusing it for every later
 * transform. Astro's own `vite-plugin-import-meta-env` calls `esbuild.transform` on Astro's
 * OWN runtime files during every build, unconditionally — proven by patching child_process
 * with no warm-up first: the very first `astro build()` call then fails on
 * `child_process.spawn` from inside esbuild, before any of this repo's own code runs. That
 * proves the spawn is the JS toolchain's one-time bootstrap, not something a dependency does
 * during the build, so warming the service up before patching isolates exactly what this
 * assertion is for. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cp from 'node:child_process';
import { transform } from 'esbuild';
import { buildToTempDir, cleanup } from './lib/build.mjs';

const GUARDED = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];

test('the build spawns no subprocess', async () => {
  await transform('', { loader: 'js' }); // starts esbuild's one-time native service; see above

  const originals = {};
  for (const name of GUARDED) {
    originals[name] = cp[name];
    cp[name] = new Proxy(cp[name], {
      apply() {
        throw new Error(`child_process.${name} was called during the build`);
      },
    });
  }

  let outDir;
  try {
    outDir = await buildToTempDir();
  } finally {
    for (const name of GUARDED) cp[name] = originals[name];
  }

  assert(
    existsSync(join(outDir, 'en-us/index.html')),
    'the build must actually have produced output, not merely resolved',
  );
  cleanup(outDir);
});
