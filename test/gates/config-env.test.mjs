/* Invariant: each of the six values jamground.config.mjs declares is really driven by the
 * variable it says it reads, and really falls back to the placeholder it says it falls back to.
 *
 * This is the gate that makes `.env` work at all, and it exists because nothing else can see
 * the defect it catches. Every variable's name is written twice — once as the static member
 * expression `process.env.JAMGROUND_…` (static because that is the only form esbuild's
 * `define` substitutes) and once, by rule rather than by hand, in the `declarations` table that
 * tools/check-config.mjs and editor/build.mjs read. A misspelt read leaves both halves of the
 * repository internally consistent and self-describing: `declarations` names the variable the
 * deploy side also names, so check-config's Rule A is green, the module still resolves to its
 * placeholder, and every other test passes. The only symptom is that the operator fills in
 * their `.env` and that one value silently does not move.
 *
 * So the variables are set for real, in a child process, and the exports are watched changing.
 * The mirror case matters as much: with all six removed from the environment, each export must
 * be exactly the fallback `declarations` advertises — which is what Rule A compares against
 * group_vars/all.yml, and would otherwise be a claim nothing checked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { declarations } from '../../jamground.config.mjs';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '../../jamground.config.mjs');

/** Imports the config module in a child process with exactly `env`, and returns its exports.
 *  A child process because a module is evaluated once per process: the six are resolved at
 *  import time, so mutating `process.env` in this one would change nothing. */
const resolveWith = (env) => JSON.parse(execFileSync(
  process.execPath,
  ['-e', `import(${JSON.stringify(pathToFileURL(CONFIG).href)}).then((c) => console.log(JSON.stringify({ ...c })));`],
  { encoding: 'utf8', env },
));

/** The ambient environment with all six removed — a clean clone that configured nothing. */
const withoutTheSix = () => {
  const env = { ...process.env };
  for (const { env: variable } of Object.values(declarations)) delete env[variable];
  return env;
};

test('every declared value falls back to exactly the placeholder it advertises', () => {
  const resolved = resolveWith(withoutTheSix());
  for (const [name, { fallback }] of Object.entries(declarations)) {
    assert.equal(resolved[name], fallback,
      `${name} should fall back to ${JSON.stringify(fallback)} — the value check-config compares `
      + 'against infra/ansible/group_vars/all.yml');
  }
});

test('every declared value is really driven by the variable it names', () => {
  // All six at once, each to a distinct value, so a read wired to the wrong one of the six is
  // caught as surely as a read wired to nothing.
  const env = withoutTheSix();
  const expected = {};
  for (const [name, { env: variable }] of Object.entries(declarations)) {
    expected[name] = `driven-by-${variable.toLowerCase()}`;
    env[variable] = expected[name];
  }

  const resolved = resolveWith(env);
  for (const [name, { env: variable }] of Object.entries(declarations)) {
    assert.equal(resolved[name], expected[name],
      `setting ${variable} should change \`${name}\`; it did not, so the module does not read `
      + 'the variable its declarations table says it reads');
  }

  // And the derived values follow, which is the property a fork is actually buying: six
  // variables, everything else by rule.
  assert.equal(resolved.siteUrl, `https://${expected.domain}`);
  assert.equal(resolved.editorOrigin, `https://edit.${expected.domain}`);
  assert.equal(resolved.editorRedirectUri, `https://edit.${expected.domain}/`);
  assert.equal(resolved.contentRepoSlug, `${expected.githubOrg}/${expected.contentRepo}`);
  assert.equal(resolved.siteRepoSlug, `${expected.githubOrg}/${expected.siteRepo}`);
});

test('an empty variable means unset, on this side as on the Ansible side', () => {
  // `JAMGROUND_DOMAIN=` is a real thing to find in a half-filled `.env`. Ansible's
  // `| default(…, true)` treats it as unset; this side must agree, or the two halves would
  // disagree about a blank line and only the converge would notice.
  const env = withoutTheSix();
  for (const { env: variable } of Object.values(declarations)) env[variable] = '';

  const resolved = resolveWith(env);
  for (const [name, { fallback }] of Object.entries(declarations)) {
    assert.equal(resolved[name], fallback, `an empty ${name} should fall back, not blank out`);
  }
});
