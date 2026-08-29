#!/usr/bin/env node
/**
 * check-config — the deployment's identity is declared twice, and this is what stops the two
 * declarations from becoming one declaration and one lie.
 *
 * A fork sets six values. They are needed at two different times, on two different machines,
 * with no shared runtime between them: at BUILD time by Astro and by the editor bundle
 * (`jamground.config.mjs`), and at DEPLOY time by Ansible
 * (`infra/ansible/group_vars/all.yml`). Neither can read the other. So both hold the values,
 * and this gate is the thing that makes the pair safe.
 *
 *   RULE A — the two DECLARATIONS agree on all six: the same environment variable, and the
 *            same fallback behind it.
 *            Drift here fails nothing on its own: the site would build for one domain while
 *            the box was converged for another, and each half would look correct in
 *            isolation. That is the failure this rule exists for.
 *
 *            WHAT IT COMPARES, AND WHY NOT THE VALUES. Both halves are now env-driven: the
 *            module resolves `process.env.JAMGROUND_DOMAIN` and falls back to a committed
 *            placeholder, and group_vars/all.yml does `lookup('env', 'JAMGROUND_DOMAIN') |
 *            default('example.com', true)` for the same reason — so the tree can stay generic
 *            while an operator drives a real deployment from a gitignored `.env`. Comparing
 *            what the two RESOLVE TO would then be a tautology: one process, one environment,
 *            two sides reading the same variable at the same moment necessarily agree, and the
 *            rule would report success it did no work for. It would also go RED, wrongly, the
 *            moment the deploy side were parsed as the literal Jinja text it is.
 *
 *            So this rule never resolves either side. It reads the build side's declaration
 *            table (`declarations`, exported by jamground.config.mjs) and parses the deploy
 *            side's `lookup(...) | default(..., true)` out of the YAML as text, and compares
 *            the two pairs: VARIABLE NAME, then FALLBACK. Setting or unsetting anything in the
 *            environment cannot change its verdict — which is the point. A side that reads no
 *            variable at all (a plain literal, as the gate's own fixture tree still uses) is a
 *            declaration too, with a null variable, and is compared the same way: literal
 *            against literal, and env-driven against plain-literal is itself a disagreement.
 *
 *   RULE B — no retired identity literal survives anywhere in code or config.
 *            The reference deployment's domain, org, client id, VPS address, Cloudflare zone,
 *            bot account and author name are listed below and must appear nowhere. Bare
 *            `dundon.dev` is on the list SEPARATELY from `jamground.dundon.dev` on purpose: a
 *            search-and-replace of the long name leaves the apex behind, and a gate that knew
 *            only the long name would pass straight over it.
 *
 * WHAT THIS GATE DOES NOT CHECK — read this before trusting it.
 *
 *   It does not scan itself. `tools/check-config.mjs` is the file that spells out every
 *   forbidden literal; a gate that scanned its own list could never be green. Excluded by
 *   name — its test imports the list from here rather than repeating it, so nothing else
 *   needs that exemption.
 *
 *   It does not scan `.env`. That file is gitignored and holds the OPERATOR'S REAL VALUES by
 *   design — a real domain, a real org, a real client id — so scanning it would turn this gate
 *   red on entirely correct usage, which is the one thing that would teach people to stop
 *   running it. `.env.example` is deliberately NOT exempt: it is committed, and must stay free
 *   of real values like every other tracked file.
 *
 *   It does not scan generated or vendored trees (`node_modules/`, `dist/`, `editor/dist/`,
 *   `.astro/`, `.git/`), nor binary payloads, which are not authored here.
 *
 *   Matching is case-sensitive and literal — plain substrings, no regex, no normalisation.
 *   `Newfold` and `dundon-newfold` are two entries because they are two literals.
 *
 * It is entirely offline: it reads files and imports one local module. It never opens a
 * socket and never touches the box.
 *
 * Usage: node tools/check-config.mjs [--json] [--root DIR]
 * Exit codes: 0 clean · 1 violations found · 3 could not run.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────────────────
// The rules, as data. Exported so the gate's own test can drive it without restating any of
// it — a test that repeated these strings would itself be a file full of retired literals,
// and would then need an exemption from the rule it exists to test.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Rule A's subject: build-time export name ⇄ deploy-time variable name. */
export const SHARED_VALUES = [
  { js: 'domain', yaml: 'jamground_domain' },
  { js: 'githubOrg', yaml: 'jamground_github_org' },
  { js: 'siteRepo', yaml: 'jamground_site_repo' },
  { js: 'contentRepo', yaml: 'jamground_content_repo' },
  { js: 'contentBranch', yaml: 'jamground_content_branch' },
  { js: 'oauthClientId', yaml: 'jamground_oauth_client_id' },
];

/** Rule B's subject: the reference deployment's identity, every piece of it. */
export const RETIRED_LITERALS = [
  'dundon-dev',                          // the GitHub org
  'jamground.dundon.dev',                // the site host
  'Ov23liGesfzdwNhpwwty',                // the OAuth App client id
  '50.6.231.137',                        // the VPS
  'dundon.dev',                          // the apex, which survives a naive s/// of the above
  'a3eab41ced95d7f4aa140eb420c5d59d',    // the Cloudflare zone id
  'jamground-bot',                       // the GitHub machine account
  'dundon-newfold',                      // an operator account
  'dundonite',                           // an operator account
  'Newfold',                             // the employer once named in infra/RUNBOOK.md
  'Sean Dundon',                         // the author
];

/** Generated, vendored or version-control directories: not authored here, so not scanned. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro']);

/** The one file exempt from Rule B because of what it CONTAINS: this one, which has to name
 *  every forbidden literal. */
export const SELF = 'tools/check-config.mjs';

/** The one file exempt because of what it IS: the operator's own, gitignored, and holding the
 *  real values this repository is kept free of. Scanning it would make the gate red on correct
 *  usage. `.env.example`, being committed, is not exempt and must stay generic. */
export const OPERATOR_ENV = '.env';

/** Binary payloads a substring scan would produce only noise from. */
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|webm)$/i;

// ─────────────────────────────────────────────────────────────────────────────────────────
// The gate.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** The deploy side's env-driven idiom, as inventory.yml and group_vars/all.yml both spell it:
 *  `{{ lookup('env', 'NAME') | default('fallback', true) }}`.
 *
 *  The trailing `, true` is REQUIRED to match. Without it Jinja's `default` only fires on an
 *  undefined value, while `lookup('env', …)` returns an empty string for an unset variable and
 *  the fallback would never apply — a real difference in behaviour from the build side, so a
 *  deploy side missing it is not recognised as an env lookup and fails against the build side's
 *  declaration rather than passing as an equivalent one. */
const ENV_LOOKUP =
  /^\{\{\s*lookup\(\s*(['"])env\1\s*,\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\)\s*\|\s*default\(\s*(['"])([^'"]*)\4\s*,\s*true\s*\)\s*\}\}$/;

/** The deploy side's declaration of one value: which variable it reads (or `null`), and what it
 *  falls back to. A plain literal is a declaration with no variable. */
function deployDeclaration(raw) {
  if (typeof raw === 'string') {
    const m = ENV_LOOKUP.exec(raw.trim());
    if (m) return { env: m[3], fallback: m[5] };
  }
  return { env: null, fallback: String(raw) };
}

/** The build side's declaration of one value, from the module's own `declarations` table. A
 *  module that exports the value but no table for it — the plain-literal shape — declares it
 *  with no variable, and is compared like for like against a plain-literal deploy side. */
function buildDeclaration(buildTime, js) {
  const declared = buildTime.declarations?.[js];
  if (declared) return { env: declared.env ?? null, fallback: String(declared.fallback) };
  if (buildTime[js] !== undefined) return { env: null, fallback: String(buildTime[js]) };
  return null;
}

/** How a declaration reads in a message: the variable it reads, or the bare literal. */
const describe = (d) => (d.env === null
  ? `the literal ${JSON.stringify(d.fallback)}`
  : `${d.env}, falling back to ${JSON.stringify(d.fallback)}`);

/** Rule A. Returns problems; never exits. `fatal` means the rule could not run at all. */
async function ruleA(root) {
  const problems = [];
  const configJs = join(root, 'jamground.config.mjs');
  const groupVars = join(root, 'infra/ansible/group_vars/all.yml');

  if (!existsSync(configJs)) {
    return { fatal: `${relative(root, configJs)} does not exist, so Rule A could not run.`,
      hint: 'It is the build-time half of the declaration; without it there is nothing to compare.' };
  }
  if (!existsSync(groupVars)) {
    return { fatal: `${relative(root, groupVars)} does not exist, so Rule A could not run.`,
      hint: 'It is the deploy-time half of the declaration; without it there is nothing to compare.' };
  }

  let buildTime;
  try {
    // Cache-busted: normally this module is imported once per process, but the gate's own
    // test rewrites the file between runs inside a single process.
    buildTime = await import(`${pathToFileURL(configJs).href}?t=${Date.now()}-${Math.random()}`);
  } catch (e) {
    return { fatal: `${relative(root, configJs)} could not be imported: ${e.message}`,
      hint: 'It must be an ES module that resolves in Node with no build step and no environment '
        + 'set — placeholders are what a clean clone gets.' };
  }

  let YAML;
  try { YAML = require('yaml'); }
  catch (e) { return { fatal: `could not load a YAML parser: ${e.message}`, hint: 'run `npm ci` first' }; }

  let deployTime;
  try { deployTime = YAML.parse(readFileSync(groupVars, 'utf8')); }
  catch (e) { return { fatal: `${relative(root, groupVars)} is not parseable YAML: ${e.message}` }; }
  if (!deployTime || typeof deployTime !== 'object') {
    return { fatal: `${relative(root, groupVars)} did not parse to a mapping of variables.` };
  }

  for (const { js, yaml } of SHARED_VALUES) {
    const buildDecl = buildDeclaration(buildTime, js);
    const rawDeploy = deployTime[yaml];
    if (buildDecl === null) {
      problems.push({ file: 'jamground.config.mjs', rule: 'config-missing-build', key: js,
        message: `does not export \`${js}\`, so it cannot be compared with \`${yaml}\` in `
          + 'infra/ansible/group_vars/all.yml.' });
      continue;
    }
    if (rawDeploy === undefined) {
      problems.push({ file: 'infra/ansible/group_vars/all.yml', rule: 'config-missing-deploy', key: yaml,
        message: `does not declare \`${yaml}\`, so it cannot be compared with \`${js}\` in `
          + 'jamground.config.mjs.' });
      continue;
    }
    const deployDecl = deployDeclaration(rawDeploy);

    // The variable first. Two sides reading DIFFERENT variables would each look correct, and
    // would agree by accident for as long as neither variable was set — the drift would surface
    // only on the first real deployment, which is the worst possible moment to find it.
    if (buildDecl.env !== deployDecl.env) {
      problems.push({ file: 'jamground.config.mjs', rule: 'config-env-drift', key: js,
        build: buildDecl.env, deploy: deployDecl.env,
        message: `\`${js}\` reads ${describe(buildDecl)}, but \`${yaml}\` in `
          + `infra/ansible/group_vars/all.yml reads ${describe(deployDecl)}. The build and the `
          + 'converge would be configured by different things, and an operator setting one of '
          + 'them would move only one half of the deployment.' });
      continue;
    }
    // Then the fallback, which is what a tree that configured nothing actually gets.
    if (buildDecl.fallback !== deployDecl.fallback) {
      problems.push({ file: 'jamground.config.mjs', rule: 'config-drift', key: js,
        build: buildDecl.fallback, deploy: deployDecl.fallback,
        message: `\`${js}\` is ${JSON.stringify(buildDecl.fallback)} but \`${yaml}\` in `
          + `infra/ansible/group_vars/all.yml is ${JSON.stringify(deployDecl.fallback)}. The build and the `
          + 'converge would target different deployments, and neither half would fail on its own.' });
    }
  }
  return { problems };
}

/** Rule B. Returns problems plus what was and was not looked at. */
function ruleB(root) {
  const problems = [];
  let scanned = 0;

  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(p);
    return e.isFile() ? [p] : [];
  });

  for (const file of walk(root)) {
    const rel = relative(root, file).split('\\').join('/');
    if (rel === SELF || rel === OPERATOR_ENV) continue;
    if (BINARY_EXT.test(rel)) continue;

    let text;
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { problems.push({ file: rel, rule: 'unreadable', message: `could not be read: ${e.message}` }); continue; }
    scanned += 1;

    if (!RETIRED_LITERALS.some((lit) => text.includes(lit))) continue;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const lit of RETIRED_LITERALS) {
        if (!lines[i].includes(lit)) continue;
        problems.push({ file: rel, rule: 'retired-literal', literal: lit, line: i + 1,
          message: `line ${i + 1} still carries the retired literal ${JSON.stringify(lit)}: `
            + lines[i].trim().slice(0, 120) });
      }
    }
  }
  return { problems, scanned };
}

/** Runs both rules against `root`. Returns a report; never exits. */
export async function check(root) {
  const a = await ruleA(root);
  if (a.fatal) return { ok: false, fatal: a.fatal, hint: a.hint, problems: [] };
  const b = ruleB(root);
  const problems = [...a.problems, ...b.problems];
  return { ok: problems.length === 0, scanned: b.scanned, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// CLI. Guarded, so importing this module for its constants runs nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const rIdx = argv.indexOf('--root');
  const root = resolve(rIdx >= 0 ? argv[rIdx + 1] : fileURLToPath(new URL('..', import.meta.url)));

  const report = await check(root);

  if (report.fatal) {
    if (jsonMode) console.log(JSON.stringify({ ok: false, fatal: report.fatal, problems: [] }, null, 2));
    else { console.error(report.fatal); if (report.hint) console.error(`  ${report.hint}`); }
    process.exit(3);
  }
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  if (report.ok) {
    const { scanned } = report;
    console.log(`config — ${SHARED_VALUES.length} shared declarations agree, variable and `
      + 'fallback, between jamground.config.mjs and infra/ansible/group_vars/all.yml; '
      + `${RETIRED_LITERALS.length} retired literals absent from ${scanned} file`
      + `${scanned === 1 ? '' : 's'}`);
    process.exit(0);
  }
  console.error(`${report.problems.length} configuration problem${report.problems.length === 1 ? '' : 's'}:`);
  for (const p of report.problems) console.error(`  ${p.file}: ${p.message}`);
  process.exit(1);
}
