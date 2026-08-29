// Read entities back out of the WASM instance (the reverse of
// editor/lib/import.mjs). getChangedFiles operates on WordPress rows, and the only route out of
// the WASM instance is `client.run({ code: '<?php …' })` — the same shape import.mjs uses to go
// the other way, its PHP held as a module constant and written to the WASM filesystem before
// it runs. Every row carries the kind it belongs to, cross-checked three ways below.
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
import { parseEntity } from './entity.mjs';
import { WP_POST_TYPES, kindForPath, kindForWpPostType } from './kinds.mjs';

// Every field getChangedFiles/change.mjs need: the block markup (`post_content`), the slug
// WordPress currently has (`post_name`), WordPress's own `post_type`, and the meta values
// import.mjs's import path wrote. Read as plain scalars into an array we build ourselves, never
// `json_encode`d WP_Post objects, so there is nothing WordPress's own object shape can leak
// into the result.
//
// `post_type` is EVERY type our kinds declare, and is derived from the kind table rather than
// written here — a literal list would have to be found and edited again the next time a kind is
// added, and the symptom of forgetting is a whole kind that silently cannot be saved. It is
// deliberately not `'any'`, which would also sweep in WordPress's own registered types, its
// revisions and its navigation-menu items.
//
// THE `meta_query` IS NOW THE ONLY THING KEEPING NON-JAMGROUND ROWS OUT. It always excluded
// WordPress's own seed content — a fresh install seeds a "Hello world!" post and a "Sample
// Page", never touched by import.mjs and never carrying `_jamground_id`, and without this
// filter every save would find them and throw for lacking a baseline they were never given.
// While the query was pinned to `post_type => 'post'` that seed page was also excluded by the
// type; now that pages are ours too, the type excludes nothing of WordPress's and this filter
// carries the whole job on its own.
//
// The post-type list travels through a JSON data file rather than being interpolated into this
// PHP source, the same discipline import.mjs uses for content values: nothing composes PHP
// around a value here, ever, so there is no case to reason about in which one could break out
// of a string.
const READ_POSTS_TYPES_JSON = JSON.stringify(WP_POST_TYPES);

const READ_POSTS_PHP = `<?php
require __DIR__ . '/wp-load.php';
$types = json_decode(file_get_contents(__DIR__ . '/jp-read-posts-types.json'), true);
$posts = get_posts([
  'post_type'   => $types,
  'post_status' => ['publish', 'draft', 'pending', 'future', 'private'],
  'numberposts' => -1,
  'meta_query'  => [
    ['key' => '_jamground_id', 'compare' => 'EXISTS'],
  ],
]);
$out = [];
foreach ($posts as $p) {
  $out[] = [
    'id'       => $p->ID,
    'content'  => $p->post_content,
    'title'    => $p->post_title,
    'slug'     => $p->post_name,
    'postType' => $p->post_type,
    'meta'     => [
      '_jamground_id'     => get_post_meta($p->ID, '_jamground_id', true),
      '_jamground_source' => get_post_meta($p->ID, '_jamground_source', true),
      '_jamground_path'   => get_post_meta($p->ID, '_jamground_path', true),
      '_jamground_kind'   => get_post_meta($p->ID, '_jamground_kind', true),
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
 * @returns {Promise<Array>} - entities shaped for changed-files.mjs / change.mjs:
 *   { id, kind, content, slug, frontmatter, meta: { _jamground_id, _jamground_source, … } }
 *   `kind` travels on the row so the export path never has to work it out again.
 * @throws {Error} - if an entity lacks `_jamground_source`, or if its declared kind, its path
 *   and WordPress's post type do not all agree; naming it rather than silently treating it as
 *   unchanged, as changed, or as the wrong kind
 */
export async function readPosts({ client }) {
  const root = await client.documentRoot;
  await client.writeFile(root + '/jp-read-posts-types.json', READ_POSTS_TYPES_JSON);
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

    // THE THREE-WAY CROSS-CHECK. Three independent statements of what this row is:
    //   · `_jamground_kind`, DECLARED by import.mjs when it created the row
    //   · the kind its `_jamground_path` implies, by directory and extension
    //   · the kind WordPress's own `post_type` maps to
    // All three must agree. Any disagreement means the next step would pick a serialiser by
    // one of them while the file on disk is the other — a page written back out as fenced
    // markdown, which destroys it. Same shape as the `_jamground_source` guard above, and for
    // the same reason: there is no safe way to proceed on a guess, so it stops and names all
    // three rather than preferring one.
    const declaredKind = row.meta && row.meta._jamground_kind;
    const pathKind = kindForPath(row.meta && row.meta._jamground_path);
    const typeKind = kindForWpPostType(row.postType);
    if (!declaredKind || declaredKind !== pathKind || declaredKind !== typeKind) {
      throw new Error(
        `readPosts: post ${row.id} (_jamground_id: ${row.meta && row.meta._jamground_id}) disagrees about what it is — `
        + `_jamground_kind says ${JSON.stringify(declaredKind)}, `
        + `_jamground_path ${JSON.stringify(row.meta && row.meta._jamground_path)} implies ${JSON.stringify(pathKind)}, `
        + `and post_type ${JSON.stringify(row.postType)} implies ${JSON.stringify(typeKind)}: `
        + `writing it back through the wrong serialiser would destroy the file`
      );
    }
    const kind = declaredKind;

    const { frontmatter: baseline } = parseEntity(kind, row.meta._jamground_path, source);

    // ONE LINE, BOTH KINDS. `baseline` is the ENVELOPE whichever kind this is — entity.mjs
    // lifts a page's `blocks` out of it — so laying wp-admin's two editable fields over it
    // needs no variant per kind. A page's blocks are deliberately absent from what export
    // receives: the ones written are the ones the editor just produced, never the ones on disk.
    //
    // `post_name` is WordPress's own, and it is EMPTY for a post that has never been
    // published — WordPress does not assign a permalink slug to a draft until its first
    // publish, so every fresh import of a draft seed post reads `''` here regardless of
    // anything an editor typed. `'' || baseline.slug` falls back to the committed slug in
    // that one case; a genuine editorial slug can never BE `''` (the contract's own regex
    // refuses it), so this cannot mask a real edit, only WordPress's own placeholder.
    const frontmatter = { ...baseline, title: row.title, slug: row.slug || baseline.slug };
    return {
      id: row.id,
      kind,
      content: row.content,
      slug: baseline.slug,
      frontmatter,
      meta: {
        _jamground_id: row.meta._jamground_id,
        _jamground_source: source,
        _jamground_path: row.meta._jamground_path,
        _jamground_kind: row.meta._jamground_kind,
      },
    };
  });
}
