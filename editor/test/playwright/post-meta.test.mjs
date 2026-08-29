// Post meta round-trip: _jamground_id and _jamground_source byte-identity
//
// Asserts that post meta holds the contract id and the
// fetched source verbatim. The source comparison uses SHA-256 to detect any
// truncation or re-serialization that would pass a simple string check.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { CONTENT_BLOB_BASE, CONTENT_TREE_URL } from '../../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

/* The seed posts are DISCOVERED, not listed. Naming them — as this file used to, by URL and
 * by contract id — tied an assertion about post meta to one repository's filenames at one
 * moment; the files it named no longer exist, and a fork's content repository was never going
 * to hold them. What is actually being asserted is byte identity between what GitHub serves
 * and what wp-admin stored, so the comparison is keyed on `_jamground_path` — the path import
 * itself recorded — and the expected bytes are fetched from that same path. Nothing here has
 * to know what the repository contains. */
async function listSeedPosts() {
  const res = await fetch(CONTENT_TREE_URL);
  if (!res.ok) throw new Error(`Failed to fetch the content tree: ${res.status} ${CONTENT_TREE_URL}`);
  const data = await res.json();
  return (data.tree || [])
    .map((entry) => entry.path)
    .filter((p) => typeof p === 'string' && p.startsWith('content/posts/') && p.endsWith('.md'))
    .sort();
}

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, {
    cwd: editorDir,
    stdio: 'pipe',
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(distDir, 'index.html')).then((content) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        });
      } else {
        const filePath = path.join(distDir, req.url);
        fs.readFile(filePath).then(
          (content) => {
            const contentType = req.url.endsWith('.js') ? 'application/javascript' : 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
          },
          () => {
            res.writeHead(404);
            res.end('Not found');
          }
        );
      }
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function calculateSha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function fetchSeedPostContent(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }
  return response.text();
}

test('post-meta: _jamground_id and _jamground_source round-trip with byte identity', async () => {
  await buildBundle();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  // Pre-fetch every locale post the repository actually holds, keyed by its path.
  const seedPaths = await listSeedPosts();
  assert(
    seedPaths.length >= 1,
    'the content repository should expose at least one locale post, or this test asserts nothing',
  );
  const seedPostsByPath = {};
  for (const seedPath of seedPaths) {
    const content = await fetchSeedPostContent(`${CONTENT_BLOB_BASE}/${seedPath}`);
    seedPostsByPath[seedPath] = {
      bytes: content,
      hash: calculateSha256(content),
    };
  }

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => {
      return window.jamgroundReady === true || typeof window.jamgroundBootError !== 'undefined';
    }, { timeout: 240000 });

    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    const importError = await page.evaluate(() => window.jamgroundImportError);
    assert(!importError, `Import should not throw: ${importError}`);

    const map = await page.evaluate(() => window.jamgroundImportResult);
    assert(map, 'import should have produced a contract-id -> post-id map');

    // Query post meta for all imported posts
    const metaByPostId = await page.evaluate(async (map) => {
      const c = window.jamgroundClient;
      const root = await c.documentRoot;
      const ids = Object.values(map);
      const phpEntries = ids.map((id) =>
        `$out[${JSON.stringify(String(id))}] = [` +
        `'jid'=>get_post_meta(${id},'_jamground_id',true),` +
        `'src'=>get_post_meta(${id},'_jamground_source',true),` +
        `'path'=>get_post_meta(${id},'_jamground_path',true),` +
        `'media_ref'=>get_post_meta(${id},'_jamground_media_ref',true)` +
        `];`
      ).join('\n');
      const code = `<?php require '${root}/wp-load.php'; $out = []; ${phpEntries} echo json_encode($out);`;
      const s = await c.run({ code });
      return JSON.parse(s.text);
    }, map);

    // Every post the repository holds was imported — without this the loop below could pass
    // by importing one post out of five and checking that one carefully.
    assert.equal(
      Object.keys(map).length,
      seedPaths.length,
      `every seed post should have been imported; expected ${seedPaths.length}, got ${Object.keys(map).length}`,
    );

    // Verify each imported post's meta
    for (const [contractId, postId] of Object.entries(map)) {
      const meta = metaByPostId[String(postId)];
      assert(meta, `post meta should exist for post ${postId}`);

      // 1. _jamground_id must equal the contract id
      assert.equal(
        meta.jid,
        contractId,
        `_jamground_id should equal contract id; expected ${contractId}, got ${meta.jid}`
      );

      // 2. _jamground_source must be byte-identical to the fetched file
      assert(
        typeof meta.src === 'string',
        `_jamground_source should be a string, got ${typeof meta.src}`
      );
      assert(
        meta.src.startsWith('---'),
        '_jamground_source should start with frontmatter fence'
      );

      // The path import recorded is a real file in the repository, and it is the file the
      // stored bytes are compared against — so a post whose source was truncated or
      // re-serialized fails here, and so does one that recorded a path it never read.
      assert(
        seedPostsByPath[meta.path],
        `_jamground_path should name a file the content repository holds; got ${JSON.stringify(meta.path)}, ` +
        `known: ${seedPaths.join(', ')}`
      );

      // Calculate SHA-256 of the stored meta value
      const storedHash = calculateSha256(meta.src);
      const expectedHash = seedPostsByPath[meta.path].hash;
      assert.equal(
        storedHash,
        expectedHash,
        `_jamground_source SHA-256 mismatch for contract ${contractId} at ${meta.path}: ` +
        `stored=${storedHash}, expected=${expectedHash}`
      );

      // 3. No _jamground_media_ref should exist (seed repo has no media)
      assert(
        !meta.media_ref,
        `_jamground_media_ref should not exist for posts without media, ` +
        `but found: ${meta.media_ref}`
      );
    }
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
