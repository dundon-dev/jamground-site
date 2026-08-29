/* jamground.config.mjs — the deployment's identity, declared once.
 *
 * Everything a fork must change to deploy this site under its own name lives here, and
 * nowhere else in the build-time half of the tree. The deploy-time half declares the same
 * values in infra/ansible/group_vars/all.yml; `tools/check-config.mjs` (Rule A) fails the
 * build if the two ever disagree, because two declarations that can drift are one
 * declaration and one lie.
 *
 * WHY A PLAIN COMMITTED MODULE, and not environment variables, esbuild `define`, or a
 * `globalThis` global. The reason is specific and load-bearing:
 *
 *   editor/test/bundles-for-browser.test.mjs bundles editor/entry.mjs with esbuild and NO
 *   `define`, asserting only that output exists. Under a `define`-based design that gate
 *   would pass while emitting a browser bundle containing a bare undefined identifier —
 *   green here, ReferenceError in the browser. That is a false green, and a false green is
 *   the one failure this codebase refuses. A plain module cannot produce it: esbuild
 *   inlines the module with zero configuration, and `node --test` resolves it with no build
 *   step and no environment set, which is what the pure-Node editor tests need.
 *
 * WHAT BELONGS HERE, AND WHAT NEVER DOES. The domain, the GitHub org, the two repository
 * names and the PUBLIC OAuth client id are properties of the FORK: identical for everyone
 * who deploys it, and baked into the editor bundle at build time regardless of where they
 * are written, so hiding them would buy nothing and cost reproducibility. They belong in
 * git. The VPS address, the ssh user and the ssh key are properties of the OPERATOR'S
 * MACHINE — one person's laptop reaching one person's box — and never belong in git; they
 * are read from the environment by infra/ansible/inventory.yml. Secrets (the OAuth client
 * SECRET, the bot PAT, the ACME credentials) are placed on the box by hand and are named
 * here by PATH only, in .env.example, never by value.
 *
 * SIX values are declared. Everything else is derived by rule, so no string is ever stated
 * twice and a fork edits exactly six lines.
 */

// ── Declared ───────────────────────────────────────────────────────────────────────────

/** The apex the site is served from. `edit.`, `hooks.` and `preview.` hang off it. */
export const domain = 'example.com';

/** The GitHub organisation (or user) owning both repositories below. */
export const githubOrg = 'your-org';

/** This repository — the site's code, the half that is never editor-writable. */
export const siteRepo = 'jamground-site';

/** The content repository — the other half, the only one editors can write to. */
export const contentRepo = 'jamground-content';

/** The branch the content repository publishes from; every change branches off it. */
export const contentBranch = 'main';

/* The OAuth App's PUBLIC Client ID. Public by design: it
 * reaches the browser in editor/dist/shell.js no matter where it is written, so keeping it
 * in git costs nothing and makes the shipped bundle reviewable. The Client SECRET is a
 * different thing entirely and lives only on the box, at the path named in .env.example.
 *
 * The placeholder has the SAME SHAPE as a real GitHub OAuth App client id — measured, not
 * assumed: `Ov23li` followed by 14 alphanumerics, 20 characters in total — so the shape
 * assertion in editor/test/auth-flow.test.mjs is a real constraint on a real forked value
 * rather than a tautology satisfied by any string. */
export const oauthClientId = 'Ov23liEXAMPLE0CLIENT';

// ── Derived ────────────────────────────────────────────────────────────────────────────

/** The site's canonical origin — astro.config.mjs's `site`. No trailing slash. */
export const siteUrl = `https://${domain}`;

/** The editor shell's own origin. The broker echoes exactly this, never `*`. */
export const editorOrigin = `https://edit.${domain}`;

/** The registered OAuth callback: the shell's own origin, path `/`. */
export const editorRedirectUri = `${editorOrigin}/`;

/** `org/repo` for the content repository, as GitHub's REST paths spell it. */
export const contentRepoSlug = `${githubOrg}/${contentRepo}`;

/** `org/repo` for this repository. */
export const siteRepoSlug = `${githubOrg}/${siteRepo}`;
