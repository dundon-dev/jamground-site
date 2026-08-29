/* No @wordpress/*, @wp-playground/* or /php/ package may appear in the
 * production dependency closure. Dev-only is permitted — @wordpress/blocks is a test
 * dependency, and this check is about what runs on a server we operate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isBanned, productionDependencyClosure } from './lib/dependency-closure.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('no @wordpress/*, @wp-playground/* or /php/ package in the production dependency closure', () => {
  const closure = productionDependencyClosure(projectRoot);
  const bannedFound = [...closure.keys()].filter(isBanned);
  assert.deepEqual(bannedFound, []);
});

test('every production dependency actually resolves — an unresolved name would silently pass the ban check above', () => {
  const closure = productionDependencyClosure(projectRoot);
  const unresolved = [...closure.entries()].filter(([, dir]) => dir === null).map(([name]) => name);
  assert.deepEqual(unresolved, []);
});

test('isBanned recognises the three named patterns, and only the three — proves the check above is not vacuous', () => {
  assert.equal(isBanned('@wordpress/blocks'), true);
  assert.equal(isBanned('@wp-playground/cli'), true);
  assert.equal(isBanned('php'), true);
  assert.equal(isBanned('@acme/php'), true);
  assert.equal(isBanned('astro'), false);
  assert.equal(isBanned('phpmyadmin-lookalike'), false); // no path-segment boundary — must not false-positive
});
