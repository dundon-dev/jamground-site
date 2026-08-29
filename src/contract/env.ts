/* Environment resolution. Resolve the content root from JAMGROUND_CONTENT_DIR
 * (defaulting to the sibling ../jamground-content), and read JAMGROUND_INCLUDE_DRAFTS
 * (defaulting off, hard error on any non-empty value other than '1'). Write a build manifest
 * to dist/ so production can be verified rather than assumed. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves the content root directory from the JAMGROUND_CONTENT_DIR environment variable,
 * defaulting to ../jamground-content. The environment variable points to the repository root,
 * so the actual content directory is contentRoot/content/.
 */
export function resolveContentRoot(): string {
  const contentRoot = process.env.JAMGROUND_CONTENT_DIR ?? '../jamground-content';
  const resolvedRoot = resolve(contentRoot);
  return resolve(resolvedRoot, 'content');
}

/**
 * Resolves the JAMGROUND_INCLUDE_DRAFTS environment variable.
 * - Defaults to false (drafts excluded)
 * - The string '1' enables drafts (true)
 * - Any other non-empty value throws a hard error
 * - Allows empty string or undefined (both default to false)
 */
export function resolveDraftFlag(): boolean {
  const raw = process.env.JAMGROUND_INCLUDE_DRAFTS;

  // Empty or undefined: default to false
  if (raw === undefined || raw === '') {
    return false;
  }

  // '1' enables drafts
  if (raw === '1') {
    return true;
  }

  // Any other non-empty value is a hard error
  throw new Error(
    `JAMGROUND_INCLUDE_DRAFTS must be '1' to enable drafts, or unset to disable them. ` +
    `Got: ${JSON.stringify(raw)} (typo publishing drafts)`,
  );
}

/**
 * Build manifest shape — written to dist/build-manifest.json so production builds can be
 * verified rather than assumed.
 */
export interface BuildManifest {
  contentRoot: string;
  includeDrafts: boolean;
  timestamp: string;
}

/**
 * Writes the build manifest to dist/build-manifest.json, recording the resolved content root
 * and draft flag so production deployments can be verified.
 */
export function writeBuildManifest(manifest: BuildManifest): void {
  // Ensure dist/ exists
  const distDir = resolve('dist');
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const manifestPath = resolve(distDir, 'build-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Convenience function that resolves both environment variables and writes the manifest.
 * Returns the resolved configuration.
 */
export function resolveEnv(): BuildManifest {
  const contentRoot = resolveContentRoot();
  const includeDrafts = resolveDraftFlag();
  const timestamp = new Date().toISOString();

  const manifest: BuildManifest = {
    contentRoot,
    includeDrafts,
    timestamp,
  };

  writeBuildManifest(manifest);

  return manifest;
}
