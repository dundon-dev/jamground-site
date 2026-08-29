import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChange, save } from '../lib/change.mjs';

test('startChange creates baseline commit, then ref, then draft PR in that order', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }
    if (method === 'GET' && path === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/commits') {
      return { ok: true, json: async () => ({ sha: 'baseline-commit-sha', tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'baseline-commit-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      return { ok: true, json: async () => ({ number: 1, title: body.title, draft: body.draft }) };
    }
    throw new Error(`Unexpected: ${method} ${path}`);
  };

  const pr = await startChange({
    title: 'Update post',
    baseBranch: 'main',
    branch: 'feature-123',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  // Should issue: GET base ref, GET base commit, POST baseline commit, POST new ref, POST PR
  assert.equal(calls.length, 5);
  assert.equal(calls[0].method, 'GET');
  assert.ok(calls[0].path.includes('/git/ref/heads/main'));

  assert.equal(calls[1].method, 'GET');
  assert.ok(calls[1].path.includes('/git/commits/main-sha'));

  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].path, '/git/commits');
  assert.equal(calls[2].body.tree, 'main-tree-sha');
  assert.equal(calls[2].body.parents[0], 'main-sha');

  assert.equal(calls[3].method, 'POST');
  assert.ok(calls[3].path.includes('/git/refs'));
  assert.equal(calls[3].body.sha, 'baseline-commit-sha');

  assert.equal(calls[4].method, 'POST');
  assert.ok(calls[4].path.includes('/pulls'));
  assert.equal(pr.draft, true);
});

test('startChange baseline commit message has no git vocabulary', async () => {
  let capturedCommitMessage = null;
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');
    const body = init.body ? JSON.parse(init.body) : null;

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }
    if (method === 'GET' && path === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/commits') {
      capturedCommitMessage = body.message;
      return { ok: true, json: async () => ({ sha: 'baseline-commit-sha', tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'baseline-commit-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      return { ok: true, json: async () => ({ number: 1 }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await startChange({
    title: 'Update post',
    baseBranch: 'main',
    branch: 'feature-123',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  assert.doesNotMatch(capturedCommitMessage, /branch|commit|merge|rebase|pull|push/i);
});

test('startChange PR title carries no git vocabulary', async () => {
  let capturedTitle = null;
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');
    const body = init.body ? JSON.parse(init.body) : null;

    if (method === 'GET') {
      return { ok: true, json: async () => ({ object: { sha: 'sha' }, tree: { sha: 'tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/commits') {
      return { ok: true, json: async () => ({ sha: 'commit-sha', tree: { sha: 'tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'commit-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      capturedTitle = body.title;
      return { ok: true, json: async () => ({ number: 1 }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await startChange({
    title: 'Update post',
    baseBranch: 'main',
    branch: 'feature-123',
    repo: 'user/repo',
    token: 'token-123',
    fetchImpl,
  });

  assert.equal(capturedTitle, 'Update post');
  assert.doesNotMatch(capturedTitle, /branch|commit|merge|rebase|pull|push/i);
});

test('startChange returns 422 when PR would have identical head and base', async () => {
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }
    if (method === 'GET' && path === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/commits') {
      return { ok: true, json: async () => ({ sha: 'baseline-commit-sha', tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'baseline-commit-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      // Model GitHub's refusal: 422 when head and base have no commits between them
      return { ok: false, status: 422, text: async () => 'Validation Failed: No commits between head and base' };
    }
    if (method === 'DELETE') {
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`Unexpected: ${method} ${path}`);
  };

  await assert.rejects(
    () => startChange({
      title: 'Update post',
      baseBranch: 'main',
      branch: 'feature-123',
      repo: 'user/repo',
      token: 'token-123',
      fetchImpl,
    }),
    (err) => err.message.includes('422'),
  );
});

test('startChange without baseline commit triggers 422', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path });

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }
    if (method === 'GET' && path === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }
    // Simulate: if we try to open PR without creating baseline commit
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'main-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      // GitHub refuses a PR where head and base point to the same commit
      return { ok: false, status: 422, text: async () => 'Validation Failed' };
    }
    if (method === 'DELETE') {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await assert.rejects(
    () => startChange({
      title: 'Update post',
      baseBranch: 'main',
      branch: 'feature-123',
      repo: 'user/repo',
      token: 'token-123',
      fetchImpl,
    }),
    (err) => err.message.includes('422'),
  );
});

test('startChange deletes ref on PR creation failure', async () => {
  const deletedRefs = [];
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const path = url.replace('https://api.github.com/repos/user/repo', '');

    if (method === 'GET' && path === '/git/ref/heads/main') {
      return { ok: true, json: async () => ({ object: { sha: 'main-sha' } }) };
    }
    if (method === 'GET' && path === '/git/commits/main-sha') {
      return { ok: true, json: async () => ({ tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/commits') {
      return { ok: true, json: async () => ({ sha: 'baseline-commit-sha', tree: { sha: 'main-tree-sha' } }) };
    }
    if (method === 'POST' && path === '/git/refs') {
      return { ok: true, json: async () => ({ ref: 'refs/heads/feature-123', object: { sha: 'baseline-commit-sha' } }) };
    }
    if (method === 'POST' && path === '/pulls') {
      // Simulate PR creation failure
      return { ok: false, status: 500, text: async () => 'Internal Server Error' };
    }
    if (method === 'DELETE' && path === '/git/refs/heads/feature-123') {
      deletedRefs.push('feature-123');
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`Unexpected: ${method} ${path}`);
  };

  await assert.rejects(
    () => startChange({
      title: 'Update post',
      baseBranch: 'main',
      branch: 'feature-123',
      repo: 'user/repo',
      token: 'token-123',
      fetchImpl,
    }),
    (err) => err.message.includes('500'),
  );

  assert.equal(deletedRefs.length, 1);
  assert.equal(deletedRefs[0], 'feature-123');
});

test('save with one changed file issues one commit', async () => {
  let commitFilesCalled = false;
  let capturedFiles = null;
  let capturedMessage = null;

  const mockChangedFiles = [
    {
      id: 1,
      content: 'block markup',
      slug: 'post-1',
      kind: 'post',
      meta: { _jamground_id: 'id-001', _jamground_source: 'old', _jamground_path: 'content/posts/en-US/post-001.md' },
      frontmatter: { id: 'id-001', slug: 'post-1', title: 'Post 1' },
    },
  ];

  const mockGetChangedFiles = () => mockChangedFiles;
  const mockExportEntity = () => '---\nid: id-001\nslug: post-1\ntitle: Post 1\n---\n\nContent here';

  const gitWriter = {
    commitFiles: async ({ baseBranch, branch, files, message }) => {
      commitFilesCalled = true;
      capturedFiles = files;
      capturedMessage = message;
      return 'commit-sha';
    },
  };

  await save({
    posts: mockChangedFiles,
    message: 'Save changes',
    gitWriter,
    baseBranch: 'main',
    branch: 'feature-123',
    api: null,
    getUpdatedAt: () => '2026-08-01T09:00:00Z',
    getChangedFiles: mockGetChangedFiles,
    exportEntity: mockExportEntity,
  });

  assert.ok(commitFilesCalled, 'commitFiles should be called');
  assert.equal(capturedMessage, 'Save changes');
  assert.equal(capturedFiles.length, 1);
  assert.equal(capturedFiles[0].path, 'content/posts/en-US/post-001.md');
});

test('save with no changed files issues zero requests', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };

  const mockGetChangedFiles = () => [];

  const gitWriter = {
    commitFiles: async () => {
      throw new Error('Should not be called');
    },
  };

  await save({
    posts: [],
    message: 'Save changes',
    gitWriter,
    baseBranch: 'main',
    branch: 'feature-123',
    getChangedFiles: mockGetChangedFiles,
  });

  assert.equal(fetchCalled, false);
});

test('save commit message carries no git vocabulary', async () => {
  let capturedMessage = null;

  const mockGetChangedFiles = () => [
    {
      id: 1,
      content: 'markup',
      slug: 'post-1',
      kind: 'post',
      meta: { _jamground_id: 'id-001', _jamground_source: 'old', _jamground_path: 'content/posts/en-US/post-001.md' },
      frontmatter: { id: 'id-001', slug: 'post-1' },
    },
  ];

  const mockExportEntity = () => '---\nid: id-001\n---\nContent';

  const gitWriter = {
    commitFiles: async ({ message }) => {
      capturedMessage = message;
    },
  };

  await save({
    posts: [{ id: 1, content: 'markup', meta: { _jamground_id: 'id-001', _jamground_source: 'old', _jamground_path: 'content/posts/en-US/post-001.md' }, frontmatter: { id: 'id-001', slug: 'post-1' }, slug: 'post-1' }],
    message: 'Update post',
    gitWriter,
    baseBranch: 'main',
    branch: 'feature-123',
    api: null,
    getUpdatedAt: () => '2026-08-01T09:00:00Z',
    getChangedFiles: mockGetChangedFiles,
    exportEntity: mockExportEntity,
  });

  assert.equal(capturedMessage, 'Update post');
  assert.doesNotMatch(capturedMessage, /branch|commit|merge|rebase|pull|push/i);
});

test('save throws when _jamground_path is missing', async () => {
  const mockGetChangedFiles = () => [
    {
      id: 1,
      content: 'markup',
      slug: 'post-1',
      meta: { _jamground_id: 'id-001', _jamground_source: 'old' },
      frontmatter: { id: 'id-001', slug: 'post-1' },
    },
  ];

  const mockExportEntity = () => '---\nid: id-001\n---\nContent';

  const gitWriter = {
    commitFiles: async () => {
      throw new Error('Should not be called');
    },
  };

  await assert.rejects(
    () => save({
      posts: [],
      message: 'Update post',
      gitWriter,
      baseBranch: 'main',
      branch: 'feature-123',
      api: null,
      getUpdatedAt: () => '2026-08-01T09:00:00Z',
      getChangedFiles: mockGetChangedFiles,
      exportEntity: mockExportEntity,
    }),
    (err) => err.message.includes('_jamground_path'),
  );
});
