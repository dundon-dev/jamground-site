// Parse and validate post frontmatter + body
// Split frontmatter fence from markdown body, parse the frontmatter YAML,
// validate against the Post schema. Refuse to boot on invalid content
// rather than silently repairing it.
import yaml from 'yaml';
import { Post } from '../../src/contract/entities.ts';

/**
 * Parse a post file into frontmatter, body, and raw source.
 *
 * The post file format is:
 * ---
 * frontmatter YAML here
 * ---
 * body markdown here
 *
 * @param {string} path - File path (used in error messages)
 * @param {string} raw - Raw file content
 * @returns {{frontmatter: object, body: string, source: string}} - Parsed and validated post
 * @throws {Error} - If frontmatter fence is missing or schema validation fails
 */
export function parsePost(path, raw) {
  // Split frontmatter from body
  // The first line must be ---, followed by content, then another ---
  const lines = raw.split('\n');

  if (lines.length === 0 || !lines[0].startsWith('---')) {
    throw new Error(`Missing frontmatter fence in ${path}`);
  }

  // Find the closing fence
  let closingFenceIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      closingFenceIndex = i;
      break;
    }
  }

  if (closingFenceIndex === -1) {
    throw new Error(`Missing closing frontmatter fence in ${path}`);
  }

  // Extract frontmatter and body
  const frontmatterText = lines.slice(1, closingFenceIndex).join('\n');
  const bodyStart = closingFenceIndex + 1;
  // Skip the newline immediately after the closing fence if present
  const bodyLines = bodyStart < lines.length ? lines.slice(bodyStart) : [];
  // Remove leading empty line if present
  if (bodyLines.length > 0 && bodyLines[0] === '') {
    bodyLines.shift();
  }
  const body = bodyLines.join('\n');

  // Parse YAML
  let frontmatter;
  try {
    frontmatter = yaml.parse(frontmatterText);
  } catch (err) {
    throw new Error(`Invalid YAML in frontmatter of ${path}: ${err.message}`);
  }

  // Validate against Post schema
  const result = Post.safeParse(frontmatter);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    ).join('; ');
    throw new Error(`Schema validation failed for ${path}: ${issues}`);
  }

  // Return validated frontmatter, body, and source unchanged
  return {
    frontmatter: result.data,
    body,
    source: raw,
  };
}
