/* jamground.config.mjs — the deployment's identity, declared once.
 *
 * Everything a fork must change to deploy this site under its own name lives here, and
 * nowhere else in the build-time half of the tree. The deploy-time half declares the same
 * values in infra/ansible/group_vars/all.yml; `tools/check-config.mjs` (Rule A) fails the
 * build if the two ever disagree, because two declarations that can drift are one
 * declaration and one lie.
 *
 * WHAT IS COMMITTED HERE IS A PLACEHOLDER; WHAT AN OPERATOR RUNS IS THEIR OWN. Each of the
 * six resolves from an environment variable — `JAMGROUND_` plus its own name, in
 * SCREAMING_SNAKE — and falls back to the generic placeholder committed for it. That is what
 * lets this file, and every other tracked file, stay generic while a real deployment is driven
 * from a gitignored `.env` (`set -a; . ./.env; set +a`; see infra/RUNBOOK.md). The same six
 * variables, with the same fallbacks, drive infra/ansible/group_vars/all.yml, and Rule A
 * compares the two DECLARATIONS — variable name and fallback — rather than the values they
 * happen to resolve to at one moment, which two sides reading one variable would always agree
 * about and prove nothing by.
 *
 * HOW THE ENVIRONMENT IS READ, AND WHY EXACTLY LIKE THIS. This module is bundled into the
 * browser, where there is no `process` at all. Two properties make that safe, and neither is
 * taken on trust:
 *
 *   1. Every read is the STATIC member expression `process.env.JAMGROUND_…`, never a dynamic
 *      `process.env[name]`. esbuild's `define` substitutes only the static form; the dynamic
 *      form would survive into the bundle as a bare `process.env`. editor/build.mjs resolves
 *      all six in Node and passes them as `define`, so the shipped bundle carries LITERALS.
 *
 *   2. Each read is wrapped in a try/catch, so where no substitution has happened the
 *      reference is merely ABSENT — the fallback applies — instead of throwing a
 *      ReferenceError. Importing this module never depends on `process` existing.
 *
 * THE ARGUMENT THIS HEADER USED TO MAKE, AND WHAT CHANGED. It used to refuse environment
 * variables and `define` outright, on the grounds that editor/test/bundles-for-browser.test.mjs
 * bundled editor/entry.mjs with NO `define` and asserted only that output existed — so a
 * `define`-based design would pass that gate while shipping a browser bundle that throws.
 * The reasoning was right about the gate; the gate is what changed. That test now also
 *   (a) builds with the very defines editor/build.mjs uses and asserts that no module authored
 *       in this repository contributes a `process.env` to the output — the modules are located
 *       by esbuild's own metafile, so the vendored occurrences cannot be mistaken for ours; and
 *   (b) evaluates an UN-defined bundle of this module in a context with no `process` global,
 *       asserting it yields the placeholders rather than throwing.
 * The false green is no longer available, which is what makes this design safe.
 *
 * WHAT BELONGS HERE, AND WHAT NEVER DOES. The domain, the GitHub org, the two repository
 * names and the PUBLIC OAuth client id are properties of the FORK: identical for everyone who
 * uses that deployment, and baked into the editor bundle at build time regardless of where
 * they are written, so hiding them would buy nothing and cost reproducibility. Their generic
 * PLACEHOLDERS belong in git; the real values belong in the operator's `.env`. The VPS
 * address, the ssh user and the ssh key are properties of the OPERATOR'S MACHINE — one
 * person's laptop reaching one person's box — and have no placeholder worth committing beyond
 * an unroutable one; they are read from the environment by infra/ansible/inventory.yml.
 * Secrets (the OAuth client SECRET, the bot PAT, the ACME credentials) are placed on the box
 * by hand and are named by PATH only, in .env.example, never by value.
 *
 * SIX values are declared. Everything else is derived by rule, so no string is ever stated
 * twice and a fork sets exactly six variables.
 */

// ── How a value is resolved ────────────────────────────────────────────────────────────

/** The value each of the six falls back to when its variable is unset — which is to say, the
 *  generic placeholder this repository commits. This table is also the LIST of what exists:
 *  the resolutions below read from it, and `declarations` at the foot of the section is built
 *  by mapping over it, so the value a fork actually gets and the value `tools/check-config.mjs`
 *  compares against infra/ansible/group_vars/all.yml are the same string by construction rather
 *  than by two lists agreeing. */
const FALLBACK = {
  domain: 'example.com',
  githubOrg: 'your-org',
  siteRepo: 'jamground-site',
  contentRepo: 'jamground-content',
  contentBranch: 'main',
  oauthClientId: 'Ov23liEXAMPLE0CLIENT',
};

/** The variable a declared value reads: `JAMGROUND_` plus the export's own name, in
 *  SCREAMING_SNAKE. Every one of the six follows it, `.env.example` documents it, and
 *  infra/ansible/group_vars/all.yml reads the same names on the other side. */
const variableFor = (name) => `JAMGROUND_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

/**
 * Resolves one declared value from the environment, or falls back.
 *
 * `read` is a thunk holding the STATIC `process.env.NAME` expression — static because that is
 * the only form esbuild's `define` substitutes — called inside a try/catch so that a browser
 * bundle in which no substitution happened falls back rather than throwing on an absent
 * `process`. An EMPTY value counts as unset, matching Ansible's `| default(…, true)` on the
 * other side: `JAMGROUND_DOMAIN=` in a `.env` means "I did not set this" on both halves.
 */
function resolve(fallback, read) {
  let raw;
  try { raw = read(); } catch { raw = undefined; }
  return raw === undefined || raw === '' ? fallback : raw;
}

// ── Declared ───────────────────────────────────────────────────────────────────────────

/** The apex the site is served from. `edit.`, `hooks.` and `preview.` hang off it. */
export const domain = resolve(FALLBACK.domain, () => process.env.JAMGROUND_DOMAIN);

/** The GitHub organisation (or user) owning both repositories below. */
export const githubOrg = resolve(FALLBACK.githubOrg, () => process.env.JAMGROUND_GITHUB_ORG);

/** This repository — the site's code, the half that is never editor-writable. */
export const siteRepo = resolve(FALLBACK.siteRepo, () => process.env.JAMGROUND_SITE_REPO);

/** The content repository — the other half, the only one editors can write to. */
export const contentRepo = resolve(FALLBACK.contentRepo, () => process.env.JAMGROUND_CONTENT_REPO);

/** The branch the content repository publishes from; every change branches off it. */
export const contentBranch = resolve(FALLBACK.contentBranch, () => process.env.JAMGROUND_CONTENT_BRANCH);

/* The OAuth App's PUBLIC Client ID. Public by design: it reaches the browser in
 * editor/dist/shell.js no matter where it is written, so an operator's real id being supplied
 * through `.env` rather than committed is about keeping this tree GENERIC, not about keeping
 * that id secret — it is in the shipped bundle either way, which is what makes the bundle
 * reviewable. The Client SECRET is a different thing entirely and lives only on the box, at the
 * path named in .env.example.
 *
 * The placeholder has the SAME SHAPE as a real GitHub OAuth App client id — measured, not
 * assumed: `Ov23li` followed by 14 alphanumerics, 20 characters in total — so the shape
 * assertion in editor/test/auth-flow.test.mjs is a real constraint on a real forked value
 * rather than a tautology satisfied by any string. It holds an OVERRIDE to the same standard:
 * a JAMGROUND_OAUTH_CLIENT_ID that is not shaped like a client id fails that test too. */
export const oauthClientId = resolve(FALLBACK.oauthClientId, () => process.env.JAMGROUND_OAUTH_CLIENT_ID);

/** The six declarations in machine-readable form: which variable each value reads, and what it
 *  falls back to. `tools/check-config.mjs` (Rule A) compares this against
 *  infra/ansible/group_vars/all.yml, and `editor/build.mjs` turns it into esbuild `define`s.
 *
 *  Derived, not listed. A second list of variable names would be a second declaration able to
 *  drift from the reads above; the CONVENTION is the declaration instead — `JAMGROUND_` plus
 *  the export's own name in SCREAMING_SNAKE — so the two cannot disagree about what exists,
 *  only about spelling, and a misspelt read is what `test/gates/config-env.test.mjs` sets all
 *  six variables in a child process to catch. It also keeps every `JAMGROUND_*` name out of the
 *  browser bundle: this file is bundled whole (the package does not declare `sideEffects:
 *  false`, so esbuild shakes nothing out of it), and a name that is never written is never
 *  shipped. */
export const declarations = Object.fromEntries(
  Object.entries(FALLBACK).map(([name, fallback]) => [name, { env: variableFor(name), fallback }]),
);

// ── Derived ────────────────────────────────────────────────────────────────────────────

/** The site's canonical origin — astro.config.mjs's `site`. No trailing slash. */
export const siteUrl = `https://${domain}`;

/** The editor shell's own origin. The broker echoes exactly this, never `*`. */
export const editorOrigin = `https://edit.${domain}`;

/** The registered OAuth callback: the shell's own origin, path `/`. */
export const editorRedirectUri = `${editorOrigin}/`;

/** The staging site for one open change, by its number.
 *
 *  The shape is not free: roles/nginx matches `~^pr-(?<prnum>[0-9]+)\.preview\.<domain>$` and
 *  serves `<previews_root>/$prnum`, and the live certificate's SANs cover `*.preview.<domain>`
 *  as a second wildcard — a plain `*.<domain>` would NOT match a name two labels deep. Derived
 *  here so the editor and the server cannot disagree about it. */
export const previewUrlFor = (number) => `https://pr-${number}.preview.${domain}/`;

/** `org/repo` for the content repository, as GitHub's REST paths spell it. */
export const contentRepoSlug = `${githubOrg}/${contentRepo}`;

/** `org/repo` for this repository. */
export const siteRepoSlug = `${githubOrg}/${siteRepo}`;
