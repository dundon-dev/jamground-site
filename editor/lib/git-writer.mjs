/* The browser-side write path: an atomic multi-file commit via the Git Data API.
   The Contents API is one-file-per-commit, so it cannot make copy and imagery
   land together. This is the only shape that satisfies "a PR is atomic". */
export function createGitWriter({ api = 'https://api.github.com', repo, token, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const error = new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0,200)}`);
      error.status = r.status;
      throw error;
    }
    return r.json();
  };

  return {
    /** files: [{ path, content, encoding: 'utf-8' | 'base64' }] — text and binary together. */
    async commitFiles({ baseBranch, branch, files, message }) {
      // Check if the change branch exists; if not, parent on the base branch.
      let parentSha, baseTreeSha;
      let branchExists = false;

      try {
        const changeBranchRef = await call('GET', `/git/ref/heads/${branch}`);
        branchExists = true;
        // Branch exists: parent and base_tree come from the change branch's own head.
        const changeBranchCommit = await call('GET', `/git/commits/${changeBranchRef.object.sha}`);
        parentSha = changeBranchRef.object.sha;
        baseTreeSha = changeBranchCommit.tree.sha;
      } catch (e) {
        // Branch does not exist (404): parent and base_tree come from the base branch's head.
        // Re-throw if it's not a 404 (could be auth error, rate limit, etc.)
        if (e.status !== 404) throw e;
        const base = await call('GET', `/git/ref/heads/${baseBranch}`);
        const baseSha = base.object.sha;
        const baseCommit = await call('GET', `/git/commits/${baseSha}`);
        parentSha = baseSha;
        baseTreeSha = baseCommit.tree.sha;
      }

      // Blobs first — base64 is what carries a JPEG through a JSON API.
      const blobs = await Promise.all(files.map(f =>
        call('POST', '/git/blobs', { content: f.content, encoding: f.encoding || 'utf-8' })));

      const tree = await call('POST', '/git/trees', {
        base_tree: baseTreeSha,
        tree: files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobs[i].sha })),
      });
      const commit = await call('POST', '/git/commits', { message, tree: tree.sha, parents: [parentSha] });

      // Create the branch if new, fast-forward it if it exists.
      if (branchExists) {
        await call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
      } else {
        await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
      }
      return commit.sha;
    },
    openDraftPr: ({ branch, baseBranch, title, body }) =>
      call('POST', '/pulls', { head: branch, base: baseBranch, title, body, draft: true }),
    checksFor: ref => call('GET', `/commits/${ref}/check-runs`),
    reviewsFor: n => call('GET', `/pulls/${n}/reviews`),
  };
}
