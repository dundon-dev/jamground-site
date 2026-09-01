/* Tests the three custom jamground/* block components against the markup contract —
 * jp-hero/__heading/__body/__media/__cta, jp-feature-grid[data-columns]/__item/
 * __heading/__body, jp-cta/__heading/__body/__link.
 *
 * The two link-bearing blocks take a RESOLVED link — `{ label, href }`. `Link.ref` is a
 * translation-group id, not a URL (defs.ts), and resolution happens upstream in the
 * route via resolveBlockLinks() (src/lib/links.ts). The href values below are therefore real
 * routes rather than ULIDs; the classnames and elements the markup contract freezes are
 * unchanged, which is the part of these assertions that is the contract. The last two tests
 * watch the guard that makes upstream resolution mandatory actually fail.
 *
 * This renders the real .astro files, not a hand-copied guess of what they should produce.
 * There is no `astro build`/dev-server here — it goes through Astro's own compiler
 * (`@astrojs/compiler-rs`, a transitive dependency of `astro` 7.2.2, already resolved by the
 * lockfile; nothing is installed here that isn't already pinned) and its Container API
 * (`astro/container`), which is Astro's own supported entry point for rendering a single
 * component outside a full build. The compiler doesn't strip the frontmatter's TypeScript
 * (`import type`, `Extract<...>`, `as Props`) — that is Vite's job during a real build — so
 * the compiled module is written to a throwaway `.ts` file rather than `.mjs`: Node's own
 * native type-stripping (unflagged since well before this project's pinned Node) erases it
 * on import, exactly as it already does for the plain .ts files under src/contract/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from '@astrojs/compiler-rs';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

const BLOCKS_DIR = new URL('../../src/components/blocks/', import.meta.url);

/* Astro's own compile step (astro/dist/core/compile/compile.js) always supplies a
 * `resolvePath` callback; doing the same here turns off the compiler's `$$createMetadata`
 * codegen path, which this harness has no virtual-module machinery to satisfy. `internalURL`
 * is pointed at the on-disk runtime module directly (rather than left as the bare
 * `astro/compiler-runtime` specifier the compiler defaults to) because the compiled file is
 * imported from a temp directory outside this project's own tree, where a bare specifier
 * would not resolve. */
const ASTRO_RUNTIME = fileURLToPath(import.meta.resolve('astro/compiler-runtime'));

/* design/markup/*.ts is the shared markup contract — one node description per block type,
 * rendered to HTML here and through createElement by the block's `edit` (ADR-0013, 09 §5). The
 * components import it by a relative path that is correct in src/ and wrong from the temp
 * directory this harness compiles into, so rewrite it to the real absolute path. One rule covers
 * the whole directory, which is why nothing in design/markup/ imports anything outside itself. */
const MARKUP_DIR = fileURLToPath(new URL('../../design/markup/', import.meta.url));
const rewriteMarkupImports = (code) =>
  code.replace(/from "(?:\.\.\/)+design\/markup\/([a-z-]+)\.ts"/g, (_m, name) => `from "${MARKUP_DIR}${name}.ts"`);

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
  writeFileSync(file, rewriteMarkupImports(result.code));
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

test('hero — full props render all four contract classes', async () => {
  const html = norm(await render('Hero.astro', {
    heading: 'Pricing & plans',
    body: 'No setup fees.',
    media: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' },
    cta: { label: 'Get started', href: '/en-us/pricing/' },
  }));
  assert.equal(
    html,
    '<section class="jp-hero">' +
      '<h2 class="jp-hero__heading">Pricing &amp; plans</h2>' +
      '<p class="jp-hero__body">No setup fees.</p>' +
      '<img class="jp-hero__media" src="media/hero-a1b2c3.jpg" alt="A team at work">' +
      '<a class="jp-hero__cta" href="/en-us/pricing/">Get started</a>' +
      '</section>',
  );
});

test('hero — minimal props (heading only) omit every optional element', async () => {
  const html = norm(await render('Hero.astro', { heading: 'Sales & Marketing' }));
  assert.equal(
    html,
    '<section class="jp-hero"><h2 class="jp-hero__heading">Sales &amp; Marketing</h2></section>',
  );
});

test('hero — decorative media gets an empty alt, not the (absent) alt text', async () => {
  const html = norm(await render('Hero.astro', {
    heading: 'X',
    media: { ref: 'media/bg.jpg', decorative: true },
  }));
  assert.match(html, /<img class="jp-hero__media" src="media\/bg\.jpg" alt(?:=""|[ >])/);
});

test('featureGrid — data-columns on the section, one .__item per entry', async () => {
  const html = norm(await render('FeatureGrid.astro', {
    columns: 3,
    items: [
      { heading: 'Fast', body: 'Static delivery from the edge.' },
      { heading: 'Safe', body: 'No database, no PHP.' },
    ],
  }));
  assert.equal(
    html,
    '<section class="jp-feature-grid" data-columns="3">' +
      '<div class="jp-feature-grid__item">' +
      '<h3 class="jp-feature-grid__heading">Fast</h3>' +
      '<p class="jp-feature-grid__body">Static delivery from the edge.</p>' +
      '</div>' +
      '<div class="jp-feature-grid__item">' +
      '<h3 class="jp-feature-grid__heading">Safe</h3>' +
      '<p class="jp-feature-grid__body">No database, no PHP.</p>' +
      '</div>' +
      '</section>',
  );
});

test('featureGrid — data-columns reflects each of the three permitted widths', async () => {
  for (const columns of [2, 3, 4]) {
    const html = await render('FeatureGrid.astro', {
      columns,
      items: [{ heading: 'A', body: 'B' }, { heading: 'C', body: 'D' }],
    });
    assert.match(html, new RegExp(`data-columns="${columns}"`));
  }
});

test('cta — heading, body and link all carry their contract classes', async () => {
  const html = norm(await render('Cta.astro', {
    heading: 'Ready to start?',
    body: 'Takes five minutes.',
    link: { label: 'Sign up', href: '/en-us/pricing/' },
  }));
  assert.equal(
    html,
    '<section class="jp-cta">' +
      '<h2 class="jp-cta__heading">Ready to start?</h2>' +
      '<p class="jp-cta__body">Takes five minutes.</p>' +
      '<a class="jp-cta__link" href="/en-us/pricing/">Sign up</a>' +
      '</section>',
  );
});

test('cta — body is optional, link is not', async () => {
  const html = norm(await render('Cta.astro', {
    heading: 'Ready to start?',
    link: { label: 'Sign up', href: '/en-us/pricing/' },
  }));
  assert.equal(
    html,
    '<section class="jp-cta">' +
      '<h2 class="jp-cta__heading">Ready to start?</h2>' +
      '<a class="jp-cta__link" href="/en-us/pricing/">Sign up</a>' +
      '</section>',
  );
});

/* The guard, watched failing. Without these, "resolution happens upstream" is a convention
 * that a future route can quietly break — which is exactly how the bare-ULID href shipped in
 * the first place. A block handed the raw contract shape must not render an href at all. */
test('hero — an unresolved cta is a build failure, not a bare ULID href', async () => {
  await assert.rejects(
    () => render('Hero.astro', {
      heading: 'Pricing & plans',
      cta: { label: 'Get started', ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    }),
    /hero cta reached the renderer unresolved/,
  );
});

test('cta — an unresolved link is a build failure, not a bare ULID href', async () => {
  await assert.rejects(
    () => render('Cta.astro', {
      heading: 'Ready to start?',
      link: { label: 'Sign up', ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    }),
    /cta link reached the renderer unresolved/,
  );
});
