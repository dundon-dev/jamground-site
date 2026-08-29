// Parse and validate one content entity, whatever kind it is.
//
// Every kind arrives here as bytes and leaves as the SAME SHAPE — `{ kind, frontmatter,
// blocks, body, source }` — with the kind-specific part (where the envelope ends, whether a
// body follows it, whether `blocks` is a field or has to be derived) declared once in
// kinds.mjs and nowhere else.
//
// That uniformity is not tidiness. It is what lets read-posts.mjs lay `post_title` /
// `post_name` over the baseline envelope with one line of code instead of two variants, and
// what lets import.mjs run one admission check over both kinds. A shape that differed per kind
// would put a branch in each of them.
//
// Refuse to boot on invalid content rather than silently repairing it.
import { kindSpec } from './kinds.mjs';

/**
 * Parse one entity's bytes into the uniform entity shape.
 *
 * `frontmatter` is the contract ENVELOPE, and only the envelope: a page's `blocks` field is
 * lifted out of it into `blocks`, so `frontmatter` means the same thing for both kinds and
 * export can re-attach whatever the editor produced. (Re-attaching at any object position is
 * safe — canonical.ts derives key order from the schema's own shape.)
 *
 * @param {string} kind - a key of KINDS ('post', 'page')
 * @param {string} path - File path (used in error messages)
 * @param {string} raw - Raw file content
 * @returns {{kind: string, frontmatter: object, blocks: Array|undefined, body: string, source: string}}
 * @throws {Error} - If the kind is unknown, the file cannot be split or parsed, or the
 *   document fails its schema
 */
export function parseEntity(kind, path, raw) {
  const spec = kindSpec(kind, `parseEntity ${path}`);

  const { document, body } = spec.parse(path, raw);

  const result = spec.schema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    ).join('; ');
    throw new Error(`Schema validation failed for ${path}: ${issues}`);
  }

  // A post's schema has no `blocks` field, so `blocks` is undefined here and its blocks come
  // from the body via the kind's own `toBlocks`. A page's are already the contract's.
  const { blocks, ...frontmatter } = result.data;

  return { kind, frontmatter, blocks, body, source: raw };
}

/**
 * The post-shaped entry point, kept as a thin wrapper: the nine test files and the Playwright
 * suite that already call it are asserting facts about POSTS, which have not changed.
 *
 * @param {string} path - File path (used in error messages)
 * @param {string} raw - Raw file content
 * @returns {{frontmatter: object, body: string, source: string}} - Parsed and validated post
 * @throws {Error} - If the frontmatter fence is missing or schema validation fails
 */
export function parsePost(path, raw) {
  return parseEntity('post', path, raw);
}
