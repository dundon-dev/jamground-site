// Import: contract -> Gutenberg, on boot.
// Fetch, validate, convert, insert — in that order — and refuse WHOLESALE on any single
// invalid entity rather than importing the valid remainder.
//
// Post IDs are unstable (a fresh database every boot), so the contract `id` is the durable
// key. The mapping lives in two places: the session map this function returns,
// and post meta on the row itself —
//   _jamground_id     the contract id
//   _jamground_source the fetched bytes verbatim, so export compares against what was
//                      imported rather than re-deriving it ("no edit, no diff")
//   _jamground_path   the repository path the bytes came from
//   _jamground_kind   which kind the row is, DECLARED rather than inferred. read-posts.mjs
//                      cross-checks it against the kind its path implies and against
//                      WordPress's own post_type; the three disagreeing means a row would be
//                      written back through the wrong serialiser, which is the silent
//                      corruption case. Inferring from the path alone works until a path
//                      changes, and then fails by writing YAML through the markdown
//                      serialiser rather than by stopping.
//
// Media import is out of scope: the seed repository has none.
import { listEntities } from './content-source.mjs';
import { parseEntity } from './entity.mjs';
import { blocksToMarkup } from './blocks-to-wp.mjs';
import { KINDS, kindSpec } from './kinds.mjs';
import { exportEntity } from './export.mjs';

// A static importer: every value that came from content/ travels through the JSON data
// file written alongside it, never interpolated into this PHP source. A title or body
// containing a quote or a backslash must not be able to break out of a PHP string —
// composing PHP around unescaped content is exactly what this avoids.
const IMPORT_PHP = `<?php
require __DIR__ . '/wp-load.php';
$entries = json_decode(file_get_contents(__DIR__ . '/jp-import-data.json'), true);
$map = [];
foreach ($entries as $entry) {
  $postarr = [
    'post_type'    => $entry['postType'],
    'post_status'  => $entry['status'] === 'published' ? 'publish' : 'draft',
    'post_title'   => $entry['title'],
    'post_name'    => $entry['slug'],
    'post_content' => $entry['content'],
    'meta_input'   => [
      '_jamground_id'     => $entry['contractId'],
      '_jamground_source' => $entry['source'],
      '_jamground_path'   => $entry['path'],
      '_jamground_kind'   => $entry['kind'],
    ],
  ];
  if (!empty($entry['publishedAt'])) {
    $postarr['post_date'] = date('Y-m-d H:i:s', strtotime($entry['publishedAt']));
  }
  $id = wp_insert_post($postarr, true);
  if (is_wp_error($id)) {
    throw new Exception($entry['contractId'] . ': ' . $id->get_error_message());
  }
  $map[$entry['contractId']] = $id;
}
echo json_encode($map);
`;

/**
 * Fetch every entity of every declared kind for this locale, validate them against the
 * contract, convert them to block markup, and insert them into wp-admin as drafts/published
 * per their contract `status` and as the post type their kind declares.
 *
 * @param {object} deps
 * @param {object} deps.client   - the Playground client (documentRoot, writeFile, run)
 * @param {object} deps.api      - the block API: { createBlock, serialize }
 * @param {Function} deps.fetchImpl - injected fetch (content-source.mjs never sends a token)
 * @param {string} deps.locale
 * @returns {Promise<Record<string, number>>} contract id -> WP post ID, the session map
 */
export async function importPosts({ client, api, fetchImpl, locale }) {
  const fetched = await listEntities(fetchImpl, locale);

  // Validate every entity before anything is written. One bad entity throws here and
  // nothing below runs — the wholesale refusal this module exists to guarantee.
  // The kind came off the tree with the bytes and is not re-derived here.
  const decoder = new TextDecoder('utf-8');
  const parsed = fetched.map(({ kind, path, bytes }) => ({ path, ...parseEntity(kind, path, decoder.decode(bytes)) }));

  // ---------------------------------------------------------------------------------------------
  // ADMITTED ONLY IF IT SURVIVES THE ROUND TRIP, BYTE FOR BYTE.
  //
  // Three ways an entity can be damaged by passing through this editor, and only one of them is
  // loud on its own:
  //
  //   A. the import mapper cannot build the block   — blocksToMarkup throws, below
  //   B. the export mapper cannot map it back       — throws at save; the editor sees saveFailed
  //   C. it maps BOTH ways, but not identically     — nothing anywhere notices
  //
  // C is the one that writes damage into the content repository. A lossy-but-successful round trip
  // produces bytes that differ from `_jamground_source` with NO EDIT AT ALL; changed-files.mjs
  // sees a difference, `save` commits it, and the loss lands inside a change the editor believes
  // is the person's own. They never touched that block. No allowlist of supported types can catch
  // it, because every type on the list would still be on the list.
  //
  // So the admission test is the property itself rather than a proxy for it: export what was just
  // imported and require the original bytes back. That is exactly the assertion
  // test/roundtrip.test.mjs already makes against two fixtures — run here against real content,
  // which is the only place it can see a block a fixture does not contain.
  //
  // Both mutable inputs are pinned to the entity's own values so neither can move: `previousSlug`
  // to its current slug (so slugHistory cannot grow) and `updatedAt` to its stored value (so the
  // clock cannot tick). entry.mjs's save path already holds the clock steady this same way, for
  // this same reason.
  //
  // REFUSAL IS PER ENTITY, AND IS ENFORCED BY ABSENCE. A refused entity simply never reaches
  // wp_insert_post, so it has no _jamground_id, so read-posts.mjs's meta_query cannot see it, so
  // save cannot write it. There is no flag to check and therefore none to forget. Wholesale
  // refusal — the rule for a schema-invalid entity, above — would be wrong here: one unsupported
  // block on one page would blank the whole editor, including the posts that are fine.
  // ---------------------------------------------------------------------------------------------
  const admitted = [];
  const refused = [];

  for (const entity of parsed) {
    const { kind, path, frontmatter, source } = entity;
    let content;
    try {
      // PER KIND, through the entity's OWN kind, both ways. A post's blocks come from its
      // markdown body and a page's are already the contract's, and the check is only worth
      // anything if the export half uses the same kind the import half did.
      content = blocksToMarkup(api, kindSpec(kind, `import ${path}`).toBlocks(entity));
      const verified = exportEntity({
        kind,
        api,
        markup: content,
        frontmatter,
        previousSlug: frontmatter.slug,
        updatedAt: frontmatter.updatedAt,
      });
      if (verified !== source) {
        throw new Error('it does not survive being read and written back unchanged');
      }
    } catch (err) {
      refused.push({ path, title: frontmatter.title, reason: err.message });
      continue;
    }
    admitted.push({ ...entity, content });
  }

  const entries = admitted.map(({ kind, path, frontmatter, content, source }) => ({
    contractId: frontmatter.id,
    title: frontmatter.title,
    slug: frontmatter.slug,
    status: frontmatter.status,
    publishedAt: frontmatter.publishedAt,
    content,
    source,
    path,
    kind,
    postType: KINDS[kind].wpPostType,
  }));

  const root = await client.documentRoot;
  await client.writeFile(root + '/jp-import-data.json', JSON.stringify(entries));
  await client.writeFile(root + '/jp-import.php', IMPORT_PHP);
  const result = await client.run({ code: `<?php require '${root}/jp-import.php';` });
  // `map` keeps its old shape — contract id -> WP post ID — so every existing caller and test is
  // unaffected. `refused` is what the shell needs in order to say something true on screen instead
  // of booting an empty editor and logging to a console nobody has open.
  return { map: JSON.parse(result.text), refused };
}
