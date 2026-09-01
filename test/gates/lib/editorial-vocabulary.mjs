/* Functions for editorial vocabulary gate: no git vocabulary in editor-facing strings.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Git vocabulary that must never appear in editor-facing strings
const FORBIDDEN_WORDS = ['branch', 'commit', 'merge', 'rebase', 'pull request'];

/**
 * A SECOND RULE, AND IT IS NOT THE GIT ONE. The list above is mechanics an editor must never be
 * shown (04 §Editorial-vocabulary's translation table). This one is about naming a thing that does
 * not exist: the glossary says "there is deliberately no long-lived staging environment", and what
 * a change actually gets is a **Preview** — ephemeral, at `pr-<number>.preview.<domain>`, torn
 * down with the change that owned it.
 *
 * It is kept separate rather than appended to FORBIDDEN_WORDS because the two fail for different
 * reasons and deserve different messages: "branch" leaks the mechanism, "staging site" names the
 * wrong thing. Three strings in editor/lib/vocabulary.mjs said "your staging site" while the
 * control beside them said "preview" and the function producing the address was PREVIEW_URL_FOR —
 * two names for one thing, only one of them real, and nothing here noticed.
 */
const WRONG_PRODUCT_TERMS = [
  { pattern: /\bstaging\b/gi, word: 'staging', instead: 'preview — the glossary is explicit that there is no staging environment (04 §Editorial-vocabulary)' },
];

/**
 * Extract string literals from JavaScript source code, excluding:
 * - Comments (// and block comments)
 * - Property names (key: value in objects)
 * - Import specifiers (import x from 'module')
 * - Template strings with interpolations (${...})
 * - Parameter and variable names
 *
 * Only editor-facing strings (simple quoted strings and template strings without
 * interpolations) are extracted for checking.
 */
export function extractStringLiterals(source) {
  const literals = [];

  // Remove single-line comments
  let cleaned = source.replace(/\/\/.*$/gm, '');

  // Remove multi-line comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Extract quoted strings (single and double) - these are definitely editor-facing
  const simpleStringRegex = /(['"])(?:\\.|(?!\1).)*?\1/g;
  let match;

  while ((match = simpleStringRegex.exec(cleaned)) !== null) {
    let str = match[0];

    // Remove the quotes
    str = str.slice(1, -1);

    // Unescape common escape sequences for the check
    str = str
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    literals.push(str);
  }

  // For template strings, only extract those WITHOUT interpolations (${...})
  const templateRegex = /`([^`]*)`/g;
  while ((match = templateRegex.exec(cleaned)) !== null) {
    const content = match[1];
    // Skip template strings with interpolations (they're mixing code and strings)
    if (!content.includes('${')) {
      literals.push(content);
    }
  }

  return literals;
}

/**
 * Extract text content from HTML, excluding:
 * - Script tags
 * - Style tags
 * - HTML comments
 * - Attribute values (they are code configuration, not editor-facing)
 */
export function extractHtmlText(html) {
  const text = [];

  // Remove script tags and their content
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove style tags and their content
  cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Remove tags but keep text content
  cleaned = cleaned.replace(/<[^>]+>/g, '');

  // Get text between tags and clean up
  const textContent = cleaned
    .split(/\s+/)
    .filter(word => word.length > 0)
    .join(' ');

  return textContent;
}

/**
 * Check a string for forbidden git vocabulary.
 * Returns an array of violations found.
 */
export function checkForViolations(text) {
  const violations = [];
  const lowerText = text.toLowerCase();

  for (const word of FORBIDDEN_WORDS) {
    // Use word boundary checks for more accurate matching
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    let match;
    while ((match = regex.exec(lowerText)) !== null) {
      violations.push({
        word: word,
        foundText: text.substring(
          Math.max(0, match.index - 20),
          Math.min(text.length, match.index + word.length + 20)
        ),
      });
    }
  }

  for (const { pattern, word, instead } of WRONG_PRODUCT_TERMS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      violations.push({
        word,
        instead,
        foundText: text.substring(
          Math.max(0, match.index - 20),
          Math.min(text.length, match.index + word.length + 20)
        ),
      });
    }
  }

  return violations;
}

/**
 * Recursively find all .mjs files in a directory
 */
function findMjsFiles(dir) {
  const files = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findMjsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    console.error(`Failed to read directory ${dir}: ${e.message}`);
  }
  return files;
}

/**
 * Scan editor files under root for forbidden git vocabulary.
 * Returns an array of violation objects with { file, word, context }.
 */
export function scanEditorialVocabulary(root) {
  const violations = [];

  // Scan .mjs files in editor/lib and editor/entry.mjs
  const editorLibDir = join(root, 'editor', 'lib');
  let libFiles = [];
  try {
    libFiles = findMjsFiles(editorLibDir);
  } catch (e) {
    // Directory may not exist
  }
  const mjs_files = libFiles.concat([join(root, 'editor', 'entry.mjs')]);

  for (const filePath of mjs_files) {
    try {
      const source = readFileSync(filePath, 'utf-8');
      const strings = extractStringLiterals(source);

      for (const str of strings) {
        const fileViolations = checkForViolations(str);
        if (fileViolations.length > 0) {
          for (const v of fileViolations) {
            violations.push({
              file: filePath,
              word: v.word,
              context: str.substring(0, 100),
            });
          }
        }
      }
    } catch (e) {
      // File may not exist or may be unreadable
    }
  }

  // Scan editor/index.html
  const htmlPath = join(root, 'editor', 'index.html');
  try {
    const htmlSource = readFileSync(htmlPath, 'utf-8');
    const htmlText = extractHtmlText(htmlSource);
    const htmlViolations = checkForViolations(htmlText);

    if (htmlViolations.length > 0) {
      for (const v of htmlViolations) {
        violations.push({
          file: htmlPath,
          word: v.word,
          context: htmlText.substring(0, 100),
        });
      }
    }
  } catch (e) {
    // File may not exist or may be unreadable
  }

  return violations;
}
