import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublish } from '../lib/publish.mjs';

test('readyForReview issues GraphQL mutation markPullRequestReadyForReview', async () => {
  let capturedBodies = [];

  const fetchImpl = async (url, init) => {
    if (url.includes('/graphql')) {
      capturedBodies.push(JSON.parse(init.body));
    }
    return {
      ok: true,
      json: async () => {
        const body = init.body ? JSON.parse(init.body) : {};
        if (body.query && body.query.includes('GetPullRequest')) {
          return {
            data: {
              node: {
                changedFiles: 1,
              },
            },
          };
        }
        return {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { isDraft: false },
            },
          },
        };
      },
    };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await publish.readyForReview({
    prNodeId: 'PR_kwDOABC123',
  });

  assert.equal(capturedBodies.length, 2, 'Should issue both query and mutation');
  assert.ok(capturedBodies[0].query.includes('GetPullRequest'), 'First should be query for PR details');
  assert.ok(capturedBodies[1].query.includes('markPullRequestReadyForReview'), 'Second should be mutation');
  assert.equal(capturedBodies[1].variables.prId, 'PR_kwDOABC123', 'Variables should include PR node ID');
});

test('publish issues merge request to default branch', async () => {
  let capturedUrl = null;
  let capturedMethod = null;
  let capturedBody = null;

  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedMethod = init.method;
    capturedBody = init.body ? JSON.parse(init.body) : null;
    return { ok: true, json: async () => ({ sha: 'merged-sha' }) };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.publish({ prNumber: 42 });

  assert.ok(capturedUrl.includes('/pulls/42/merge'), 'Should PUT to pulls merge endpoint');
  assert.equal(capturedMethod, 'PUT', 'Should use PUT method');
  assert.equal(capturedBody.merge_method, 'squash', 'Body should include merge_method: squash');
  assert.ok(result.sha, 'Should return merged commit SHA');
});

test('publish with 405 returns waiting-for-approval message', async () => {
  const fetchImpl = async (url, init) => {
    // GET /pulls/42 should return PR details with changed_files > 0
    if (url.includes('/pulls/42') && init.method === 'GET') {
      return {
        ok: true,
        json: async () => ({ number: 42, changed_files: 1 }),
      };
    }
    // PUT /pulls/42/merge should return 405
    if (url.includes('/pulls/42/merge')) {
      return {
        ok: false,
        status: 405,
        json: async () => ({ message: 'Pull Request is not mergeable' }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.publish({ prNumber: 42 });

  assert.ok(result.waiting, 'Should indicate waiting state');
  assert.ok(result.message, 'Should include editorial message');
  assert.doesNotMatch(result.message, /405/, 'Should not expose HTTP status code');
  assert.doesNotMatch(result.message, /Pull Request is not mergeable/, 'Should not expose API message');
});

test('publish with 409 returns waiting-for-approval message', async () => {
  const fetchImpl = async (url, init) => {
    // GET /pulls/42 should return PR details with changed_files > 0
    if (url.includes('/pulls/42') && init.method === 'GET') {
      return {
        ok: true,
        json: async () => ({ number: 42, changed_files: 1 }),
      };
    }
    // PUT /pulls/42/merge should return 409
    if (url.includes('/pulls/42/merge')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({ message: 'Pull Request is not mergeable' }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.publish({ prNumber: 42 });

  assert.ok(result.waiting, 'Should indicate waiting state');
  assert.ok(result.message, 'Should include editorial message');
  assert.doesNotMatch(result.message, /409/, 'Should not expose HTTP status code');
});

test('publish throws on other error statuses', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Unauthorized',
  });

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await assert.rejects(
    publish.publish({ prNumber: 42 }),
    /401/,
  );
});

test('readyForReview throws on GraphQL error', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      errors: [{ message: 'Invalid mutation' }],
    }),
  });

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await assert.rejects(
    publish.readyForReview({ prNodeId: 'invalid' }),
  );
});

test('readyForReview returns empty refusal when changed_files is 0', async () => {
  let capturedGraphqlQueries = [];

  const fetchImpl = async (url, init) => {
    if (url.includes('/graphql')) {
      const body = JSON.parse(init.body);
      capturedGraphqlQueries.push(body);
      // Check if this is a query (checking for changed files) or mutation
      if (body.query && body.query.includes('GetPullRequest')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              node: {
                changedFiles: 0,
              },
            },
          }),
        };
      }
    }
    return {
      ok: true,
      json: async () => ({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      }),
    };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.readyForReview({ prNodeId: 'PR_kwDOABC123' });

  assert.ok(result.empty, 'Should return empty flag for empty change');
  assert.deepEqual(result, { empty: true }, 'Should return only the fact — no editor-facing string; that lives in vocabulary.mjs');
  // Only one GraphQL query should be issued (the GetPullRequest query, not the mutation)
  assert.equal(capturedGraphqlQueries.length, 1, 'Should only query for PR details, not issue mutation');
});

test('readyForReview issues GraphQL mutation when changed_files > 0', async () => {
  let capturedGraphqlQueries = [];

  const fetchImpl = async (url, init) => {
    if (url.includes('/graphql')) {
      const body = JSON.parse(init.body);
      capturedGraphqlQueries.push(body);
      // Check if this is a query (checking for changed files) or mutation
      if (body.query && body.query.includes('GetPullRequest')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              node: {
                changedFiles: 1,
              },
            },
          }),
        };
      }
      // This is the mutation
      return {
        ok: true,
        json: async () => ({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
      }),
    };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.readyForReview({ prNodeId: 'PR_kwDOABC123' });

  assert.ok(!result || !result.empty, 'Should not return empty flag when change has content');
  assert.equal(capturedGraphqlQueries.length, 2, 'Should issue both query and mutation');
  assert.ok(capturedGraphqlQueries[0].query.includes('GetPullRequest'));
  assert.ok(capturedGraphqlQueries[1].query.includes('markPullRequestReadyForReview'));
});

test('publish returns empty refusal when changed_files is 0', async () => {
  let mergeWasCalled = false;

  const fetchImpl = async (url, init) => {
    if (url.includes('/pulls/42/merge')) {
      mergeWasCalled = true;
      return { ok: true, json: async () => ({ sha: 'merged-sha' }) };
    }
    return {
      ok: true,
      json: async () => ({
        number: 42,
        changed_files: 0,
        sha: 'pr-sha',
      }),
    };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.publish({ prNumber: 42 });

  assert.ok(result.empty, 'Should return empty flag for empty change');
  assert.deepEqual(result, { empty: true }, 'Should return only the fact — no editor-facing string; that lives in vocabulary.mjs');
  assert.ok(!mergeWasCalled, 'Merge should not be called for empty change');
});

test('publish issues merge when changed_files > 0', async () => {
  let capturedMethod = null;
  let capturedBody = null;

  const fetchImpl = async (url, init) => {
    if (url.includes('/pulls/42/merge')) {
      capturedMethod = init.method;
      capturedBody = init.body ? JSON.parse(init.body) : null;
      return { ok: true, json: async () => ({ sha: 'merged-sha' }) };
    }
    return {
      ok: true,
      json: async () => ({
        number: 42,
        changed_files: 1,
        sha: 'pr-sha',
      }),
    };
  };

  const publish = createPublish({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await publish.publish({ prNumber: 42 });

  assert.ok(!result.empty, 'Should not return empty flag when change has content');
  assert.ok(result.sha, 'Should return merged commit SHA');
  assert.equal(capturedMethod, 'PUT', 'Should use PUT method for merge');
  assert.equal(capturedBody.merge_method, 'squash', 'Should use squash merge method');
});
