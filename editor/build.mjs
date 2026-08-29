#!/usr/bin/env node
// Build script for the shell - bundles entry.mjs and inlines blueprint.json

import * as esbuild from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

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

    // Run esbuild
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, 'entry.mjs')],
      outfile: path.join(distDir, 'shell.js'),
      format: 'esm',
      bundle: true,
      platform: 'browser',
      sourcemap: true,
      minify: false,
      external: ['https://unpkg.com/*'],
    });

    console.log('Build successful');

    // Copy index.html to dist and inject blueprint
    const htmlPath = path.join(__dirname, 'index.html');
    let htmlContent = await fs.readFile(htmlPath, 'utf-8');

    // Inject blueprint and mu-plugin source as global variables in the HTML
    const blueprintScript = `<script>window.__blueprint = ${JSON.stringify(blueprintData)};</script>`;
    const muPluginScript = `<script>window.__muPluginSource = ${JSON.stringify(muPluginSource)};</script>`;
    htmlContent = htmlContent.replace('</head>', `${blueprintScript}${muPluginScript}</head>`);

    const distHtmlPath = path.join(distDir, 'index.html');
    await fs.writeFile(distHtmlPath, htmlContent);
    console.log('Copied and inlined index.html to dist');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
