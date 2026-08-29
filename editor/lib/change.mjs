// Start a change: create a branch and open a draft PR before any editing.
// Save: commit the changed-file set to the branch.
import { getChangedFiles as defaultGetChangedFiles } from './changed-files.mjs';
import { exportPost as defaultExportPost } from './export.mjs';

/**
 * Start a change: create a branch from the default branch and open a draft PR.
 * Writes a baseline commit (tree identical to base, with base as parent) before opening the PR,
 * so the branch is one commit ahead and the draft opens.
 *
 * @param {object} config
 * @param {string} config.title - PR title (no git vocabulary)
 * @param {string} config.baseBranch - Base branch name (e.g., 'main')
 * @param {string} config.branch - New branch name
 * @param {string} config.repo - Repository (owner/repo)
 * @param {string} config.token - GitHub API token
 * @param {string} config.api - GitHub API base URL (default: https://api.github.com)
 * @param {Function} config.fetchImpl - Injected fetch implementation (for testing)
 * @returns {Promise<object>} - The opened draft PR object
 */
export async function startChange({
  title,
  baseBranch,
  branch,
  repo,
  token,
  api = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const deleteRef = async () => {
    try {
      await call('DELETE', `/git/refs/heads/${branch}`);
    } catch (e) {
      // Ignore deletion errors
    }
  };

  // Get the base branch ref
  const baseRef = await call('GET', `/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef.object.sha;

  // Get the base commit to access its tree
  const baseCommit = await call('GET', `/git/commits/${baseSha}`);
  const treesha = baseCommit.tree.sha;

  // Create a baseline commit with the base's tree and base as parent
  let baselineCommit;
  try {
    baselineCommit = await call('POST', '/git/commits', {
      message: 'Start a change',
      tree: treesha,
      parents: [baseSha],
    });
  } catch (e) {
    throw e;
  }

  // Create the new branch pointing to the baseline commit
  let refCreated = false;
  try {
    await call('POST', '/git/refs', {
      ref: `refs/heads/${branch}`,
      sha: baselineCommit.sha,
    });
    refCreated = true;
  } catch (e) {
    throw e;
  }

  // Open a draft PR
  try {
    return await call('POST', '/pulls', {
      head: branch,
      base: baseBranch,
      title,
      body: '',
      draft: true,
    });
  } catch (e) {
    // If ref was created but PR failed, delete the ref before throwing
    if (refCreated) {
      await deleteRef();
    }
    throw e;
  }
}

/**
 * Save: commit changed files to the branch via the git writer.
 *
 * Gets the changed file set using getChangedFiles, exports them, and commits them
 * as a single commit. If no files changed, returns without making any API calls.
 *
 * @param {object} config
 * @param {Array} config.posts - Array of WordPress post objects
 * @param {string} config.message - Commit message (no git vocabulary)
 * @param {object} config.gitWriter - Git writer instance with commitFiles method
 * @param {string} config.baseBranch - Base branch name
 * @param {string} config.branch - Target branch name
 * @param {object} config.api - Block API (createBlock, serialize, parse, getBlockType)
 * @param {Function} config.getUpdatedAt - Function returning current timestamp
 * @param {Function} config.getChangedFiles - Override for change detection (testing)
 * @param {Function} config.exportPost - Override for export (testing)
 * @returns {Promise<void>}
 */
export async function save({
  posts,
  message,
  gitWriter,
  baseBranch,
  branch,
  api,
  getUpdatedAt,
  getChangedFiles = defaultGetChangedFiles,
  exportPost = defaultExportPost,
}) {
  // Get the set of posts that have changed
  const changedPosts = getChangedFiles(posts, { api, getUpdatedAt });

  // If no changes, return without making API calls
  if (changedPosts.length === 0) {
    return;
  }

  // Export each changed post and prepare file objects for commit
  const files = changedPosts.map((post) => {
    const path = post.meta && post.meta._jamground_path;
    if (!path) {
      throw new Error(
        `save: post ${post.id} (_jamground_id: ${post.meta && post.meta._jamground_id}) lacks _jamground_path: missing baseline would silently rewrite the file`
      );
    }
    const frontmatter = post.frontmatter || {};
    const exported = exportPost({
      api,
      markup: post.content,
      frontmatter,
      previousSlug: post.slug,
      updatedAt: getUpdatedAt(),
    });

    return {
      path,
      content: exported,
      encoding: 'utf-8',
    };
  });

  // Commit all changed files in a single atomic commit
  await gitWriter.commitFiles({
    baseBranch,
    branch,
    files,
    message,
  });
}
