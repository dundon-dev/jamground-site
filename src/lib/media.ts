/* Media: from a contract reference to a URL the built site actually serves.
 *
 * A `MediaRef.ref` is rooted at `content/` — `media/hero-a1b2c3.jpg` — never relative to the
 * entry file that carries it (02 §7; the leading `./` is prohibited by the schema precisely
 * because relative resolution put it at `content/pages/en-US/media/…`). That is a repository
 * path, not a URL, and until now it was rendered STRAIGHT INTO `src`, which made it a URL
 * relative to whatever page happened to be doing the rendering: `/en-us/about/media/x.jpg`,
 * which nothing ever wrote. Nothing copied `content/media/` into the build either, so both
 * halves were wrong at once and a page carrying an image would have 404'd. No content used one,
 * so nothing said so.
 *
 * The two halves are here: `mediaSrc` turns the reference into a rooted URL, and `copyMedia`
 * puts the bytes where that URL points.
 *
 * DERIVATIVES ARE NOT DONE, and this file should not be read as claiming otherwise. ADR-0009 and
 * 02 §7 both call for Astro's image pipeline to generate responsive sizes and modern formats at
 * build; this copies the original and serves it. That is the render half of R10 and it is what
 * makes an image appear at all — the pipeline is a separate piece of work, and belongs with the
 * upload half rather than in front of it.
 *
 * EXISTENCE IS TESTED AGAINST readdirSync, NEVER fs.existsSync — existsSync is case-insensitive
 * on APFS, so a reference whose case is wrong passes on a developer's Mac and fails in CI. Every
 * path under `content/` is ASCII and lowercase apart from the locale region subtag, which is what
 * makes a directory listing a total test rather than an approximation of one.
 *
 * NOTHING HERE IS CACHED AT MODULE SCOPE. src/lib/site-links.ts explains why for the link index
 * and the same applies: the test suite runs the build against three different
 * JAMGROUND_CONTENT_DIR values in one process, and a module-scope cache would serve the first
 * one's answer to all three. */

import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { resolveContentRoot } from '../contract/env.ts';

/** Where the originals live, for whichever content root is configured right now. */
function mediaDir(): string {
  return resolve(resolveContentRoot(), 'media');
}

/**
 * Every filename in `content/media/`, or an empty set when the directory does not exist —
 * which is the state of the seed content, and is not an error.
 */
export function getAvailableMedia(): Set<string> {
  try {
    return new Set(readdirSync(mediaDir(), { withFileTypes: false }));
  } catch {
    return new Set();
  }
}

/** Whether a `MediaRef.ref` names a file that is actually committed. */
export function mediaExists(ref: string): boolean {
  return getAvailableMedia().has(basename(ref));
}

/**
 * The URL for a media reference: rooted at the site, matching where `copyMedia` writes it.
 *
 * THROWS ON A MISSING FILE, and that is the same rule links are held to — a reference that
 * cannot be resolved fails the build rather than shipping as a broken `src`. A build that
 * silently emits a 404 is worse than one that stops, because the 404 is discovered by a reader.
 * The message names the directory searched, because the commonest cause is a content root that
 * is not the one the author had in mind.
 */
export function mediaSrc(ref: string): string {
  if (!mediaExists(ref)) {
    throw new Error(
      `media not found: ${ref} — no such file in ${mediaDir()} (INV-4). `
      + 'Media is referenced by a path rooted at content/, and the original must be committed.',
    );
  }
  return `/${ref}`;
}

/**
 * Copy the originals into the built site, at the path `mediaSrc` points to.
 *
 * A FLAT COPY, not a recursive one, because `MediaPath` permits no subdirectories — one level is
 * the whole shape the contract can express, so walking a tree would be handling a case the schema
 * makes unrepresentable. A directory that is not there copies nothing and is not an error: seed
 * content has no media, and a build of it should not fail for the lack of an empty directory.
 *
 * Returns what it copied, so the caller can say so rather than being silent about a step that
 * either happened or did not.
 */
export function copyMedia(outDir: string): string[] {
  const from = mediaDir();
  let names: string[];
  try {
    names = readdirSync(from, { withFileTypes: false });
  } catch {
    return [];
  }
  if (names.length === 0) return [];

  const to = join(outDir, 'media');
  mkdirSync(to, { recursive: true });
  for (const name of names) copyFileSync(join(from, name), join(to, name));
  return names;
}

/**
 * The absolute path of one committed original, by filename, or null.
 *
 * For the dev server, which serves `/media/<name>` straight out of the content repository rather
 * than copying anything. Traversal-safe WITHOUT a path check, because the answer comes from the
 * same directory listing `mediaExists` uses: `../../etc/passwd` is not a filename in that set, so
 * there is nothing to escape from. A `resolve()`-and-compare would be a second mechanism doing
 * the same job less obviously.
 */
export function mediaFile(name: string): string | null {
  return getAvailableMedia().has(name) ? join(mediaDir(), name) : null;
}

/* ---- Resolving a block list ------------------------------------------------------------- */

/** A block whose media has been resolved: the contract's `{ ref, alt?, decorative? }` replaced
 *  by the markup contract's `{ src, alt?, decorative? }`. Structural on purpose — this module
 *  cannot import the Block union without importing `zod` into a file the block-render harnesses
 *  compile without Vite, and the two renderers that consume it check the shape themselves. */
type WithMedia = { media: { ref: string; alt?: string; decorative?: boolean } };
type Resolved = { media: { src: string; alt?: string; decorative?: boolean } };

function resolveOne<T extends WithMedia>(block: T): Omit<T, 'media'> & Resolved {
  const { media, ...rest } = block;
  const { ref, ...keep } = media;
  return { ...rest, media: { ...keep, src: mediaSrc(ref) } };
}

/**
 * The media half of the same job `resolveBlockLinks` does for links, and it runs at the same
 * boundary for the same reason: a reference that cannot be resolved should fail during path
 * generation, before any HTML exists, rather than part-way through writing a page.
 *
 * IT IS A SEPARATE PASS RATHER THAN AN ARM OF resolveBlockLinks, because the two need different
 * things. A link needs the link index — every entity, the locale, the draft flag — which is why
 * its resolution is threaded down from a route. Media needs a directory listing and nothing else.
 * Folding them together would give link resolution a filesystem dependency and media resolution a
 * link index it has no use for.
 *
 * Two block types carry media: `hero`, where it is optional, and `image`, where it is the block.
 * Everything else passes through untouched.
 */
export type MediaResolved<T> = T extends WithMedia ? Omit<T, 'media'> & Resolved : T;

export function resolveBlockMedia<T extends { type: string }>(
  blocks: readonly T[],
): MediaResolved<T>[] {
  return blocks.map((block) => {
    if (block.type === 'image') return resolveOne(block as T & WithMedia);
    if (block.type === 'hero' && (block as Partial<WithMedia>).media) {
      return resolveOne(block as T & WithMedia);
    }
    return block;
  }) as MediaResolved<T>[];
}
