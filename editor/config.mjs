/* editor/config.mjs — what the shell needs, re-derived from the one root declaration.
 *
 * The shell runs in a browser, so nothing HERE reads `process.env`: this module derives, and
 * only derives. The single place that touches the environment is ../jamground.config.mjs, which
 * resolves each of its six through a static `process.env.JAMGROUND_…` expression that
 * editor/build.mjs substitutes with esbuild `define` — so what reaches the browser is string
 * literals. That is asserted rather than assumed: editor/test/bundles-for-browser.test.mjs
 * fails if any module authored in this repository leaves a `process.env` in the bundle, and if
 * the defines stop substituting. See ../jamground.config.mjs's header for the argument.
 *
 * A plain relative import is what connects the two, and it is still doing the same work it
 * always did: esbuild follows it, and `node --test` follows it too, so the twenty-one pure-Node
 * tests under editor/test/ resolve these values with no build step — getting the committed
 * placeholders when no environment is set.
 *
 * Nothing is declared here. Every export is derived from ../jamground.config.mjs, so a fork
 * sets six variables in one gitignored `.env` and this module follows.
 */
import {
  contentBranch,
  contentRepoSlug,
  editorOrigin,
  editorRedirectUri,
  oauthClientId,
  previewUrlFor,
  siteUrl,
} from '../jamground.config.mjs';

/** The public OAuth App Client ID the shell sends to GitHub's authorize screen. */
export const OAUTH_CLIENT_ID = oauthClientId;

/** The shell's own origin — what the broker must echo back, exactly. */
export const EDITOR_ORIGIN = editorOrigin;

/** The registered callback: the shell's own origin, path `/`, nothing else. */
export const REDIRECT_URI = editorRedirectUri;

/** `org/repo` for the content repository — every GitHub call the shell makes targets it. */
export const CONTENT_REPO = contentRepoSlug;

/** The branch content is published from and every change branches off. */
export const CONTENT_BRANCH = contentBranch;

/** The public, unauthenticated tree listing — no token is ever sent to it. */
export const CONTENT_TREE_URL =
  `https://api.github.com/repos/${CONTENT_REPO}/git/trees/${CONTENT_BRANCH}?recursive=1`;

/** The public, unauthenticated blob root; a file's URL is `${CONTENT_BLOB_BASE}/${path}`. */
export const CONTENT_BLOB_BASE =
  `https://raw.githubusercontent.com/${CONTENT_REPO}/${CONTENT_BRANCH}`;

/** The staging site for one open change. Derived, like everything else here. */
export const PREVIEW_URL_FOR = previewUrlFor;

/** The live site — where a change ends up once it is published. */
export const SITE_URL = siteUrl;
