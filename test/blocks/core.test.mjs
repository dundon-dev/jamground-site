/* Tests the eight core-derived block components against the markup contract —
 * <p> (no class), <hN class="wp-block-heading">, <ul|ol class="wp-block-list">/<li>,
 * <figure class="wp-block-image"><img>, <blockquote class="wp-block-quote">,
 * <pre class="wp-block-code"><code>, <figure class="wp-block-table"><table
 * class="has-fixed-layout">, <hr class="wp-block-separator has-alpha-channel-opacity">.
 * That table names only the required wrapper markup; the exact structure for optional elements it
 * doesn't spell out (list nesting, a quote's citation, an image's caption, a table's head/body
 * rows) is read directly off core's own save.js (@wordpress/block-library, resolved by the
 * lockfile) rather than guessed — the same "observed, not authored" standard the required markup
 * is held to throughout.
 *
 * THE CASES ARE NOT HERE. They live in design/markup/core.ts, because a second test in the other
 * package tree holds WORDPRESS to the same record: editor/test/core-markup.test.mjs asserts
 * `serialize()` produces each `markup` once parsed. This file asserts Astro produces it byte for
 * byte. Astro == record and record == WordPress gives Astro == WordPress, which is what
 * `10 §R5` asks for and what a record written out twice could not give. Read that file's header
 * before adding a case; both halves of the chain read the row you add.
 *
 * This renders the real .astro files, not a hand-copied guess of what they should produce —
 * the same compile-and-render harness test/blocks/custom.test.mjs built, reused
 * here rather than imported from there (a node:test file has nothing to export), because a
 * second block directory's components need the identical treatment: real Astro compiler
 * (`@astrojs/compiler-rs`) with `resolvePath`/`internalURL` set, and Astro's own Container API
 * (`astro/container`), the compiled module written to a throwaway `.ts` file so Node's native
 * type-stripping — not this harness — erases the frontmatter's TypeScript. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from '@astrojs/compiler-rs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

const BLOCKS_DIR = new URL('../../src/components/blocks/', import.meta.url);

/* See test/blocks/custom.test.mjs for why `resolvePath` and `internalURL` are set this way. */
const ASTRO_RUNTIME = fileURLToPath(import.meta.resolve('astro/compiler-runtime'));

async function compileComponent(name) {
  const sourcePath = fileURLToPath(new URL(name, BLOCKS_DIR));
  const source = readFileSync(sourcePath, 'utf8');
  const result = transform(source, {
    filename: sourcePath,
    internalURL: ASTRO_RUNTIME,
    resultScopedSlot: true,
    resolvePath: (specifier) => specifier,
  });
  const error = result.diagnostics.find((d) => d.severity === 'error');
  if (error) throw new Error(`${name} failed to compile: ${error.text}`);
  const dir = mkdtempSync(join(tmpdir(), 'jamground-block-'));
  const file = join(dir, 'component.ts');
  writeFileSync(file, result.code);
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod.default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function render(name, props) {
  const factory = await compileComponent(name);
  const container = await AstroContainer.create();
  return container.renderToString(factory, { props });
}

/* Whitespace between tags is Astro's own formatting of the template, not part of the
 * contract — collapse it so assertions compare structure and classes, not indentation. */
const norm = (html) => html.replace(/>\s+</g, '><').trim();

/* The record both halves of the chain read. See its header, and this file's. */
const { CORE_CASES, CORE_TYPES } = await import('../../design/markup/core.ts');

for (const { name, component, block, props, markup } of CORE_CASES) {
  test(name, async () => {
    /* `type` is the contract's discriminant and is not a component prop; everything else is —
     * except where the row says otherwise, which is the `image` rows and their resolved `src`. */
    const { type, ...fields } = block;
    assert.equal(norm(await render(component, props ?? fields)), markup);
  });
}

/* The suite covers the whole contract, not whichever types someone remembered. Deleting a row
 * from the record is meant to fail here rather than quietly shrink both halves of the chain. */
test('every core-derived contract type has at least one case', () => {
  const covered = new Set(CORE_CASES.map((c) => c.block.type));
  assert.deepEqual([...CORE_TYPES].filter((t) => !covered.has(t)), []);
});
