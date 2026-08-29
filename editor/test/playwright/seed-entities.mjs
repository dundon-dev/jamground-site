/* What the content repository actually holds, asked OF THE REPOSITORY and THROUGH THE KIND
 * TABLE — never written down here.
 *
 * Four Playwright files need this and each used to carry its own copy filtered to
 * `content/posts/**.md`. That was a fact about one stage of this editor rather than about
 * import: pages and authors are imported now, so a posts-only count reports both as entities
 * that failed to arrive, and four copies of the same wrong filter have to be found and fixed
 * separately. Deriving from `KINDS` means a kind added to editor/lib is covered here without
 * editing any of them — the author kind was, and none of the four needed a new count.
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
/* THE HARNESS MAY AUTHENTICATE; THE PRODUCT MAY NOT.
 *
 * `api.github.com` allows 60 unauthenticated requests per hour per IP. A full pass of this
 * suite spends roughly half of that — one tree fetch here per file, plus one from inside each
 * browser boot — so two runs exhaust it, and the third fails in about a second with rejections
 * that look nothing like a test failure. That is not hypothetical: it happened twice while
 * verifying this stage, and the second time it was misread as a regression.
 *
 * A token here costs nothing and is not a contradiction. editor/lib/content-source.mjs sends
 * no Authorization header ever — that is a product property, asserted by
 * editor/test/content-source.test.mjs, and it stays exactly as it is. This is the test harness
 * asking the repository what it contains, which is a different actor with a different budget.
 * Absent a token it simply carries on unauthenticated, so nothing here requires one. */
function harnessAuthHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}`, 'User-Agent': 'jamground-tests' } : {};
}

export async function listSeedEntities() {
  const res = await fetch(CONTENT_TREE_URL, { headers: harnessAuthHeaders() });
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
