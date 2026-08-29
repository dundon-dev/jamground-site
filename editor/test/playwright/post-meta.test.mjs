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
import { CONTENT_BLOB_BASE } from '../../config.mjs';
import { parseEntity } from '../../lib/entity.mjs';
import { listSeedEntities } from './seed-entities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

/* The seed entities are DISCOVERED, not listed, and the discovery is shared (see
 * ./seed-entities.mjs) and derived from the kind table. Naming them — as this file used to, by
 * URL and by contract id — tied an assertion about post meta to one repository's filenames at
 * one moment; the files it named no longer exist, and a fork's content repository was never
 * going to hold them. Filtering to `content/posts/**.md`, as it did next, was the same mistake
 * one level up: it pinned a stage of this editor rather than a property of import, and would
 * now report both pages as entities that failed to arrive. What is actually being asserted is
 * byte identity between what GitHub serves and what wp-admin stored, so the comparison is keyed
 * on `_jamground_path` — the path import itself recorded — and the expected bytes are fetched
 * from that same path. */

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

  // Pre-fetch every entity the repository actually holds, of every kind, keyed by its path.
  const seedEntities = await listSeedEntities();
  const seedPaths = seedEntities.map((e) => e.path);
  assert(
    seedEntities.length >= 1,
    'the content repository should expose at least one entity, or this test asserts nothing',
  );
  const seedPostsByPath = {};
  for (const { kind, path: seedPath } of seedEntities) {
    const content = await fetchSeedPostContent(`${CONTENT_BLOB_BASE}/${seedPath}`);
    seedPostsByPath[seedPath] = {
      kind,
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
        `'kind'=>get_post_meta(${id},'_jamground_kind',true),` +
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
      `every seed entity should have been imported; expected ${seedEntities.length}, got ${Object.keys(map).length}`,
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
      // The stored bytes must parse as the kind the row declares. This used to assert
      // `startsWith('---')`, which is a fact about the POST format — a page is a whole YAML
      // document with no fence, so that assertion would have failed every page here. Parsing
      // with the real parser is a stronger claim anyway: the bytes are a valid entity, not
      // merely a string beginning with three hyphens.
      assert(
        seedPostsByPath[meta.path],
        `_jamground_path should name a file the content repository holds; got ${JSON.stringify(meta.path)}, ` +
        `known: ${seedPaths.join(', ')}`
      );
      assert.equal(
        meta.kind,
        seedPostsByPath[meta.path].kind,
        `_jamground_kind should be the kind ${meta.path} implies, got ${JSON.stringify(meta.kind)}`
      );
      parseEntity(meta.kind, meta.path, meta.src);

      // The path import recorded is a real file in the repository (asserted just above, since
      // the kind check needs it too), and it is the file the stored bytes are compared
      // against — so an entity whose source was truncated or re-serialized fails here, and so
      // does one that recorded a path it never read.
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
