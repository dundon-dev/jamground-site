/* Editor isolation gates: Assert that no .php files outside editor/ exist and
 * that the module graph from astro.config.mjs and src/pages/** does not resolve into
 * editor/. This test watches both assertions fail with planted violations, hermetically
 * in temporary directories. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { strayPhpFiles, graphEntriesIntoEditor } from '../conformance/lib/no-php.mjs';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('strayPhpFiles detects .php files outside editor/ when planted, ignores when moved inside', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jamground-stray-php-'));

  try {
    // Initialize a git repository in the temp directory
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.org"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'pipe' });

    // Create and track a .php file at the root (outside editor/)
    const phpFile = join(tempDir, 'stray.php');
    writeFileSync(phpFile, '<?php echo "stray"; ?>');
    execSync('git add stray.php', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "add stray php"', { cwd: tempDir, stdio: 'pipe' });

    // Assert strayPhpFiles finds it
    const strayOutside = strayPhpFiles(tempDir);
    assert.strictEqual(strayOutside.length, 1, 'should find 1 stray .php file outside editor/');
    assert.strictEqual(strayOutside[0], 'stray.php', 'should find stray.php at root');

    // Move the file into editor/ directory
    const editorDir = join(tempDir, 'editor');
    execSync(`mkdir -p "${editorDir}"`, { stdio: 'pipe' });
    execSync('mv stray.php editor/stray.php', { cwd: tempDir, stdio: 'pipe' });
    execSync('git add -A', { cwd: tempDir, stdio: 'pipe' });
    execSync('git commit -m "move php into editor"', { cwd: tempDir, stdio: 'pipe' });

    // Assert strayPhpFiles finds nothing now
    const strayInside = strayPhpFiles(tempDir);
    assert.deepEqual(strayInside, [], 'should find no .php files when moved inside editor/');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('graphEntriesIntoEditor detects imports when planted, empty when reverted', () => {
  // Create a temporary copy of the project
  const tempDir = mkdtempSync(join(tmpdir(), 'jamground-graph-isolation-'));

  try {
    // Copy the project into the temp directory
    cpSync(projectRoot, tempDir, {
      recursive: true,
      filter: (src, dest) => {
        // Skip node_modules, dist, .git and .astro to keep the copy small
        const basename = src.split('/').pop();
        return basename !== 'node_modules' && basename !== 'dist' && basename !== '.git' && basename !== '.astro';
      },
    });

    // Find a route file in src/pages (should exist from the project)
    const pagesDir = join(tempDir, 'src/pages');
    const pageFiles = execSync(`find "${pagesDir}" -type f -name "*.astro" -o -name "*.mjs" -o -name "*.js"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    assert(pageFiles.length > 0, 'src/pages should contain at least one route file');
    const routeFile = pageFiles[0];

    // Read the original content
    const originalContent = readFileSync(routeFile, 'utf8');

    try {
      // Plant an import of editor/lib/blocks-to-wp.mjs
      const importLine = "import { blocksToWp } from '../../editor/lib/blocks-to-wp.mjs';\n";
      const modifiedContent = importLine + originalContent;
      writeFileSync(routeFile, modifiedContent, 'utf8');

      // Assert graphEntriesIntoEditor is non-empty (finds the planted import)
      const graphWithImport = graphEntriesIntoEditor(tempDir);
      assert(graphWithImport.length > 0, 'graphEntriesIntoEditor should find planted import to editor/');

      // Revert the change
      writeFileSync(routeFile, originalContent, 'utf8');

      // Assert graphEntriesIntoEditor is now empty
      const graphAfterRevert = graphEntriesIntoEditor(tempDir);
      assert.deepEqual(graphAfterRevert, [], 'graphEntriesIntoEditor should be empty after reverting import');
    } finally {
      // Ensure original content is restored even if test fails
      writeFileSync(routeFile, originalContent, 'utf8');
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
