/* Image pipeline — derivatives from committed originals in content/media/.
 * Media references are rooted at content/, not relative to the entry file. Media existence is
 * tested against readdirSync, NEVER fs.existsSync — existsSync is case-insensitive on APFS,
 * so it passes on a developer's Mac and fails in CI. Every path under content/ is ASCII and
 * lowercase apart from the locale region subtag. Derivatives are generated at build time by
 * Astro's image pipeline from the binary originals committed to git. */

import { readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { MediaRef } from '../contract/defs.ts';
import { resolveContentRoot } from '../contract/env.ts';

/**
 * List all media files in content/media/ using readdirSync.
 * Returns a Set of filenames (not full paths) for efficient membership testing.
 * Returns empty set if content/media/ does not exist or is empty.
 */
export function getAvailableMedia(): Set<string> {
  const contentRoot = resolveContentRoot();
  const mediaDir = resolve(contentRoot, 'media');

  try {
    const files = readdirSync(mediaDir, { withFileTypes: false });
    return new Set(files);
  } catch {
    // content/media/ does not exist yet (e.g. when seed content has no MediaRef)
    return new Set();
  }
}

/**
 * Validate a MediaRef object structure.
 * Returns true if valid, false otherwise.
 * This is a simple structural check — the Zod schema in defs.ts is the authoritative validator.
 */
export function isValidMediaRef(value: unknown): value is MediaRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Must have a ref field that is a string
  if (typeof obj.ref !== 'string') {
    return false;
  }

  // Check MediaPath format: media/<lowercase-kebab>.<extension>
  const mediaPathRegex = /^media\/[a-z0-9]+(?:-[a-z0-9]+)*\.(jpg|png|webp|avif|gif|svg)$/;
  if (!mediaPathRegex.test(obj.ref)) {
    return false;
  }

  // If decorative: true, must not have alt field
  if (obj.decorative === true) {
    return obj.alt === undefined;
  }

  // Otherwise (decorative absent or false), must have alt string
  if (typeof obj.alt !== 'string' || obj.alt.length === 0) {
    return false;
  }

  return true;
}

/**
 * Check if a media reference exists in content/media/.
 * Uses readdirSync to check against actual directory listing.
 * Returns true if the file exists, false otherwise.
 */
export function mediaExists(ref: string): boolean {
  // Extract filename from ref (e.g., "media/hero-a1b2c3.jpg" -> "hero-a1b2c3.jpg")
  const filename = basename(ref);

  const available = getAvailableMedia();
  return available.has(filename);
}

/**
 * Validate a MediaRef and check that the original media file exists.
 * Throws an error if the reference is invalid or the file does not exist.
 */
export function validateMediaRef(value: unknown): MediaRef {
  if (!isValidMediaRef(value)) {
    throw new Error(`Invalid MediaRef: ${JSON.stringify(value)}`);
  }

  // Check that the file actually exists
  if (!mediaExists(value.ref)) {
    throw new Error(`Media file not found: ${value.ref}`);
  }

  return value;
}

/**
 * Get metadata for a media reference for use in generating derivatives.
 * Returns the filename, extension, and whether the file exists.
 */
export function getMediaMetadata(ref: string): {
  filename: string;
  extension: string;
  exists: boolean;
} {
  const filename = basename(ref);
  const parts = filename.split('.');
  const extension = parts[parts.length - 1] || '';

  return {
    filename,
    extension,
    exists: mediaExists(ref),
  };
}
