/* Publishing operations: marking a PR ready for review and merging to the default branch.
   Ready-for-review uses GraphQL (no REST route exists to clear draft status).
   Merge handles the expected cases where review is not yet complete (405, 409).
   Both operations refuse if the change has no content difference (changed_files: 0) —
   they return the fact ({ empty: true }) and issue no mutation and no merge; the
   editor-facing words for that fact live only in vocabulary.mjs (VOCAB.noContentChange),
   never duplicated here. */

export function createPublish({ api = 'https://api.github.com', repo, token, fetchImpl = fetch }) {
  const graphql = async (query, variables) => {
    const r = await fetchImpl(`${api}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`GraphQL request failed: ${r.status}`);
    const json = await r.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL error: ${json.errors[0].message}`);
    }
    return json.data;
  };

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
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
    return r.json();
  };

  const isEmptyChangeByPrNumber = async (prNumber) => {
    const pr = await call('GET', `/pulls/${prNumber}`, undefined);
    return pr.changed_files === 0;
  };

  const isEmptyChangeByNodeId = async (prNodeId) => {
    const query = `
      query GetPullRequest($prId: ID!) {
        node(id: $prId) {
          ... on PullRequest {
            changedFiles
          }
        }
      }
    `;
    const data = await graphql(query, { prId: prNodeId });
    return data.node.changedFiles === 0;
  };

  return {
    async readyForReview({ prNodeId }) {
      if (await isEmptyChangeByNodeId(prNodeId)) {
        // The fact only — the editor-facing words live in vocabulary.mjs (VOCAB.noContentChange),
        // never duplicated here.
        return { empty: true };
      }

      const mutation = `
        mutation MarkReadyForReview($prId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $prId }) {
            pullRequest {
              isDraft
            }
          }
        }
      `;
      return await graphql(mutation, { prId: prNodeId });
    },

    async publish({ prNumber }) {
      if (await isEmptyChangeByPrNumber(prNumber)) {
        // The fact only — see readyForReview above.
        return { empty: true };
      }

      try {
        const result = await call('PUT', `/pulls/${prNumber}/merge`, { merge_method: 'squash' });
        return { sha: result.sha };
      } catch (e) {
        // 405 and 409 are expected when review is not yet complete
        if (e.message.includes('405') || e.message.includes('409')) {
          return {
            waiting: true,
            message: 'The change is waiting for someone to approve it.',
          };
        }
        throw e;
      }
    },
  };
}
