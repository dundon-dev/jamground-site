// The content source fetches entities from the public jamground-content repository.
// Both the tree and blob endpoints are public, so NO token or Authorization header
// is ever sent. The broker auth and user token are for the editor
// layer and do not belong here.

import { CONTENT_TREE_URL, CONTENT_BLOB_BASE } from '../config.mjs';
import { KIND_NAMES, kindSpec } from './kinds.mjs';

// Derived from the fork's own declaration (jamground.config.mjs, via ../config.mjs) rather
// than written here: the repository slug and branch are stated once and everything follows.
const TREE_URL = CONTENT_TREE_URL;
const BLOB_BASE = CONTENT_BLOB_BASE;

/**
 * List every entity of the requested kinds for one locale, with its bytes.
 *
 * THE KIND IS KNOWN FROM THE TREE AND TRAVELS WITH THE BYTES. `content/pages/en-US/home.yaml`
 * is a page because of where it sits and what it is called, and that is the only place in the
 * system where that has to be worked out — nothing downstream re-derives it from the path, so
 * nothing downstream can derive it differently.
 *
 * The membership test per kind is its directory plus its extension, both from the kind table:
 * other locales, other directories (`navigation/`, `settings/` — no kind claims them yet),
 * files at the repository root, and a file of the right kind with the wrong extension are all
 * excluded by it. Note that `authors/` and `pages/` share the `.yaml` extension and are told
 * apart by their directory, which is why the test is both halves rather than the extension.
 *
 * @param {Function} fetchImpl - injected for testing; the browser's fetch or a Node fetch
 * @param {string} locale - 'en-US', 'fr-FR', etc.
 * @param {string[]} kinds - which kinds to list; defaults to every declared kind
 * @returns {Promise<Array<{kind: string, path: string, bytes: Uint8Array}>>}
 */
export async function listEntities(fetchImpl, locale, kinds = KIND_NAMES) {
  // Fetch the tree to enumerate all files
  const treeRes = await fetchImpl(TREE_URL);
  if (!treeRes.ok) {
    throw new Error(`${treeRes.status} ${TREE_URL}`);
  }

  const treeData = await treeRes.json();

  const wanted = kinds.map((kind) => {
    const spec = kindSpec(kind, 'listEntities');
    return { kind, prefix: `content/${spec.dir}/${locale}/`, ext: spec.ext };
  });

  // Filter to this locale's entities of the requested kinds, in the tree's own order
  const found = [];
  for (const entry of treeData.tree) {
    const hit = wanted.find((w) => entry.path.startsWith(w.prefix) && entry.path.endsWith(w.ext));
    if (hit) found.push({ kind: hit.kind, path: entry.path });
  }

  // Fetch the blob for each entity
  const entities = [];
  for (const { kind, path } of found) {
    const blobUrl = `${BLOB_BASE}/${path}`;
    const blobRes = await fetchImpl(blobUrl);
    if (!blobRes.ok) {
      throw new Error(`${blobRes.status} ${blobUrl}`);
    }

    const bytes = new Uint8Array(await blobRes.arrayBuffer());
    entities.push({ kind, path, bytes });
  }

  return entities;
}

/** Posts only — the shape this module started as, kept for the callers whose subject really is
 *  posts (refuse-invalid.test.mjs's own importer among them). */
export async function listPosts(fetchImpl, locale) {
  return listEntities(fetchImpl, locale, ['post']);
}
