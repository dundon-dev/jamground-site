/* Tests the eight core-derived block components against the markup contract —
 * <p> (no class), <hN class="wp-block-heading">, <ul|ol class="wp-block-list">/<li>,
 * <figure class="wp-block-image"><img>, <blockquote class="wp-block-quote">,
 * <pre class="wp-block-code"><code>, <figure class="wp-block-table"><table
 * class="has-fixed-layout">, <hr class="wp-block-separator has-alpha-channel-opacity">.
 * That table names only the required wrapper markup; the exact structure filled in below for
 * optional elements it doesn't spell out (list nesting, a quote's citation, an image's
 * caption, a table's head/body rows) is read directly off core's own save.js
 * (@wordpress/block-library, resolved by the lockfile) rather than guessed — the
 * same "observed, not authored" standard the required markup is held to throughout.
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

test('paragraph — a bare <p>, no class', async () => {
  const html = norm(await render('Paragraph.astro', { text: 'Some copy.' }));
  assert.equal(html, '<p>Some copy.</p>');
});

test('heading — each of the three permitted levels gets wp-block-heading', async () => {
  for (const level of [2, 3, 4]) {
    const html = norm(await render('Heading.astro', { level, text: 'A heading' }));
    assert.equal(html, `<h${level} class="wp-block-heading">A heading</h${level}>`);
  }
});

test('separator — the hr and both default classes, unconditionally', async () => {
  const html = norm(await render('Separator.astro', {}));
  assert.equal(html, '<hr class="wp-block-separator has-alpha-channel-opacity">');
});

test('code — pre/code wrapper, no language attribute anywhere', async () => {
  const html = norm(await render('Code.astro', { text: 'const x = 1;' }));
  assert.equal(html, '<pre class="wp-block-code"><code>const x = 1;</code></pre>');
});

test('code — empty text is a meaningful empty block, not an error', async () => {
  const html = norm(await render('Code.astro', { text: '' }));
  assert.equal(html, '<pre class="wp-block-code"><code></code></pre>');
});

test('quote — text becomes an unclassed inner <p>, citation an unclassed <cite>', async () => {
  const html = norm(await render('Quote.astro', { text: 'Quoted.', citation: 'Someone' }));
  assert.equal(
    html,
    '<blockquote class="wp-block-quote"><p>Quoted.</p><cite>Someone</cite></blockquote>',
  );
});

test('quote — citation is optional and omitted entirely when absent', async () => {
  const html = norm(await render('Quote.astro', { text: 'Quoted.' }));
  assert.equal(html, '<blockquote class="wp-block-quote"><p>Quoted.</p></blockquote>');
});

test('image — figure/img pair and a captioned figcaption', async () => {
  const html = norm(await render('Image.astro', {
    media: { ref: 'media/a.jpg', alt: 'Alt text' },
    caption: 'A caption',
  }));
  assert.equal(
    html,
    '<figure class="wp-block-image">' +
      '<img src="media/a.jpg" alt="Alt text">' +
      '<figcaption class="wp-element-caption">A caption</figcaption>' +
      '</figure>',
  );
});

test('image — decorative media gets an empty alt and no caption element', async () => {
  const html = norm(await render('Image.astro', {
    media: { ref: 'media/b.jpg', decorative: true },
  }));
  assert.equal(html, '<figure class="wp-block-image"><img src="media/b.jpg" alt></figure>');
});

test('table — has-fixed-layout, a thead of th and a tbody of td, no merged cells', async () => {
  const html = norm(await render('Table.astro', {
    head: ['Plan', 'Price'],
    rows: [['Starter', '$0'], ['Pro', '$9']],
  }));
  assert.equal(
    html,
    '<figure class="wp-block-table"><table class="has-fixed-layout">' +
      '<thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
      '<tbody>' +
      '<tr><td>Starter</td><td>$0</td></tr>' +
      '<tr><td>Pro</td><td>$9</td></tr>' +
      '</tbody></table></figure>',
  );
});

test('list — a flat unordered list, one <li> per item', async () => {
  const html = norm(await render('List.astro', {
    ordered: false,
    items: [{ text: 'One' }, { text: 'Two' }],
  }));
  assert.equal(html, '<ul class="wp-block-list"><li>One</li><li>Two</li></ul>');
});

test('list — ordered renders <ol>, each own level keeps its own ordered flag', async () => {
  const html = norm(await render('List.astro', {
    ordered: true,
    items: [{ text: 'One', list: { ordered: false, items: [{ text: 'a' }] } }],
  }));
  assert.equal(
    html,
    '<ol class="wp-block-list">' +
      '<li>One<ul class="wp-block-list"><li>a</li></ul></li>' +
      '</ol>',
  );
});

test('list — nests to the full three levels the contract permits, list inside its own <li>', async () => {
  const html = norm(await render('List.astro', {
    ordered: false,
    items: [{
      text: 'Level one',
      list: {
        ordered: true,
        items: [{
          text: 'Level two',
          list: { items: [{ text: 'Level three' }] },
        }],
      },
    }],
  }));
  assert.equal(
    html,
    '<ul class="wp-block-list"><li>Level one' +
      '<ol class="wp-block-list"><li>Level two' +
      '<ul class="wp-block-list"><li>Level three</li></ul>' +
      '</li></ol>' +
      '</li></ul>',
  );
});
