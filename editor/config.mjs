/* editor/config.mjs — what the shell needs, re-derived from the one root declaration.
 *
 * The shell runs in a browser, so nothing here may read `process.env`, and the values below
 * must survive esbuild's bundle of editor/entry.mjs with no `define`, no plugin and no flag
 * — see the header of ../jamground.config.mjs for why that constraint is the whole design.
 * A plain relative import satisfies it: esbuild follows it, and `node --test` follows it too,
 * so the twenty-one pure-Node tests under editor/test/ resolve these values with no build
 * step and no environment set.
 *
 * Nothing is declared here. Every export is derived from ../jamground.config.mjs, so a fork
 * changes six lines in one file and this module follows.
 */
import {
  contentBranch,
  contentRepoSlug,
  editorOrigin,
  editorRedirectUri,
  oauthClientId,
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
