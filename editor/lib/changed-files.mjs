// Changed files: compare exported entities against stored source.
// Saving without editing must produce no diff at all — that is a comparison against
// the imported source held in post meta (_jamground_source), never a
// re-derivation.
//
// Export each entity, compare the emitted bytes against the stored source, and
// return only the entities whose bytes differ; an empty set means the save
// commits nothing and opens no change.
//
// Kind-agnostic: `post.kind` came off the row readPosts built, which cross-checked it three
// ways, and is passed straight through. Nothing here re-derives it.
import { exportEntity } from './export.mjs';

/**
 * Compare exported posts against their stored source bytes.
 *
 * @param {Array} posts - Array of WordPress post objects with block markup and meta
 * @param {object} options
 * @param {object} options.api - Block API (createBlock, serialize, parse, getBlockType)
 * @param {Function} options.getUpdatedAt - Function returning current timestamp (ISO 8601 with Z)
 * @returns {Array} - Posts whose exported bytes differ from stored source
 * @throws {Error} - If any post lacks _jamground_source meta (no baseline, silently rewrites every file)
 */
export function getChangedFiles(posts, { api, getUpdatedAt }) {
  return posts.filter((post) => {
    const storedSource = post.meta?._jamground_source;
    if (storedSource === undefined) {
      throw new Error(
        `Post ${post.id} (_jamground_id: ${post.meta?._jamground_id}) lacks _jamground_source: missing baseline would silently rewrite the file`
      );
    }

    // Get the current frontmatter from post meta and post properties.
    // For now, assume frontmatter is available in post.frontmatter or can be reconstructed.
    const frontmatter = post.frontmatter;
    if (!frontmatter) {
      throw new Error(
        `Post ${post.id} lacks frontmatter data required for export`
      );
    }

    // Export the current entity to canonical format
    const exported = exportEntity({
      kind: post.kind,
      api,
      markup: post.content, // post_content is the block markup
      frontmatter,
      previousSlug: post.slug,
      updatedAt: getUpdatedAt(),
    });

    // Compare exported bytes against stored source
    return exported !== storedSource;
  });
}
