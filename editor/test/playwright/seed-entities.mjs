/* What the content repository actually holds, asked OF THE REPOSITORY and THROUGH THE KIND
 * TABLE — never written down here.
 *
 * Three Playwright files need this and each used to carry its own copy filtered to
 * `content/posts/**.md`. That was a fact about one stage of this editor rather than about
 * import: pages are imported now, so a posts-only count reports the pages as entities that
 * failed to arrive, and three copies of the same wrong filter have to be found and fixed
 * separately. Deriving from `KINDS` means a kind added to editor/lib is covered here without
 * editing any of them.
 *
 * Not a test file, and it never runs as one: editor's test script is
 * `node --test 'test/*.test.mjs'`, which is non-recursive, and this sits a directory deeper.
 */
import { KINDS, KIND_NAMES } from '../../lib/kinds.mjs';
import { CONTENT_TREE_URL } from '../../config.mjs';

/** Every entity file the content repository holds, as `{ kind, path }`, sorted by path.
 *  Breadth is deliberately every locale, as the per-file copies of this were: import runs for
 *  one locale, and a fork holding a second one should fail this loudly rather than quietly
 *  counting a subset. */
export async function listSeedEntities() {
  const res = await fetch(CONTENT_TREE_URL);
  if (!res.ok) throw new Error(`Failed to fetch the content tree: ${res.status} ${CONTENT_TREE_URL}`);
  const data = await res.json();
  const paths = (data.tree || []).filter((e) => typeof e.path === 'string').map((e) => e.path);

  const found = [];
  for (const kind of KIND_NAMES) {
    const { dir, ext } = KINDS[kind];
    for (const p of paths) {
      if (p.startsWith(`content/${dir}/`) && p.endsWith(ext)) found.push({ kind, path: p });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The distinct WordPress post types those entities are filed as — what an `edit.php`
 *  list view has to be asked about, one navigation per type. */
export function wpPostTypesOf(entities) {
  return [...new Set(entities.map((e) => KINDS[e.kind].wpPostType))];
}
