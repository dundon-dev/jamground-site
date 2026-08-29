/* Route-set equality. The routes derivable
 * from content/ must equal the HTML files dist/ actually contains — every entity produces
 * exactly the route the table says, and dist/ contains nothing that is not derivable from
 * content/. Deliberately scoped to .html files: robots.txt is a static asset, never a route,
 * so it is excluded from the comparison rather than smuggled into "nothing extra". */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToTempDir, listFiles, cleanup } from './lib/build.mjs';
import { deriveExpectedRoutes } from './lib/derive-routes.mjs';

test('the route set derived from content/ equals the HTML files in dist/', async () => {
  const outDir = await buildToTempDir();
  try {
    const actual = listFiles(outDir).filter((f) => f.endsWith('.html'));
    const expected = deriveExpectedRoutes();
    assert.deepEqual(actual.sort(), [...expected].sort());
  } finally {
    cleanup(outDir);
  }
});
