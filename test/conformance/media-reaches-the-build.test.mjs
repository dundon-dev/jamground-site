/* A media reference reaches the built site as bytes at the address it names.
 *
 * THIS IS THE ONLY TEST THAT CAN MAKE THIS CLAIM, and there were two ways to break it that
 * nothing else here would have noticed:
 *
 *   the astro.config.mjs integration stops calling copyMedia()  — the URL is right, nothing serves
 *   a route stops calling resolveBlockMedia()                    — nothing has media, so no throw
 *
 * Both are wiring, and wiring is exactly what a unit test cannot see. src/lib/media.ts's own tests
 * assert that `mediaSrc` roots a path and `copyMedia` copies a directory; test/blocks/render.test.mjs
 * asserts that a component handed an unresolved reference throws. Neither of them builds a site, so
 * neither can tell a build that carries media from one that merely could.
 *
 * SO IT BUILDS ONE, against a copy of the real content repository with one page and one image
 * added. A copy rather than a fabricated root, because the fixture has to survive the whole
 * contract — settings, navigation, the link index — and reproducing that here would be a second
 * content repository to keep in step. The conformance suite already builds against the sibling
 * repo (route-set-equality does), so depending on it is not a new dependency; the copy is what
 * keeps this test from writing into it.
 *
 * A REAL PNG, small but genuinely decodable, and the assertion is on its BYTES. Everything up to
 * this point answers from a directory listing and never opens a file, so a zero-byte fixture would
 * have been enough for all of them — and would have proved nothing about the one step that
 * actually moves bytes.
 *
 * THE HERO CARRIES NO CTA on purpose: a cta would drag link resolution into a test about media,
 * and a failure would then have two candidate causes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToTempDir, listFiles, cleanup } from './lib/build.mjs';
import { resolveContentRoot } from '../../src/contract/env.ts';

/* A 4x4 PNG. Written as base64 because a binary fixture cannot be committed to a repository whose
 * whole premise is that it holds no content — and because 85 bytes read as data, not as an asset
 * somebody has to maintain. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQIW2P8z8Dwn4EIwDiqkL4hRQCxYDgoBABZbAX9'
  + 'j4kfKgAAAABJRU5ErkJggg==',
  'base64',
);
const FILENAME = 'conformance-probe.png';
const SLUG = 'media-conformance-probe';

const PAGE = `id: 01M1D24P9D554W2HS4RXP4PQR1
translationOf: 01M1D24P9DXVEX7MZQ5Z4WEQR1
locale: en-US
slug: ${SLUG}
title: Media Conformance Probe
status: published
publishedAt: '2026-01-01T00:00:00Z'
updatedAt: '2026-01-01T00:00:00Z'
blocks:
  - type: hero
    heading: A heading
    media:
      ref: media/${FILENAME}
      alt: A probe image
`;

test('a media reference reaches dist/ as bytes, at the rooted URL the page emits', async () => {
  const before = process.env.JAMGROUND_CONTENT_DIR;
  const root = mkdtempSync(join(tmpdir(), 'jamground-media-conformance-'));
  let outDir;
  try {
    cpSync(resolveContentRoot(), join(root, 'content'), { recursive: true });
    mkdirSync(join(root, 'content', 'media'), { recursive: true });
    writeFileSync(join(root, 'content', 'media', FILENAME), PNG);
    writeFileSync(join(root, 'content', 'pages', 'en-US', `${SLUG}.yaml`), PAGE);
    process.env.JAMGROUND_CONTENT_DIR = root;

    outDir = await buildToTempDir();

    /* 1. The bytes are there, unchanged. `copyMedia` ran as part of the build. */
    assert.ok(
      listFiles(outDir).includes(`media/${FILENAME}`),
      `dist/ has no media/${FILENAME} — astro.config.mjs's integration did not copy the originals`,
    );
    assert.deepEqual(readFileSync(join(outDir, 'media', FILENAME)), PNG, 'the original was altered in transit');

    /* 2. The page points at them, rooted. A bare `media/…` here would be a URL relative to this
     *    page — `/en-us/<slug>/media/…` — which is the defect src/lib/media.ts exists to fix, and
     *    it would still contain the filename, so the assertion is on the leading slash. */
    const html = readFileSync(join(outDir, 'en-us', SLUG, 'index.html'), 'utf8');
    assert.match(
      html,
      new RegExp(`<img class="jp-hero__media" src="/media/${FILENAME}" alt="A probe image">`),
      'the page did not emit a rooted src — check that the route still calls resolveBlockMedia()',
    );

    /* 3. And the URL the page emits is the path the file is at. Derived from the HTML rather than
     *    written out again, so the two cannot be kept in step by accident. */
    const [, src] = html.match(/<img class="jp-hero__media" src="([^"]+)"/);
    assert.deepEqual(readFileSync(join(outDir, src)), PNG, `nothing is served at ${src}`);
  } finally {
    if (before === undefined) delete process.env.JAMGROUND_CONTENT_DIR;
    else process.env.JAMGROUND_CONTENT_DIR = before;
    rmSync(root, { recursive: true, force: true });
    if (outDir) cleanup(outDir);
  }
});
