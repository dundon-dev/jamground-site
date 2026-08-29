/* Reproducibility. Builds twice — once from this working tree, once
 * from a clean `git archive HEAD` checkout — and compares emitted path sets and content
 * hashes. node_modules is linked into the clean checkout (package by package — see
 * lib/build.mjs's `linkNodeModulesInto`, which also keeps Vite's dependency-optimizer cache
 * out of the real, shared node_modules) rather than reinstalled: the property under test is
 * "the entire site can be rebuilt from content/ and the repo alone, with no external state",
 * i.e. no reliance on stray untracked local files, not a claim about install speed — every
 * dependency is already pinned to an exact version. Neither build changes process.cwd(), so
 * both resolve content/ (resolveContentRoot() is cwd-relative) to the same sibling content
 * repository — content reproducibility is a separate claim from this one; this one is about
 * the site repo alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToTempDir, hashTree, cleanup, linkNodeModulesInto } from './lib/build.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('the build is reproducible from a clean checkout — same paths, same bytes', async () => {
  const cloneDir = mkdtempSync(join(tmpdir(), 'jamground-clean-checkout-'));
  const archive = execFileSync('git', ['archive', 'HEAD'], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024 * 64,
  });
  execFileSync('tar', ['-x', '-C', cloneDir], { input: archive });
  linkNodeModulesInto(cloneDir);

  const outA = await buildToTempDir();
  const outB = await buildToTempDir({ root: cloneDir });

  try {
    const hashesA = hashTree(outA);
    const hashesB = hashTree(outB);

    assert.deepEqual(
      [...hashesA.keys()].sort(),
      [...hashesB.keys()].sort(),
      'the repo build and the clean-checkout build emitted different path sets',
    );
    for (const path of hashesA.keys()) {
      assert.equal(
        hashesA.get(path),
        hashesB.get(path),
        `${path} differs between the repo build and the clean-checkout build`,
      );
    }
  } finally {
    cleanup(outA);
    cleanup(outB);
    cleanup(cloneDir);
  }
});
