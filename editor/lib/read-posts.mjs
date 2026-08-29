// Read posts back out of the WASM instance (the reverse of
// editor/lib/import.mjs). getChangedFiles operates on POSTS, and the only route out of the
// WASM instance is `client.run({ code: '<?php …' })` — the same shape import.mjs uses to go
// the other way, its PHP held as a module constant and written to the WASM filesystem before
// it runs.
//
// This reads whatever WordPress has already persisted to its own database. It
// does NOT attempt to dispatch Gutenberg's own save from the host page across the Playground
// boundary: with `remoteUrl` pointing at playground.wordpress.net the iframe is cross-origin,
// and the shell cannot read or manipulate the editor DOM from outside it — any feature needing
// that would require self-hosting Playground on our own origin, which this project does not
// do. There is no channel through which host-page JS could reach into the iframe's
// React/Redux state and force an unsaved edit to flush, so there is no candidate
// implementation for driving a save directly — reading the database after the fact is the
// deliberate fallback, not a silent substitution.
//
// What this still gets right: an edit persisted by wp-admin's own Save/Update (an ordinary
// use of wp-admin, not a separate export step) is already in the database by the time an
// editor reaches for the shell's own `save` control, because pressing Update is how any
// Gutenberg edit reaches storage at all — nothing else, ours or WordPress's, can move it
// there. Saving finds it there and commits it truthfully; saving before that press finds
// nothing changed and says so, which is an accepted cost, not a defect.
import { parsePost } from './entity.mjs';

// Every field getChangedFiles/change.mjs need: the block markup (`post_content`), the slug
// WordPress currently has (`post_name`), and the two meta values import.mjs's import path wrote.
// Read as plain scalars into an array we build ourselves, never `json_encode`d WP_Post
// objects, so there is nothing WordPress's own object shape can leak into the result.
//
// The `meta_query` restricts this to posts our own import path created. A fresh WordPress
// install seeds its own "Hello World!" post (WP post ID 1) — never touched by import.mjs,
// never carrying `_jamground_id` — and without this filter every save would find it and
// throw for lacking a baseline it was never given, on every boot, for a post no editor
// asked the shell to manage.
const READ_POSTS_PHP = `<?php
require __DIR__ . '/wp-load.php';
$posts = get_posts([
  'post_type'   => 'post',
  'post_status' => ['publish', 'draft', 'pending', 'future', 'private'],
  'numberposts' => -1,
  'meta_query'  => [
    ['key' => '_jamground_id', 'compare' => 'EXISTS'],
  ],
]);
$out = [];
foreach ($posts as $p) {
  $out[] = [
    'id'      => $p->ID,
    'content' => $p->post_content,
    'title'   => $p->post_title,
    'slug'    => $p->post_name,
    'meta'    => [
      '_jamground_id'     => get_post_meta($p->ID, '_jamground_id', true),
      '_jamground_source' => get_post_meta($p->ID, '_jamground_source', true),
      '_jamground_path'   => get_post_meta($p->ID, '_jamground_path', true),
    ],
  ];
}
echo json_encode($out);
`;

/**
 * COUPLED TO import.mjs, WHICH DOES NOT YET HOLD UP ITS END. This
 * module trusts `post_name` as the current slug, which is only true if WordPress's own value
 * starts out equal to the baseline's — and `import.mjs`'s `wp_insert_post()` call never sets
 * `post_name`, so WordPress derives it from `post_title` via `sanitize_title()`. Proved live:
 * the real "Announcing Jamground" seed post carries contract slug `launch`, so its freshly
 * imported `post_name` is `announcing-jamground` before any editor touches it, and every
 * unedited save reads that as a slug change forever — write-path.test.mjs's own "nothing
 * edited" step fails against this file's fix for exactly that reason. The remedy belongs to
 * `import.mjs` (seed `post_name` from the contract's `slug` at insert time), which this
 * module cannot do on its own.
 *
 * Read every post currently in the WASM instance's own database, with its block markup and
 * the `_jamground_id` / `_jamground_source` meta import.mjs wrote, and reconstruct the
 * contract envelope (`frontmatter`) each post needs for export by parsing the stored baseline
 * source and laying the fields wp-admin can actually change over it. Most envelope fields —
 * `id`, `translationOf`, `locale`, `seo`, `sourceHash`, `status`, `publishedAt` — have no
 * control anywhere in the allowlisted editing surface and stay the baseline's. Two do not:
 * `title` <- `post_title` (required, and wp-admin is the only place an editor types it) and
 * `slug` <- `post_name` (mutable and URL-facing, and the `slugHistory` growth on export is
 * unreachable without it). `slugHistory` and `updatedAt` stay the
 * baseline's too — export.mjs grows the former when `frontmatter.slug` differs from the
 * `previousSlug` this module returns at the top level, and the writer (editor/entry.mjs)
 * decides the latter itself; this module must not touch it, or a fresh clock here would make
 * every post look changed on every save from timestamp drift alone.
 *
 * The top-level `slug` this returns is deliberately the BASELINE's — never `row.slug` — so
 * `changed-files.mjs` / `change.mjs` can pass it to `exportPost` as `previousSlug`: "the slug
 * the file on disk currently has" (export.mjs), which is what a genuine slug edit needs to be
 * compared against.
 *
 * @param {object} deps
 * @param {object} deps.client - the Playground client (documentRoot, writeFile, run)
 * @returns {Promise<Array>} - posts shaped for changed-files.mjs / change.mjs:
 *   { id, content, slug, frontmatter, meta: { _jamground_id, _jamground_source } }
 * @throws {Error} - if a post lacks `_jamground_source`; naming it rather than silently
 *   treating it as unchanged or as changed
 */
export async function readPosts({ client }) {
  const root = await client.documentRoot;
  await client.writeFile(root + '/jp-read-posts.php', READ_POSTS_PHP);
  const result = await client.run({ code: `<?php require '${root}/jp-read-posts.php';` });
  const rows = JSON.parse(result.text);

  return rows.map((row) => {
    const source = row.meta && row.meta._jamground_source;
    if (!source) {
      throw new Error(
        `readPosts: post ${row.id} (_jamground_id: ${row.meta && row.meta._jamground_id}) lacks _jamground_source: missing baseline would silently rewrite the file`
      );
    }
    const { frontmatter: baseline } = parsePost(`post-${row.id}`, source);
    // `post_name` is WordPress's own, and it is EMPTY for a post that has never been
    // published — WordPress does not assign a permalink slug to a draft until its first
    // publish, so every fresh import of a draft seed post reads `''` here regardless of
    // anything an editor typed. `'' || baseline.slug` falls back to the committed slug in
    // that one case; a genuine editorial slug can never BE `''` (the contract's own regex
    // refuses it), so this cannot mask a real edit, only WordPress's own placeholder.
    const frontmatter = { ...baseline, title: row.title, slug: row.slug || baseline.slug };
    return {
      id: row.id,
      content: row.content,
      slug: baseline.slug,
      frontmatter,
      meta: {
        _jamground_id: row.meta._jamground_id,
        _jamground_source: source,
        _jamground_path: row.meta._jamground_path,
      },
    };
  });
}
