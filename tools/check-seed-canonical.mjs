#!/usr/bin/env node
/**
 * Seed-content canonical-form check — the content-repository counterpart to
 * tools/check-canonical-docs.mjs, and built for the same reason: this project designates a
 * canonical byte form, and a claim about it is only testable by round-tripping real bytes
 * through the real writer, not by reading the rule and agreeing it sounds right.
 *
 * Walks $JAMGROUND_CONTENT_DIR/content (defaulting to the sibling ../jamground-content —
 * same resolution src/contract/env.ts uses at build time) and asserts
 * write(read(x)) === x for every YAML entity file (pages, authors, navigation, settings,
 * redirects) and for the frontmatter envelope of every markdown post.
 * `content/media/` is binary originals and has no text form to check.
 *
 * Imports the real writer and schemas — ../src/lib/canonical.ts and
 * ../src/contract/entities.ts — rather than reimplementing either.
 *
 * With no seed content present the check is vacuous — exit 3, the same code as "could not
 * run" rather than 0, because a green result here would otherwise be indistinguishable from
 * "checked N files, all clean".
 *
 * Exit codes: 0 all files canonical · 1 drift · 3 could not run (including "no content yet").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { write, read } from '../src/lib/canonical.ts';
import { Page, Post, Author, Navigation, Settings, Redirects } from '../src/contract/entities.ts';

// Infer schema based on file path and type
function inferSchema(filePath) {
  if (filePath.includes('/pages/')) return Page;
  if (filePath.includes('/posts/')) return Post;
  if (filePath.includes('/authors/')) return Author;
  if (filePath.includes('/navigation/')) return Navigation;
  if (filePath.includes('/settings/')) {
    if (filePath.endsWith('redirects.yaml')) return Redirects;
    return Settings;
  }
  // Fallback - shouldn't happen with well-structured content
  throw new Error(`Could not infer schema for ${filePath}`);
}

// Same default and env var as src/contract/env.ts's resolveContentRoot — the
// content repository is a sibling checkout, not a subdirectory of this one.
const contentRoot = resolve(process.env.JAMGROUND_CONTENT_DIR ?? '../jamground-content', 'content');

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  let out = [];
  for (const entry of entries) {
    if (entry.name === 'media') continue; // binary originals, no canonical text form
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out = out.concat(walk(full));
    else if (/\.ya?ml$/.test(entry.name) || entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = walk(contentRoot).sort();

if (files.length === 0) {
  console.error(`no seed content under ${contentRoot} — the check is vacuous`);
  process.exit(3);
}

// A markdown post's body follows its frontmatter; only the envelope is YAML, so only
// the fenced block between the `---` delimiters is a canonical-form claim this tool can check.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

let checked = 0, bad = 0;
for (const path of files) {
  const raw = readFileSync(path, 'utf8');

  let input;
  if (path.endsWith('.md')) {
    const m = FRONTMATTER.exec(raw);
    if (!m) { console.error(`${path}  NO FRONTMATTER BLOCK FOUND`); checked++; bad++; continue; }
    input = `${m[1]}\n`;
  } else {
    input = raw;
  }

  checked++;
  let out;
  try {
    const parsed = read(input);
    const schema = inferSchema(path);
    out = write(parsed, schema);
  }
  catch (e) { console.error(`${path}  UNPARSEABLE: ${e.message.split('\n')[0]}`); bad++; continue; }
  if (out === input) continue;
  bad++;
  console.error(`${path}  NOT IN CANONICAL FORM`);
  const a = input.split('\n'), b = out.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    console.error(`    line ${i + 1}`);
    console.error(`      file:   ${JSON.stringify(a[i])}`);
    console.error(`      writer: ${JSON.stringify(b[i])}`);
  }
}

console.log(`${checked - bad}/${checked} seed content files are in canonical form`);
process.exit(bad === 0 ? 0 : 1);
