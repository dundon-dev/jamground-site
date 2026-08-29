/* Fixture: the build-time half of a clean, minimal deployment declaration.
 * Deliberately the same CONTRACT as the real jamground.config.mjs — the same six values, the
 * rest derived — so a change to that contract shows up here as a failing test rather than as
 * a gate that quietly stops checking one of the six.
 *
 * It stays PLAIN LITERALS while the real module resolves each of its six from an environment
 * variable, and that is on purpose: Rule A must handle both shapes, since either half of a
 * fork may be written either way, and a fixture written only in the env-driven shape would
 * leave the literal-against-literal comparison untested. The env-driven shape is planted onto
 * this file by test/tools/check-config.test.mjs, which is where both shapes are exercised —
 * including the mismatch between them. */
export const domain = 'example.com';
export const githubOrg = 'your-org';
export const siteRepo = 'jamground-site';
export const contentRepo = 'jamground-content';
export const contentBranch = 'main';
export const oauthClientId = 'Ov23liEXAMPLE0CLIENT';

export const siteUrl = `https://${domain}`;
export const editorOrigin = `https://edit.${domain}`;
export const editorRedirectUri = `${editorOrigin}/`;
export const contentRepoSlug = `${githubOrg}/${contentRepo}`;
export const siteRepoSlug = `${githubOrg}/${siteRepo}`;
