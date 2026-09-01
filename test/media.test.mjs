/* src/lib/media.ts — from a contract reference to a URL the built site serves, and the bytes
 * that make that URL answer.
 *
 * WHAT THIS FILE USED TO BE, said out loud because the shape of it was the problem. It tested
 * `isValidMediaRef` and `validateMediaRef`, which reimplemented `MediaRef` from
 * src/contract/defs.ts in a hand-written regex and a chain of `if`s — a duplicate of a normative
 * schema, which CLAUDE.md forbids for the obvious reason. Nothing imported either function; they
 * existed to be tested. And the tests that touched the filesystem asserted around its absence
 * ("might be empty if content/media/ hasn't been created yet"), including one that caught its own
 * expected failure and passed either way. The duplicated validators are gone and the filesystem
 * ones now build a real content root, so both directions of every claim are observable.
 *
 * A CONTENT ROOT PER TEST, restored afterwards. `resolveContentRoot()` reads the environment on
 * every call precisely so this is possible (see src/lib/site-links.ts's note on why nothing
 * caches it), and node:test runs this whole file in one process, so a test that left the variable
 * set would silently decide the next one's answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  getAvailableMedia, mediaExists, mediaSrc, mediaFile, copyMedia, resolveBlockMedia,
} = await import('../src/lib/media.ts');

/**
 * Run `body` against a content root holding exactly `files`, then put the environment back.
 *
 * `files` is a map of filename to contents; the contents are almost always irrelevant, because
 * everything except `copyMedia` answers from the directory LISTING and never opens a file — which
 * is what lets a repository holding no content test media without committing a binary.
 *
 * `null` for `files` means the content root exists but `media/` does not, which is the state of
 * the seed content and is the case most of these functions have a specific answer for.
 */
function withMedia(files, body) {
  const before = process.env.JAMGROUND_CONTENT_DIR;
  const root = mkdtempSync(join(tmpdir(), 'jamground-media-test-'));
  try {
    mkdirSync(join(root, 'content'), { recursive: true });
    if (files) {
      const dir = join(root, 'content', 'media');
      mkdirSync(dir);
      for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
    }
    process.env.JAMGROUND_CONTENT_DIR = root;
    return body(root);
  } finally {
    if (before === undefined) delete process.env.JAMGROUND_CONTENT_DIR;
    else process.env.JAMGROUND_CONTENT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
}

/* ---- The listing ------------------------------------------------------------------------ */

test('getAvailableMedia — the filenames actually committed', () => {
  withMedia({ 'a.jpg': '', 'hero-a1b2c3.png': '' }, () => {
    assert.deepEqual([...getAvailableMedia()].sort(), ['a.jpg', 'hero-a1b2c3.png']);
  });
});

test('getAvailableMedia — an absent content/media/ is empty, not an error', () => {
  withMedia(null, () => {
    assert.deepEqual([...getAvailableMedia()], []);
  });
});

/* The reason src/lib/media.ts says readdirSync and NEVER existsSync: existsSync is
 * case-insensitive on APFS, so a reference whose case is wrong passes on a Mac and fails in CI.
 * A directory listing has no such opinion, which is what makes this assertion hold on both. */
test('mediaExists — is case-sensitive, which existsSync on APFS is not', () => {
  withMedia({ 'hero-a1b2c3.jpg': '' }, () => {
    assert.equal(mediaExists('media/hero-a1b2c3.jpg'), true);
    assert.equal(mediaExists('media/Hero-A1B2C3.jpg'), false);
  });
});

test('mediaExists — false for a file that is not there', () => {
  withMedia({ 'a.jpg': '' }, () => {
    assert.equal(mediaExists('media/nope.jpg'), false);
  });
});

/* ---- The URL ---------------------------------------------------------------------------- */

test('mediaSrc — a content path becomes a rooted URL', () => {
  withMedia({ 'hero-a1b2c3.jpg': '' }, () => {
    assert.equal(mediaSrc('media/hero-a1b2c3.jpg'), '/media/hero-a1b2c3.jpg');
  });
});

/* The defect this whole module exists to fix: a bare `media/x.jpg` in `src` is a URL relative to
 * whatever page is rendering, so the same reference resolved to a different (and always wrong)
 * address on every page that used it. The leading slash is the entire difference. */
test('mediaSrc — the URL does not depend on the page rendering it', () => {
  withMedia({ 'x.jpg': '' }, () => {
    assert.equal(mediaSrc('media/x.jpg').startsWith('/'), true);
  });
});

test('mediaSrc — a missing original fails the build, and says where it looked', () => {
  withMedia({ 'a.jpg': '' }, (root) => {
    assert.throws(() => mediaSrc('media/missing.jpg'), (error) => {
      assert.match(error.message, /media not found: media\/missing\.jpg/);
      assert.match(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  });
});

test('mediaSrc — an absent content/media/ fails rather than emitting a broken src', () => {
  withMedia(null, () => {
    assert.throws(() => mediaSrc('media/a.jpg'), /media not found/);
  });
});

/* ---- The dev server's lookup ------------------------------------------------------------ */

test('mediaFile — the absolute path of a committed original', () => {
  withMedia({ 'a.jpg': '' }, (root) => {
    assert.equal(mediaFile('a.jpg'), join(root, 'content', 'media', 'a.jpg'));
  });
});

/* Traversal-safe by construction rather than by a path check: the answer comes from the same
 * directory listing everything else uses, and no traversal string is a filename in it. */
test('mediaFile — null for anything not in the listing, traversal included', () => {
  withMedia({ 'a.jpg': '' }, () => {
    assert.equal(mediaFile('b.jpg'), null);
    assert.equal(mediaFile('../../../etc/passwd'), null);
    assert.equal(mediaFile('..'), null);
  });
});

/* ---- The copy --------------------------------------------------------------------------- */

test('copyMedia — the originals land where mediaSrc points, contents intact', () => {
  withMedia({ 'a.jpg': 'AAA', 'b.png': 'BBB' }, () => {
    const out = mkdtempSync(join(tmpdir(), 'jamground-out-'));
    try {
      assert.deepEqual(copyMedia(out).sort(), ['a.jpg', 'b.png']);
      assert.deepEqual(readdirSync(join(out, 'media')).sort(), ['a.jpg', 'b.png']);
      /* The URL mediaSrc produces is `/media/a.jpg`; the file is at `<out>/media/a.jpg`. That the
       * two agree is the claim, and it is one assertion rather than two constants. */
      assert.equal(readFileSync(join(out, mediaSrc('media/a.jpg')), 'utf8'), 'AAA');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

test('copyMedia — no content/media/ copies nothing and does not fail the build', () => {
  withMedia(null, () => {
    const out = mkdtempSync(join(tmpdir(), 'jamground-out-'));
    try {
      assert.deepEqual(copyMedia(out), []);
      assert.deepEqual(readdirSync(out), []);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

/* ---- The block pass --------------------------------------------------------------------- */

test('resolveBlockMedia — an image block carries src, and ref is gone', () => {
  withMedia({ 'a.jpg': '' }, () => {
    const [block] = resolveBlockMedia([
      { type: 'image', media: { ref: 'media/a.jpg', alt: 'Alt text' }, caption: 'A caption' },
    ]);
    assert.deepEqual(block, {
      type: 'image', media: { alt: 'Alt text', src: '/media/a.jpg' }, caption: 'A caption',
    });
  });
});

test('resolveBlockMedia — decorative survives the pass, since it is not alt', () => {
  withMedia({ 'b.jpg': '' }, () => {
    const [block] = resolveBlockMedia([{ type: 'image', media: { ref: 'media/b.jpg', decorative: true } }]);
    assert.deepEqual(block.media, { decorative: true, src: '/media/b.jpg' });
  });
});

test('resolveBlockMedia — a hero with media is resolved, one without is untouched', () => {
  withMedia({ 'h.jpg': '' }, () => {
    const [withIt, without] = resolveBlockMedia([
      { type: 'hero', heading: 'H', media: { ref: 'media/h.jpg', alt: 'A' } },
      { type: 'hero', heading: 'H' },
    ]);
    assert.equal(withIt.media.src, '/media/h.jpg');
    assert.deepEqual(without, { type: 'hero', heading: 'H' });
  });
});

/* The pass must not be a transform over every block — a cta's `link` and a list's `items` are
 * nobody's business here, and a pass that rebuilt them would be a second place they could change. */
test('resolveBlockMedia — every other type comes back the same object', () => {
  withMedia({ 'a.jpg': '' }, () => {
    const blocks = [
      { type: 'paragraph', text: 'p' },
      { type: 'cta', heading: 'H', link: { label: 'L', href: '/x/' } },
      { type: 'list', items: [{ text: 'One' }] },
    ];
    const out = resolveBlockMedia(blocks);
    for (const [i, block] of blocks.entries()) assert.equal(out[i], block);
  });
});

test('resolveBlockMedia — a reference to an uncommitted original fails the build', () => {
  withMedia({ 'a.jpg': '' }, () => {
    assert.throws(
      () => resolveBlockMedia([{ type: 'image', media: { ref: 'media/gone.jpg', alt: 'A' } }]),
      /media not found: media\/gone\.jpg/,
    );
  });
});
