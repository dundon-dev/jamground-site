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
//
// Media import is out of scope: the seed repository has none.
import { listPosts } from './content-source.mjs';
import { parsePost } from './entity.mjs';
import { blocksToMarkup } from './blocks-to-wp.mjs';
import { mdastToBlocks } from '../../src/lib/mdast-to-blocks.ts';

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
    'post_type'    => 'post',
    'post_status'  => $entry['status'] === 'published' ? 'publish' : 'draft',
    'post_title'   => $entry['title'],
    'post_name'    => $entry['slug'],
    'post_content' => $entry['content'],
    'meta_input'   => [
      '_jamground_id'     => $entry['contractId'],
      '_jamground_source' => $entry['source'],
      '_jamground_path'   => $entry['path'],
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
 * Fetch the two posts, validate them against the contract, convert their bodies to block
 * markup, and insert them into wp-admin as drafts/published per their contract `status`.
 *
 * @param {object} deps
 * @param {object} deps.client   - the Playground client (documentRoot, writeFile, run)
 * @param {object} deps.api      - the block API: { createBlock, serialize }
 * @param {Function} deps.fetchImpl - injected fetch (content-source.mjs never sends a token)
 * @param {string} deps.locale
 * @returns {Promise<Record<string, number>>} contract id -> WP post ID, the session map
 */
export async function importPosts({ client, api, fetchImpl, locale }) {
  const fetched = await listPosts(fetchImpl, locale);

  // Validate every entity before anything is written. One bad entity throws here and
  // nothing below runs — the wholesale refusal this module exists to guarantee.
  const decoder = new TextDecoder('utf-8');
  const parsed = fetched.map(({ path, bytes }) => ({ path, ...parsePost(path, decoder.decode(bytes)) }));

  const entries = parsed.map(({ path, frontmatter, body, source }) => ({
    contractId: frontmatter.id,
    title: frontmatter.title,
    slug: frontmatter.slug,
    status: frontmatter.status,
    publishedAt: frontmatter.publishedAt,
    content: blocksToMarkup(api, mdastToBlocks(body)),
    source,
    path,
  }));

  const root = await client.documentRoot;
  await client.writeFile(root + '/jp-import-data.json', JSON.stringify(entries));
  await client.writeFile(root + '/jp-import.php', IMPORT_PHP);
  const result = await client.run({ code: `<?php require '${root}/jp-import.php';` });
  return JSON.parse(result.text);
}
