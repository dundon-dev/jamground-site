// The content source fetches posts from the public jamground-content repository.
// Both the tree and blob endpoints are public, so NO token or Authorization header
// is ever sent. The broker auth and user token are for the editor
// layer and do not belong here.

import { CONTENT_TREE_URL, CONTENT_BLOB_BASE } from '../config.mjs';

// Derived from the fork's own declaration (jamground.config.mjs, via ../config.mjs) rather
// than written here: the repository slug and branch are stated once and everything follows.
const TREE_URL = CONTENT_TREE_URL;
const BLOB_BASE = CONTENT_BLOB_BASE;

// locale: 'en-US', 'fr-FR', etc.
// fetchImpl: injected for testing; the browser's fetch or a Node fetch
// returns: Promise of [{ path: string, bytes: Uint8Array }, ...]
export async function listPosts(fetchImpl, locale) {
  // Fetch the tree to enumerate all files
  const treeRes = await fetchImpl(TREE_URL);
  if (!treeRes.ok) {
    throw new Error(`${treeRes.status} ${TREE_URL}`);
  }

  const treeData = await treeRes.json();
  const pattern = `content/posts/${locale}/`;

  // Filter to posts for this locale only
  const postPaths = treeData.tree
    .filter((entry) => entry.path.startsWith(pattern) && entry.path.endsWith('.md'))
    .map((entry) => entry.path);

  // Fetch the blob for each post
  const posts = [];
  for (const path of postPaths) {
    const blobUrl = `${BLOB_BASE}/${path}`;
    const blobRes = await fetchImpl(blobUrl);
    if (!blobRes.ok) {
      throw new Error(`${blobRes.status} ${blobUrl}`);
    }

    const bytes = new Uint8Array(await blobRes.arrayBuffer());
    posts.push({ path, bytes });
  }

  return posts;
}
