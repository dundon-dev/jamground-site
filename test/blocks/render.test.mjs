/* Tests BlockList.astro (the dispatcher over all eleven block types) and
 * PostBody.astro (the post-body markdown path) — the two components here that import
 * OTHER .astro files: BlockList imports every component under
 * src/components/blocks/, and PostBody imports BlockList itself.
 *
 * The harness in test/blocks/custom.test.mjs and test/blocks/core.test.mjs compiles
 * exactly one file with @astrojs/compiler-rs's transform() and imports the result directly,
 * which only works because none of those eleven files imports another .astro file — a
 * two-file fixture proves transform()'s `resolvePath` option is never even invoked for a
 * component import (unlike, say, a style or script asset), so the emitted `import Foo from
 * "./Foo.astro"` is untouched: still literally ".astro", which plain Node has no loader for.
 * The fix, proved against that same two-file fixture before being relied on here: compile
 * every file in the (small, known, two-level) import graph, rewrite each sibling-component
 * import from ".astro" to ".ts" in the emitted code, and write every result to the SAME
 * relative path under one temp directory — so Node's own module resolution, not Astro's
 * Vite plugin (absent from this harness entirely), follows the graph. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from '@astrojs/compiler-rs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

const COMPONENTS_DIR = new URL('../../src/components/', import.meta.url);

/* See test/blocks/custom.test.mjs for why `resolvePath` and `internalURL` are set this way. */
const ASTRO_RUNTIME = fileURLToPath(import.meta.resolve('astro/compiler-runtime'));

/* Unlike the eleven self-contained files in test/blocks/custom.test.mjs and
 * test/blocks/core.test.mjs, PostBody.astro imports `unified` and the
 * remark packages at RUNTIME (not `import type`) — and the compiled component is written to
 * a throwaway temp directory OUTSIDE this project tree (same as every file in that
 * harness), from which Node's own module resolution never reaches this repo's
 * node_modules/. `internalURL` above is exactly this problem already solved once, for one
 * specific import — the fix generalises: resolve each of these bare specifiers to its real
 * absolute path up front, the same way, and rewrite the compiled code to import THAT
 * instead of the bare name. */
const RUNTIME_DEP_PATHS = Object.fromEntries(
  ['unified', 'remark-parse', 'remark-gfm', 'remark-stringify'].map(
    (pkg) => [pkg, fileURLToPath(import.meta.resolve(pkg))],
  ),
);


const MARKUP_DIR = fileURLToPath(new URL('../../design/markup/', import.meta.url));

function compile(relPath) {
  const sourcePath = fileURLToPath(new URL(relPath, COMPONENTS_DIR));
  const source = readFileSync(sourcePath, 'utf8');
  const result = transform(source, {
    filename: sourcePath,
    internalURL: ASTRO_RUNTIME,
    resultScopedSlot: true,
    resolvePath: (specifier) => specifier,
  });
  const error = result.diagnostics.find((d) => d.severity === 'error');
  if (error) throw new Error(`${relPath} failed to compile: ${error.text}`);
  /* compiler-rs never touches an import specifier itself (proved empirically against a
   * two-file fixture: `resolvePath` above is never even invoked for a component import), so
   * every ".astro" sibling import and every bare runtime-dependency import survives into the
   * emitted code exactly as written in the source — the first, Node has no loader for at
   * all; the second, Node can only find from inside this project's own tree. Both are fixed
   * the same way: rewrite the specifier text before the file is ever written to disk. */
  let code = result.code.replace(/from "(\.\/[^"]+)\.astro"/g, 'from "$1.ts"');
  /* mdast-to-blocks.ts is rewritten to .js since we'll write it as JavaScript to the temp dir. */
  code = code.replace(/from "(\.\.\/lib\/mdast-to-blocks)\.ts"/g, 'from "$1.js"');
  /* If this is PostBody (which will be placed in components/), adjust BlockList import */
  if (relPath === 'PostBody.astro') {
    code = code.replace(/from "\.\/BlockList\.ts"/g, 'from "../BlockList.ts"');
  }
  for (const [pkg, absPath] of Object.entries(RUNTIME_DEP_PATHS)) {
    code = code.replaceAll(`from "${pkg}"`, `from "${absPath}"`);
  }
  /* design/markup/*.ts, the shared markup contract the three custom blocks render (ADR-0013,
   * 09 §5). Relative in src/, wrong from the temp directory — one rule for the whole directory,
   * which holds because nothing in design/markup/ imports anything outside itself. */
  code = code.replace(
    /from "(?:\.\.\/)+design\/markup\/([a-z-]+)\.ts"/g,
    (_m, name) => `from "${MARKUP_DIR}${name}.ts"`,
  );
  return code;
}

const BLOCK_NAMES = [
  'Paragraph', 'Heading', 'List', 'Image', 'Quote', 'Code', 'Table', 'Separator',
  'Hero', 'FeatureGrid', 'Cta',
];

async function loadComponents() {
  const dir = mkdtempSync(join(tmpdir(), 'jamground-render-'));
  mkdirSync(join(dir, 'blocks'));
  mkdirSync(join(dir, 'components'));
  mkdirSync(join(dir, 'lib'));
  try {
    for (const name of BLOCK_NAMES) {
      writeFileSync(join(dir, 'blocks', `${name}.ts`), compile(`blocks/${name}.astro`));
    }
    writeFileSync(join(dir, 'BlockList.ts'), compile('BlockList.astro'));
    /* Preserve directory structure: PostBody goes in components/ so that ../lib/ relative
     * imports work correctly. */
    writeFileSync(join(dir, 'components', 'PostBody.ts'), compile('PostBody.astro'));
    /* mdast-to-blocks.ts needs to be compiled to JavaScript. Strip TypeScript constructs. */
    const mdastToBlocksSource = readFileSync(fileURLToPath(new URL('../../src/lib/mdast-to-blocks.ts', import.meta.url)), 'utf8');
    let mdastToBlocksCode = mdastToBlocksSource
      .replace(/^import type .*;\n/gm, '')  /* Remove type-only imports */
      .replace(/: z\.infer<typeof Block>(\[\])?/g, '')  /* Remove all Block return types */
      .replace(/: unknown\[\]/g, '')  /* Remove unknown[] type */
      .replace(/: string/g, '')  /* Remove string type */
      .replace(/: number/g, '')  /* Remove number type */
      .replace(/: boolean/g, '')  /* Remove boolean type */
      .replace(/: any(\[\])?/g, '')  /* Remove any type */
      .replace(/\(\w+: any\)/g, (m) => m.replace(/: any/, ''))  /* Remove types in params */
      .replace(/\(\w+: \w+\)/g, (m) => m.replace(/: \w+/, ''))  /* Generic param type removal */
      .replace(/ as never/g, '')  /* Remove type assertions */
      .replace(/<[^>]+>/g, '');  /* Remove generic types */
    for (const [pkg, absPath] of Object.entries(RUNTIME_DEP_PATHS)) {
      mdastToBlocksCode = mdastToBlocksCode.replaceAll(`from '${pkg}'`, `from '${absPath}'`);
      mdastToBlocksCode = mdastToBlocksCode.replaceAll(`from "${pkg}"`, `from "${absPath}"`);
    }
    writeFileSync(join(dir, 'lib', 'mdast-to-blocks.js'), mdastToBlocksCode);
    const BlockList = (await import(pathToFileURL(join(dir, 'BlockList.ts')).href)).default;
    const PostBody = (await import(pathToFileURL(join(dir, 'components', 'PostBody.ts')).href)).default;
    return { BlockList, PostBody };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { BlockList, PostBody } = await loadComponents();

async function render(factory, props) {
  const container = await AstroContainer.create();
  return container.renderToString(factory, { props });
}

/* Whitespace between tags is Astro's own formatting of the template, not part of the
 * contract — collapse it so assertions compare structure and classes, not indentation. */
const norm = (html) => html.replace(/>\s+</g, '><').trim();

test('BlockList — dispatches every one of the eleven block types, in order', async () => {
  const blocks = [
    { type: 'paragraph', text: 'Para text' },
    { type: 'heading', level: 2, text: 'Heading text' },
    { type: 'list', ordered: false, items: [{ text: 'One' }] },
    { type: 'image', media: { ref: 'media/a.jpg', alt: 'Alt' } },
    { type: 'quote', text: 'Quoted.' },
    { type: 'code', text: 'const x = 1;' },
    { type: 'table', head: ['A'], rows: [['1']] },
    { type: 'separator' },
    { type: 'hero', heading: 'Hero heading', cta: { label: 'Get started', href: '/en-us/pricing/' } },
    { type: 'featureGrid', columns: 2, items: [{ heading: 'A', body: 'B' }, { heading: 'C', body: 'D' }] },
    { type: 'cta', heading: 'Ready', link: { label: 'Go', href: '/en-us/blog/launch/' } },
  ];
  const html = norm(await render(BlockList, { blocks }));
  assert.equal(
    html,
    '<p>Para text</p>' +
      '<h2 class="wp-block-heading">Heading text</h2>' +
      '<ul class="wp-block-list"><li>One</li></ul>' +
      '<figure class="wp-block-image"><img src="media/a.jpg" alt="Alt"></figure>' +
      '<blockquote class="wp-block-quote"><p>Quoted.</p></blockquote>' +
      '<pre class="wp-block-code"><code>const x = 1;</code></pre>' +
      '<figure class="wp-block-table"><table class="has-fixed-layout">' +
      '<thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody>' +
      '</table></figure>' +
      '<hr class="wp-block-separator has-alpha-channel-opacity">' +
      '<section class="jp-hero"><h2 class="jp-hero__heading">Hero heading</h2>' +
      '<a class="jp-hero__cta" href="/en-us/pricing/">Get started</a></section>' +
      '<section class="jp-feature-grid" data-columns="2">' +
      '<div class="jp-feature-grid__item"><h3 class="jp-feature-grid__heading">A</h3>' +
      '<p class="jp-feature-grid__body">B</p></div>' +
      '<div class="jp-feature-grid__item"><h3 class="jp-feature-grid__heading">C</h3>' +
      '<p class="jp-feature-grid__body">D</p></div>' +
      '</section>' +
      '<section class="jp-cta"><h2 class="jp-cta__heading">Ready</h2>' +
      '<a class="jp-cta__link" href="/en-us/blog/launch/">Go</a></section>',
  );
});

test('BlockList — an unregistered type throws rather than rendering nothing', async () => {
  await assert.rejects(() => render(BlockList, { blocks: [{ type: 'bogus' }] }));
});

/* Resolution is required AT THIS BOUNDARY, not merely conventional upstream of it. A route
 * that hands BlockList raw contract blocks must fail the build rather than render one. */
test('BlockList — a block whose link never went through resolveBlockLinks throws', async () => {
  await assert.rejects(
    () => render(BlockList, {
      blocks: [{ type: 'cta', heading: 'Ready', link: { label: 'Go', ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } }],
    }),
    /cta link reached the renderer unresolved/,
  );
});

/* PostBody is deliberately untouched by link resolution: mdastToBlocks maps eight markdown
 * constructs and none of them is a hero or a cta, and inline markdown renders as literal
 * text, so the prose path emits no anchor at all. Threading a link index through it would
 * carry data down a path that cannot use it — and would add a runtime import to a file this
 * harness compiles without Vite. Do not "fix" that.  */
test('PostBody — every mapped construct in one pass, through BlockList, not Astro\'s markdown pipeline', async () => {
  const body = [
    '## A heading',
    '',
    'A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).',
    '',
    '- first item',
    '  1. nested one',
    '  2. nested two',
    '     - deep',
    '',
    '> A quote.',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '![A team at work](media/hero-a1b2c3.jpg)',
    '',
    '---',
    '',
  ].join('\n');

  const html = norm(await render(PostBody, { body }));
  assert.equal(
    html,
    '<h2 class="wp-block-heading">A heading</h2>' +
      '<p>A paragraph with **bold**, _italic_, `code` and a [link](https://example.com).</p>' +
      '<ul class="wp-block-list"><li>first item' +
      '<ol class="wp-block-list"><li>nested one</li><li>nested two' +
      '<ul class="wp-block-list"><li>deep</li></ul>' +
      '</li></ol>' +
      '</li></ul>' +
      '<blockquote class="wp-block-quote"><p>A quote.</p></blockquote>' +
      '<pre class="wp-block-code"><code>const x = 1;</code></pre>' +
      '<figure class="wp-block-table"><table class="has-fixed-layout">' +
      '<thead><tr><th>A</th><th>B</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
      '</table></figure>' +
      // The path is exactly as written in the markdown — never resolved against the
      // entry file's own directory, which is the mistake this component exists
      // to avoid by never calling into Astro's markdown pipeline at all.
      '<figure class="wp-block-image"><img src="media/hero-a1b2c3.jpg" alt="A team at work"></figure>' +
      '<hr class="wp-block-separator has-alpha-channel-opacity">',
  );
});

test('PostBody — raw HTML (prohibited, 11 §3/INV-3) is an unmapped construct, not a silent drop', async () => {
  await assert.rejects(() => render(PostBody, { body: '<div>raw html is prohibited</div>\n' }));
});
