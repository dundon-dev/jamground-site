/* Invariant: no `JAMGROUND_*` name means a FILESYSTEM PATH to the box and a REPOSITORY NAME to
 * the build.
 *
 * The two halves meet in one process. roles/content_repos hands jamground-deploy an environment;
 * jamground-deploy runs `npm run build` inside it; the build resolves jamground.config.mjs from
 * that same environment. A name used for two things there is not a style problem — it is one
 * meaning silently overwriting the other, in the one place where nothing is left to notice.
 *
 * That is what happened. The deploy side needed the two CHECKOUT DIRECTORIES and called them
 * JAMGROUND_SITE_REPO and JAMGROUND_CONTENT_REPO; jamground.config.mjs reads those same two names
 * as the two REPOSITORY NAMES. On the box the build therefore resolved
 *
 *     contentRepoSlug = <org>//srv/jamground/repos/content
 *
 * — a GitHub path that addresses nothing. Nothing went red, because `astro build` happens to
 * consume only `siteUrl` today. A defect that is silent for as long as nobody reaches for a slug
 * is worse than one that fails, not better: it waits.
 *
 * So this gate restates no name. It reads the environment the converge actually hands the script
 * out of the converge, and the names the script itself consumes out of the script, and asserts:
 *
 *   (a) none of them is one of the six `jamground.config.mjs` declares — the deploy side's
 *       path-valued names and the build side's identity names are disjoint sets; and
 *   (b) resolving jamground.config.mjs INSIDE that environment yields `org/repo` slugs — one
 *       slash each, the separator, and nothing else.
 *
 * (b) is the property that was actually violated, and (a) is why. Renaming either side back onto
 * the other turns both red.
 *
 * The same subject from the other end: roles/deploy templates /etc/jamground/deploy.env, which is
 * where the box learns the six in the first place — the operator's `.env` never leaves their
 * machine. That file is mode 0644 on a box running an unprivileged build account, so what may
 * appear in it is a security property and not a matter of taste. The last test here holds it to
 * exactly the six, each rendered from a value group_vars/all.yml declares: a secret cannot be
 * added to it without failing, which is what lets the template say "never" and mean it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { declarations } from '../../jamground.config.mjs';

const require = createRequire(import.meta.url);
const YAML = require('yaml');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG = join(ROOT, 'jamground.config.mjs');
const TASKS = join(ROOT, 'infra/ansible/roles/content_repos/tasks/main.yml');
const DEFAULTS = join(ROOT, 'infra/ansible/roles/content_repos/defaults/main.yml');
const SCRIPT = join(ROOT, 'infra/ansible/roles/deploy/files/jamground-deploy');
const IDENTITY = join(ROOT, 'infra/ansible/roles/deploy/templates/deploy.env.j2');
const GROUP_VARS = join(ROOT, 'infra/ansible/group_vars/all.yml');

/** The six variables jamground.config.mjs reads, derived from its own declarations table rather
 *  than listed — the same source tools/check-config.mjs and editor/build.mjs read, so a seventh
 *  value added there is covered here the day it is added. */
const IDENTITY_VARIABLES = new Set(Object.values(declarations).map(({ env }) => env));

/** Imports the config module in a child process with exactly `env`, and returns its exports. A
 *  child process because a module is evaluated once per process: the six are resolved at import
 *  time, so mutating `process.env` in this one would change nothing. (test/gates/config-env.test.mjs
 *  resolves the same module the same way, for its own, different subject.) */
const resolveWith = (env) => JSON.parse(execFileSync(
  process.execPath,
  ['-e', `import(${JSON.stringify(pathToFileURL(CONFIG).href)}).then((c) => console.log(JSON.stringify({ ...c })));`],
  { encoding: 'utf8', env },
));

/** The ambient environment with all six removed — a box that has not been told its identity. */
const withoutTheSix = () => {
  const env = { ...process.env };
  for (const variable of IDENTITY_VARIABLES) delete env[variable];
  return env;
};

/** Expands `{{ name }}` against a role's own defaults, repeatedly, so a default defined in terms
 *  of another default resolves to the literal the box actually gets.
 *
 *  Strict on purpose: anything left unexpanded fails here rather than reaching the assertions as
 *  a `{{ … }}` string, which contains no `/` and would satisfy the slug assertion below for
 *  entirely the wrong reason. A gate that can pass by failing to read its subject is not a gate. */
function expand(raw, vars, where) {
  let out = String(raw);
  for (let i = 0; i < 10 && out.includes('{{'); i += 1) {
    out = out.replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
      (whole, name) => (name in vars ? String(vars[name]) : whole),
    );
  }
  assert.ok(!out.includes('{{'), `${where}: ${JSON.stringify(String(raw))} did not expand against `
    + `${relative(ROOT, DEFAULTS)}; this gate cannot tell what the box is actually handed`);
  return out;
}

/** Every variable the converge puts into jamground-deploy's environment, expanded to the literal
 *  the box gets. Read out of roles/content_repos, never restated, so this gate cannot drift from
 *  the converge it is about. */
function environmentTheConvergeHandsTheBuild() {
  const tasks = YAML.parse(readFileSync(TASKS, 'utf8'));
  const defaults = YAML.parse(readFileSync(DEFAULTS, 'utf8'));
  assert.ok(Array.isArray(tasks), `${relative(ROOT, TASKS)} did not parse to a list of tasks`);

  const env = {};
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !task.environment) continue;
    for (const [name, raw] of Object.entries(task.environment)) {
      env[name] = expand(raw, defaults, `${relative(ROOT, TASKS)} → ${name}`);
    }
  }
  assert.notDeepEqual(env, {}, `${relative(ROOT, TASKS)} declares no \`environment:\` at all, so `
    + 'this gate would be asserting about an empty environment and proving nothing');
  return env;
}

/** Shell comments stripped: a name written in prose is documentation, not consumption. The rule
 *  is `#` at the start of a line or after whitespace, which is what this script's comments look
 *  like — an approximation, and a safe one here because nothing in it quotes a `#`. */
const withoutComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

/** Every `JAMGROUND_*` name jamground-deploy itself consumes: what it requires, what it reads and
 *  what it exports onward to the build. Each of these is path-valued by construction — the script
 *  deals in directories — which is why none of them may be one of the six. */
function namesTheDeployScriptConsumes() {
  const text = withoutComments(readFileSync(SCRIPT, 'utf8'));
  const found = [...new Set(text.match(/JAMGROUND_[A-Z0-9_]+/g) ?? [])];
  assert.notDeepEqual(found, [], `${relative(ROOT, SCRIPT)} names no JAMGROUND_* variable at all, `
    + 'so this gate is reading the wrong file or the script no longer takes its inputs that way');
  return found;
}

test('the paths the box deals in are named apart from the six the build reads', () => {
  const converge = Object.keys(environmentTheConvergeHandsTheBuild());
  const script = namesTheDeployScriptConsumes();

  for (const [where, names] of [[relative(ROOT, TASKS), converge], [relative(ROOT, SCRIPT), script]]) {
    const collisions = names.filter((name) => IDENTITY_VARIABLES.has(name));
    assert.deepEqual(collisions, [], `${where} uses ${collisions.join(', ')} for a FILESYSTEM PATH, `
      + 'but jamground.config.mjs reads that same name as a REPOSITORY NAME. Both are resolved in '
      + 'one environment on the box — the deploy sets it, the build then reads it — so the build '
      + 'would take a checkout directory for a repository name. Name the checkout directories '
      + 'something the build does not read (JAMGROUND_*_CHECKOUT); do not change the meaning of '
      + 'the six, which .env, .env.example and group_vars/all.yml all share.');
  }
});

test('resolving the config in the box\'s own environment yields org/repo slugs, not paths', () => {
  // Exactly what the box has after the converge: the checkout paths set, and nothing else — the
  // six then fall back to the placeholders a tree that configured nothing gets.
  const env = { ...withoutTheSix(), ...environmentTheConvergeHandsTheBuild() };
  const resolved = resolveWith(env);

  for (const slug of ['contentRepoSlug', 'siteRepoSlug']) {
    const parts = resolved[slug].split('/');
    assert.equal(parts.length, 2, `${slug} resolved to ${JSON.stringify(resolved[slug])} in the `
      + 'environment the converge hands the build. A slug is `org/repo` and holds exactly one '
      + 'slash; this one holds a filesystem path, so some variable means a checkout directory to '
      + 'the deploy side and a repository name to the build side.');
    assert.ok(parts.every((part) => part.length > 0),
      `${slug} resolved to ${JSON.stringify(resolved[slug])}, which has an empty half`);
  }

  assert.equal(resolved.contentRepoSlug, `${resolved.githubOrg}/${resolved.contentRepo}`);
  assert.equal(resolved.siteRepoSlug, `${resolved.githubOrg}/${resolved.siteRepo}`);
});

test('the identity and the checkout paths coexist in one environment', () => {
  // The box carries both after a converge: /etc/jamground/deploy.env declares the six, and
  // roles/content_repos adds the checkout paths on top. The identity must survive that — which
  // is only true while the two sets of names are disjoint.
  const env = withoutTheSix();
  const identity = {};
  for (const [name, { env: variable }] of Object.entries(declarations)) {
    identity[name] = `identity-${name.toLowerCase()}`;
    env[variable] = identity[name];
  }
  const resolved = resolveWith({ ...env, ...environmentTheConvergeHandsTheBuild() });

  assert.equal(resolved.contentRepoSlug, `${identity.githubOrg}/${identity.contentRepo}`,
    'the checkout paths overwrote the identity the box was given');
  assert.equal(resolved.siteRepoSlug, `${identity.githubOrg}/${identity.siteRepo}`,
    'the checkout paths overwrote the identity the box was given');
  assert.equal(resolved.siteUrl, `https://${identity.domain}`);
});

/** The `KEY=value` assignments the identity template renders, its comment block excluded. */
function identityFileDeclarations() {
  const declared = new Map();
  for (const line of readFileSync(IDENTITY, 'utf8').split('\n')) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (assignment) declared.set(assignment[1], assignment[2].trim());
  }
  return declared;
}

test('the identity file the converge writes declares the six, and nothing else', () => {
  const declared = identityFileDeclarations();
  const groupVars = YAML.parse(readFileSync(GROUP_VARS, 'utf8'));

  assert.deepEqual([...declared.keys()].sort(), [...IDENTITY_VARIABLES].sort(),
    `${relative(ROOT, IDENTITY)} must declare exactly the six values jamground.config.mjs reads. `
    + 'Fewer, and the build silently resolves the missing one to its committed placeholder and '
    + 'says so in every canonical URL it emits. More, and something is being published at mode '
    + '0644 to every account on a box that runs an unprivileged build user and a webhook '
    + 'receiver — which is how a secret gets into a file that is not supposed to hold one.');

  for (const [name, value] of declared) {
    const reference = /^\{\{\s*(jamground_[a-z0-9_]+)\s*\}\}$/.exec(value);
    assert.ok(reference, `${relative(ROOT, IDENTITY)} renders ${name} from ${JSON.stringify(value)}. `
      + 'Each of the six must be one bare reference to a group_vars value and nothing else — that '
      + 'is what keeps a lookup of a secret file, or a literal, out of a world-readable file.');
    assert.ok(reference[1] in groupVars, `${relative(ROOT, IDENTITY)} renders ${name} from `
      + `${reference[1]}, which ${relative(ROOT, GROUP_VARS)} does not declare; it would render `
      + 'empty, and the build would take that as unset and use the placeholder.');
  }
});
