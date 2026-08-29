/* Fixture: the build-time half of a clean, minimal deployment declaration.
 * Deliberately the same SHAPE as the real jamground.config.mjs — six declared values, the
 * rest derived — so a change to the real module's contract shows up here as a failing test
 * rather than as a gate that quietly stops checking one of the six. */
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
