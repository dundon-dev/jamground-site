import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitWriter } from '../lib/git-writer.mjs';

test('commitFiles for a new branch: sequence is GET branch (404), GET base, POST blobs, POST tree, POST commit, POST ref', async () => {
  const calls = [];
  const commits = {}; // Map commit sha -> { tree, parents }
  const refs = {}; // Map branch name -> commit sha
  refs['main'] = 'main-sha';
  commits['main-sha'] = { tree: 'main-tree-sha', parents: [] };

  const fetchImpl = async (url, init) => {
    const method = init.method;
    const pathMatch = url.replace('https://api.github.com/repos/user/repo', '');
    calls.push({ method, path: pathMatch });

    // Check if change branch exists (should 404 for new branch)
    if (method === 'GET' && pathMatch === '/git/ref/heads/new-branch') {
      return {
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      };
    }

    // GET base branch
    if (method === 'GET' && pathMatch === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }

    // GET base commit
    if (method === 'GET' && pathMatch === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }

    // POST blobs
    if (method === 'POST' && pathMatch === '/git/blobs') {
      return { ok: true, json: async () => ({ sha: `blob-sha-${calls.length}` }) };
    }

    // POST tree
    if (method === 'POST' && pathMatch === '/git/trees') {
      return { ok: true, json: async () => ({ sha: 'new-tree-sha' }) };
    }

    // POST commit
    if (method === 'POST' && pathMatch === '/git/commits') {
      const body = JSON.parse(init.body);
      const commitSha = `commit-sha-${calls.length}`;
      commits[commitSha] = { tree: body.tree, parents: body.parents };
      return { ok: true, json: async () => ({ sha: commitSha }) };
    }

    // POST ref (new branch)
    if (method === 'POST' && pathMatch === '/git/refs') {
      const body = JSON.parse(init.body);
      refs[body.ref.replace('refs/heads/', '')] = body.sha;
      return { ok: true, json: async () => ({}) };
    }

    throw new Error(`Unexpected call: ${method} ${pathMatch}`);
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await writer.commitFiles({
    baseBranch: 'main',
    branch: 'new-branch',
    files: [{ path: 'file1.md', content: 'content1', encoding: 'utf-8' }],
    message: 'Test commit',
  });

  // Verify sequence: GET branch (404), GET base ref, GET base commit, POST blob, POST tree, POST commit, POST ref
  const expectedSequence = [
    { method: 'GET', path: '/git/ref/heads/new-branch' },
    { method: 'GET', path: '/git/ref/heads/main' },
    { method: 'GET', path: '/git/commits/main-sha' },
    { method: 'POST', path: '/git/blobs' },
    { method: 'POST', path: '/git/trees' },
    { method: 'POST', path: '/git/commits' },
    { method: 'POST', path: '/git/refs' },
  ];

  assert.deepEqual(calls, expectedSequence, 'New branch call sequence should be exact');
});

test('commitFiles for an existing branch: sequence is GET branch, GET commit, POST blobs, POST tree, POST commit, PATCH ref with fast-forward', async () => {
  const calls = [];
  const commits = {}; // Map commit sha -> { tree, parents }
  const refs = {}; // Map branch name -> commit sha
  refs['main'] = 'main-sha';
  commits['main-sha'] = { tree: 'main-tree-sha', parents: [] };
  refs['existing-branch'] = 'baseline-commit-sha';
  commits['baseline-commit-sha'] = { tree: 'main-tree-sha', parents: ['main-sha'] };

  const fetchImpl = async (url, init) => {
    const method = init.method;
    const pathMatch = url.replace('https://api.github.com/repos/user/repo', '');
    calls.push({ method, path: pathMatch });

    // GET change branch (exists)
    if (method === 'GET' && pathMatch === '/git/ref/heads/existing-branch') {
      return { ok: true, json: async () => ({ object: { sha: 'baseline-commit-sha' } }) };
    }

    // GET baseline commit
    if (method === 'GET' && pathMatch === '/git/commits/baseline-commit-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }

    // POST blobs
    if (method === 'POST' && pathMatch === '/git/blobs') {
      return { ok: true, json: async () => ({ sha: `blob-sha-${calls.length}` }) };
    }

    // POST tree
    if (method === 'POST' && pathMatch === '/git/trees') {
      return { ok: true, json: async () => ({ sha: 'new-tree-sha' }) };
    }

    // POST commit
    if (method === 'POST' && pathMatch === '/git/commits') {
      const body = JSON.parse(init.body);
      const commitSha = `commit-sha-${calls.length}`;
      commits[commitSha] = { tree: body.tree, parents: body.parents };
      return { ok: true, json: async () => ({ sha: commitSha }) };
    }

    // PATCH ref (fast-forward)
    if (method === 'PATCH' && pathMatch === '/git/refs/heads/existing-branch') {
      const body = JSON.parse(init.body);
      // Verify it's a fast-forward: the new commit must have the current ref's tip as an ancestor
      const newCommitSha = body.sha;
      const currentTip = refs['existing-branch'];

      if (body.force === false) {
        // Check if currentTip is an ancestor of newCommitSha
        if (!isAncestor(currentTip, newCommitSha, commits)) {
          return {
            ok: false,
            status: 422,
            text: async () => 'Update is not a fast forward',
          };
        }
      }

      refs['existing-branch'] = newCommitSha;
      return { ok: true, json: async () => ({}) };
    }

    throw new Error(`Unexpected call: ${method} ${pathMatch}`);
  };

  const isAncestor = (ancestor, descendant, commits) => {
    if (ancestor === descendant) return true;
    const commitData = commits[descendant];
    if (!commitData) return false;
    for (const parent of commitData.parents) {
      if (isAncestor(ancestor, parent, commits)) return true;
    }
    return false;
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await writer.commitFiles({
    baseBranch: 'main',
    branch: 'existing-branch',
    files: [{ path: 'file1.md', content: 'new-content', encoding: 'utf-8' }],
    message: 'Update existing branch',
  });

  // Verify sequence: GET branch, GET commit, POST blob, POST tree, POST commit, PATCH ref
  const expectedSequence = [
    { method: 'GET', path: '/git/ref/heads/existing-branch' },
    { method: 'GET', path: '/git/commits/baseline-commit-sha' },
    { method: 'POST', path: '/git/blobs' },
    { method: 'POST', path: '/git/trees' },
    { method: 'POST', path: '/git/commits' },
    { method: 'PATCH', path: '/git/refs/heads/existing-branch' },
  ];

  assert.deepEqual(calls, expectedSequence, 'Existing branch call sequence should be exact');
});

test('a second save accumulates onto the first: new commit is descendant of first commit', async () => {
  const calls = [];
  const commits = {}; // Map commit sha -> { tree, parents }
  const refs = {}; // Map branch name -> commit sha
  refs['main'] = 'main-sha';
  commits['main-sha'] = { tree: 'main-tree-sha', parents: [] };

  const fetchImpl = async (url, init) => {
    const method = init.method;
    const pathMatch = url.replace('https://api.github.com/repos/user/repo', '');
    calls.push({ method, path: pathMatch });

    // GET change branch
    if (method === 'GET' && pathMatch === '/git/ref/heads/change-branch') {
      const tip = refs['change-branch'];
      if (!tip) {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      return { ok: true, json: async () => ({ object: { sha: tip } }) };
    }

    // GET base branch
    if (method === 'GET' && pathMatch === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }

    // GET any commit
    if (method === 'GET' && pathMatch.startsWith('/git/commits/')) {
      const sha = pathMatch.replace('/git/commits/', '');
      const commitData = commits[sha];
      if (!commitData) {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      return { ok: true, json: async () => ({ tree: { sha: commitData.tree } }) };
    }

    // POST blobs
    if (method === 'POST' && pathMatch === '/git/blobs') {
      return { ok: true, json: async () => ({ sha: `blob-${Object.keys(commits).length}` }) };
    }

    // POST tree
    if (method === 'POST' && pathMatch === '/git/trees') {
      return { ok: true, json: async () => ({ sha: `tree-${Object.keys(commits).length}` }) };
    }

    // POST commit — record parents
    if (method === 'POST' && pathMatch === '/git/commits') {
      const body = JSON.parse(init.body);
      const commitSha = `commit-${Object.keys(commits).length}`;
      commits[commitSha] = { tree: body.tree, parents: body.parents };
      return { ok: true, json: async () => ({ sha: commitSha }) };
    }

    // POST ref (new branch)
    if (method === 'POST' && pathMatch === '/git/refs') {
      const body = JSON.parse(init.body);
      const branchName = body.ref.replace('refs/heads/', '');
      refs[branchName] = body.sha;
      return { ok: true, json: async () => ({}) };
    }

    // PATCH ref (update branch)
    if (method === 'PATCH' && pathMatch.startsWith('/git/refs/heads/')) {
      const branchName = pathMatch.replace('/git/refs/heads/', '');
      const body = JSON.parse(init.body);
      const newCommitSha = body.sha;
      const currentTip = refs[branchName];

      if (body.force === false) {
        // Check if currentTip is an ancestor of newCommitSha
        if (!isAncestor(currentTip, newCommitSha, commits)) {
          return {
            ok: false,
            status: 422,
            text: async () => 'Update is not a fast forward',
          };
        }
      }

      refs[branchName] = newCommitSha;
      return { ok: true, json: async () => ({}) };
    }

    throw new Error(`Unexpected call: ${method} ${pathMatch}`);
  };

  const isAncestor = (ancestor, descendant, commits) => {
    if (ancestor === descendant) return true;
    const commitData = commits[descendant];
    if (!commitData) return false;
    for (const parent of commitData.parents) {
      if (isAncestor(ancestor, parent, commits)) return true;
    }
    return false;
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  // First save — creates branch
  const firstCommitSha = await writer.commitFiles({
    baseBranch: 'main',
    branch: 'change-branch',
    files: [{ path: 'file1.md', content: 'first save', encoding: 'utf-8' }],
    message: 'First save',
  });

  const firstCallCount = calls.length;

  // Second save — updates branch
  const secondCommitSha = await writer.commitFiles({
    baseBranch: 'main',
    branch: 'change-branch',
    files: [{ path: 'file2.md', content: 'second save', encoding: 'utf-8' }],
    message: 'Second save',
  });

  // The second commit should have the first commit as a parent
  const secondCommitData = commits[secondCommitSha];
  assert.ok(secondCommitData, 'Second commit should exist');
  assert.ok(secondCommitData.parents.includes(firstCommitSha),
    `Second commit (${secondCommitSha}) should have first commit (${firstCommitSha}) as parent`);

  // Verify both saves used the expected call sequence
  const firstSaveSequence = calls.slice(0, firstCallCount);
  const expectedFirstSequence = [
    { method: 'GET', path: '/git/ref/heads/change-branch' },
    { method: 'GET', path: '/git/ref/heads/main' },
    { method: 'GET', path: '/git/commits/main-sha' },
    { method: 'POST', path: '/git/blobs' },
    { method: 'POST', path: '/git/trees' },
    { method: 'POST', path: '/git/commits' },
    { method: 'POST', path: '/git/refs' },
  ];
  assert.deepEqual(firstSaveSequence, expectedFirstSequence, 'First save sequence should match');

  const secondSaveSequence = calls.slice(firstCallCount);
  const expectedSecondSequence = [
    { method: 'GET', path: '/git/ref/heads/change-branch' },
    { method: 'GET', path: '/git/commits/' + firstCommitSha },
    { method: 'POST', path: '/git/blobs' },
    { method: 'POST', path: '/git/trees' },
    { method: 'POST', path: '/git/commits' },
    { method: 'PATCH', path: '/git/refs/heads/change-branch' },
  ];
  // Second sequence has dynamic commit sha, so check path prefix
  assert.equal(secondSaveSequence.length, expectedSecondSequence.length, 'Second save should have expected call count');
  assert.equal(secondSaveSequence[0].method, 'GET', 'Second save starts with GET branch');
  assert.equal(secondSaveSequence[5].method, 'PATCH', 'Second save ends with PATCH ref');
});

test('commitFiles with existing branch rejects non-fast-forward PATCH with 422', async () => {
  const commits = {}; // Map commit sha -> { tree, parents }
  const refs = {}; // Map branch name -> commit sha
  refs['main'] = 'main-sha';
  commits['main-sha'] = { tree: 'main-tree-sha', parents: [] };
  refs['diverged-branch'] = 'baseline-sha';
  commits['baseline-sha'] = { tree: 'main-tree-sha', parents: ['main-sha'] };

  let shouldFail = false;

  const fetchImpl = async (url, init) => {
    const method = init.method;
    const pathMatch = url.replace('https://api.github.com/repos/user/repo', '');

    // GET change branch (exists)
    if (method === 'GET' && pathMatch === '/git/ref/heads/diverged-branch') {
      return { ok: true, json: async () => ({ object: { sha: 'baseline-sha' } }) };
    }

    // GET baseline commit
    if (method === 'GET' && pathMatch === '/git/commits/baseline-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }

    // POST blobs
    if (method === 'POST' && pathMatch === '/git/blobs') {
      return { ok: true, json: async () => ({ sha: 'blob-sha' }) };
    }

    // POST tree
    if (method === 'POST' && pathMatch === '/git/trees') {
      return { ok: true, json: async () => ({ sha: 'new-tree-sha' }) };
    }

    // POST commit — record parents from the request body
    if (method === 'POST' && pathMatch === '/git/commits') {
      const body = JSON.parse(init.body);
      // If shouldFail, simulate creating a commit not descended from the branch
      // by intentionally giving it wrong parents
      const commitSha = `commit-${Object.keys(commits).length}`;
      if (shouldFail) {
        // Parent on main, not on the branch tip
        commits[commitSha] = { tree: body.tree, parents: ['main-sha'] };
      } else {
        commits[commitSha] = { tree: body.tree, parents: body.parents };
      }
      return { ok: true, json: async () => ({ sha: commitSha }) };
    }

    // PATCH ref should fail with 422 for non-fast-forward
    if (method === 'PATCH' && pathMatch === '/git/refs/heads/diverged-branch') {
      const body = JSON.parse(init.body);
      const newCommitSha = body.sha;
      const currentTip = refs['diverged-branch'];

      if (body.force === false) {
        // Check if currentTip is an ancestor of newCommitSha
        if (!isAncestor(currentTip, newCommitSha, commits)) {
          return {
            ok: false,
            status: 422,
            text: async () => 'Update is not a fast forward',
          };
        }
      }

      refs['diverged-branch'] = newCommitSha;
      return { ok: true, json: async () => ({}) };
    }

    throw new Error(`Unexpected call: ${method} ${pathMatch}`);
  };

  const isAncestor = (ancestor, descendant, commits) => {
    if (ancestor === descendant) return true;
    const commitData = commits[descendant];
    if (!commitData) return false;
    for (const parent of commitData.parents) {
      if (isAncestor(ancestor, parent, commits)) return true;
    }
    return false;
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  // Set flag to make the stub create a non-fast-forward commit
  shouldFail = true;

  await assert.rejects(
    writer.commitFiles({
      baseBranch: 'main',
      branch: 'diverged-branch',
      files: [{ path: 'file.md', content: 'content', encoding: 'utf-8' }],
      message: 'Diverged commit',
    }),
    /PATCH \/git\/refs\/heads\/diverged-branch -> 422/,
  );
});

test('commitFiles throws on non-2xx response with method, path, and status', async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && url.includes('/git/ref/heads/')) {
      return {
        ok: false,
        status: 404,
        text: async () => 'Branch not found',
      };
    }
    throw new Error('Should not reach here');
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await assert.rejects(
    writer.commitFiles({
      baseBranch: 'nonexistent',
      branch: 'new-branch',
      files: [{ path: 'file.md', content: 'content', encoding: 'utf-8' }],
      message: 'Test',
    }),
    /GET \/git\/ref\/heads\/nonexistent -> 404/,
  );
});

test('commitFiles throws with status in error message', async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST' && url.includes('/git/blobs')) {
      return {
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      };
    }
    if (init.method === 'GET' && url.includes('/git/ref/heads/')) {
      return { ok: true, json: async () => ({ object: { sha: 'base-sha' } }) };
    }
    if (init.method === 'GET' && url.includes('/git/commits/')) {
      return { ok: true, json: async () => ({ tree: { sha: 'tree-sha' } }) };
    }
    throw new Error('Unexpected');
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await assert.rejects(
    writer.commitFiles({
      baseBranch: 'main',
      branch: 'new-branch',
      files: [{ path: 'file.md', content: 'content', encoding: 'utf-8' }],
      message: 'Test',
    }),
    /401/,
  );
});

test('error messages never include the Authorization header or token', async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && url.includes('/git/ref/heads/')) {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error - secret data',
      };
    }
    throw new Error('Should not reach here');
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'super-secret-token-12345',
    fetchImpl,
  });

  try {
    await writer.commitFiles({
      baseBranch: 'main',
      branch: 'new-branch',
      files: [{ path: 'file.md', content: 'content', encoding: 'utf-8' }],
      message: 'Test',
    });
    assert.fail('Should have thrown');
  } catch (e) {
    const errorMsg = e.message;
    assert.doesNotMatch(errorMsg, /Authorization/i, 'Authorization header should not appear in error');
    assert.doesNotMatch(errorMsg, /Bearer/i, 'Bearer should not appear in error');
    assert.doesNotMatch(errorMsg, /super-secret-token/i, 'Token should not appear in error');
  }
});

test('fetch is injectable and tests stay offline', async () => {
  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl: mockFetch,
  });

  assert.ok(writer, 'Writer created with injected fetch');
  assert.equal(fetchCalled, false, 'Injected fetch not called until needed');
});

test('openDraftPr calls POST /pulls with correct parameters', async () => {
  let capturedBody = null;
  let capturedUrl = null;

  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ number: 123 }) };
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  const result = await writer.openDraftPr({
    branch: 'feature-branch',
    baseBranch: 'main',
    title: 'My PR',
    body: 'PR description',
  });

  assert.ok(capturedUrl.includes('/pulls'), 'POST /pulls endpoint');
  assert.equal(capturedBody.head, 'feature-branch');
  assert.equal(capturedBody.base, 'main');
  assert.equal(capturedBody.title, 'My PR');
  assert.equal(capturedBody.body, 'PR description');
  assert.equal(capturedBody.draft, true);
});

test('checksFor calls GET /commits/:ref/check-runs', async () => {
  let capturedPath = null;
  const fetchImpl = async (url, init) => {
    capturedPath = url.replace('https://api.github.com/repos/user/repo', '');
    return { ok: true, json: async () => ({ check_runs: [] }) };
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await writer.checksFor('abc123def');

  assert.equal(capturedPath, '/commits/abc123def/check-runs');
});

test('reviewsFor calls GET /pulls/:number/reviews', async () => {
  let capturedPath = null;
  const fetchImpl = async (url, init) => {
    capturedPath = url.replace('https://api.github.com/repos/user/repo', '');
    return { ok: true, json: async () => ({ reviews: [] }) };
  };

  const writer = createGitWriter({
    api: 'https://api.github.com',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  await writer.reviewsFor(42);

  assert.equal(capturedPath, '/pulls/42/reviews');
});
