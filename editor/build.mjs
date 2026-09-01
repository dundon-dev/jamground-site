#!/usr/bin/env node
/* Build script for the shell — bundles entry.mjs, inlines blueprint.json, and turns the
 * deployment's identity into literals.
 *
 * THE DEFINES ARE THE WHOLE REASON THIS FILE IS IMPORTABLE. ../jamground.config.mjs resolves
 * its six values from `process.env.JAMGROUND_…`, which does not exist in a browser. This
 * script resolves them HERE, in Node — where a `.env` the operator sourced is visible — and
 * hands esbuild a `define` map, so the shipped bundle contains the values as string literals
 * and no `process.env` of ours at all. `browserDefines` is exported, and the module runs
 * nothing on import, so editor/test/bundles-for-browser.test.mjs can assert against the exact
 * map this build uses rather than a second copy of it that could quietly drift.
 */

import * as esbuild from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { declarations } from '../jamground.config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

/**
 * The `define` map for a browser bundle: one entry per declared value, keyed by the exact
 * static member expression ../jamground.config.mjs reads.
 *
 * An unset variable is defined as the empty string rather than left undefined, because the
 * config module treats empty as unset and falls back — the same rule Ansible's
 * `| default(…, true)` applies on the deploy side. Every entry is therefore a string literal,
 * and nothing is left for the browser to resolve.
 */
export function browserDefines(env = process.env) {
  return Object.fromEntries(
    Object.values(declarations).map(({ env: variable }) => [
      `process.env.${variable}`,
      JSON.stringify(env[variable] ?? ''),
    ]),
  );
}

/**
 * THE CANVAS STYLESHEET — the design system as one string, for the mu-plugin's section 3.
 *
 * Exported for the same reason `browserDefines` is: editor/test/canvas-css.test.mjs asserts
 * against the exact bytes this build substitutes, rather than against a second copy of the rules
 * that could quietly drift from it.
 *
 * WHICH FILES, AND WHY NOT design/site.css: tokens first (everything below reads its custom
 * properties), then base.css — reset, element defaults and the eight core wp-block-* selectors —
 * then the three custom block sheets. site.css is the PAGE: chrome selectors for elements the
 * canvas does not have, and a `body` that is `min-height: 100vh; display: flex`, a layout assuming
 * header/main/footer children. base.css and site.css are separate files so that this can be a list
 * of whole files rather than a rule about which parts of one to send.
 *
 * A MISSING FILE FAILS THE BUILD, because the failure it would otherwise cause is a canvas that
 * looks subtly wrong — one block sheet short — which is not a symptom anyone can read.
 */
export const CANVAS_STYLESHEETS = [
  'tokens.css', 'base.css', 'blocks/hero.css', 'blocks/feature-grid.css', 'blocks/cta.css',
];

export async function canvasStylesheet() {
  const designDir = path.join(__dirname, '..', 'design');
  const parts = await Promise.all(CANVAS_STYLESHEETS.map(async (file) => {
    const source = await fs.readFile(path.join(designDir, file), 'utf-8');
    return `/* design/${file} */\n${source}`;
  }));
  return parts.join('\n');
}

/**
 * Escape for a PHP SINGLE-QUOTED literal, where exactly two characters are special: the backslash
 * and the apostrophe. Nothing else is — not `$`, not `{`, not a newline — because a single-quoted
 * string interpolates nothing, which is why it is the target rather than a double-quoted one.
 *
 * Backslash first, or the backslashes this adds for apostrophes would themselves be escaped.
 *
 * A heredoc was the alternative and is worse: a nowdoc terminator appearing in the CSS would end
 * the string silently, and CSS is a file other people edit.
 */
export function phpSingleQuoted(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export const CANVAS_CSS_PLACEHOLDER = '__JAMGROUND_CANVAS_CSS__';

/** Substitute the stylesheet into the mu-plugin source, refusing a source with nowhere to put it. */
export function substituteCanvasCss(muPluginSource, css) {
  if (!muPluginSource.includes(CANVAS_CSS_PLACEHOLDER)) {
    throw new Error(
      `editor/build.mjs: the mu-plugin has no ${CANVAS_CSS_PLACEHOLDER} to substitute the canvas ` +
      'stylesheet into — section 3 would ship a canvas with no design system and say so at runtime',
    );
  }
  return muPluginSource.replace(CANVAS_CSS_PLACEHOLDER, phpSingleQuoted(css));
}

async function build() {
  try {
    // Create dist directory if it doesn't exist
    await fs.mkdir(distDir, { recursive: true });

    // Read blueprint.json to inline it
    const blueprintPath = path.join(__dirname, 'blueprint.json');
    let blueprintData = {};
    try {
      const blueprintContent = await fs.readFile(blueprintPath, 'utf-8');
      blueprintData = JSON.parse(blueprintContent);
    } catch (error) {
      console.warn('Could not read blueprint.json:', error.message);
    }

    const canvasCss = await canvasStylesheet();

    // Read the mu-plugin PHP source to inline it. The blueprint carries no content —
    // the shell writes this file into the WASM filesystem itself, after
    // boot, with mkdir plus writeFile.
    const muPluginPath = path.join(__dirname, 'mu-plugin', 'jamground.php');
    let muPluginSource = '';
    try {
      muPluginSource = await fs.readFile(muPluginPath, 'utf-8');
    } catch (error) {
      console.warn('Could not read mu-plugin/jamground.php:', error.message);
    }

    muPluginSource = substituteCanvasCss(muPluginSource, canvasCss);

    // THE BLOCK BUNDLE — the second entry point, and the only way the three jamground/* blocks
    // reach the inserter. 03 §Custom-blocks (PoC-7d) settles that PHP registration alone gives a
    // registered type with no `edit` that never appears, and there is no build step inside
    // Playground, so it is built here and carried in.
    //
    // IIFE, NOT ESM, and the format is load-bearing. WordPress prints an enqueued script with a
    // plain <script> tag, and an ESM bundle's top-level `export` in a classic script is a syntax
    // error that takes the whole file with it before a line runs — an empty inserter with one
    // console message that names no block. `wp-*` are marked external and read off the global
    // instead, so no second React enters the page.
    const blocksResult = await esbuild.build({
      entryPoints: [path.join(__dirname, 'blocks', 'browser.mjs')],
      outfile: path.join(distDir, 'blocks.js'),
      format: 'iife',
      bundle: true,
      platform: 'browser',
      target: 'es2017',
      sourcemap: false,
      minify: false,
      external: ['@wordpress/*'],
    });

    // Run esbuild
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, 'entry.mjs')],
      outfile: path.join(distDir, 'shell.js'),
      format: 'esm',
      bundle: true,
      platform: 'browser',
      sourcemap: true,
      minify: false,
      define: browserDefines(),
      external: ['https://unpkg.com/*'],
    });

    console.log(`Build successful (block bundle: ${blocksResult.errors.length} errors)`);

    // Copy index.html to dist and inject blueprint
    const htmlPath = path.join(__dirname, 'index.html');
    let htmlContent = await fs.readFile(htmlPath, 'utf-8');

    // Inject blueprint and mu-plugin source as global variables in the HTML
    const blueprintScript = `<script>window.__blueprint = ${JSON.stringify(blueprintData)};</script>`;
    const muPluginScript = `<script>window.__muPluginSource = ${JSON.stringify(muPluginSource)};</script>`;

    // The block bundle travels the same way the mu-plugin does — as a string on `window`, read by
    // entry.mjs and written into the WASM filesystem after boot — rather than as a file the
    // browser fetches. Playground's filesystem is not the shell's origin, so there is no URL the
    // editor could load it from that the shell could also have produced.
    const blocksBundle = await fs.readFile(path.join(distDir, 'blocks.js'), 'utf-8');
    const blocksScript = `<script>window.__blockBundleSource = ${JSON.stringify(blocksBundle)};</script>`;
    htmlContent = htmlContent.replace('</head>', `${blueprintScript}${muPluginScript}${blocksScript}</head>`);

    const distHtmlPath = path.join(distDir, 'index.html');
    await fs.writeFile(distHtmlPath, htmlContent);
    console.log('Copied and inlined index.html to dist');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Guarded, so importing this module for `browserDefines` builds nothing.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) build();
