import { defineConfig } from 'astro/config';
// The one place the deployment's identity is declared (jamground.config.mjs's own header
// explains why it is a committed plain module rather than an environment variable).
import { siteUrl } from './jamground.config.mjs';

export default defineConfig({
  site: siteUrl,
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    /* 'auto' (the default) inlines a stylesheet under Vite's 4 KB assetsInlineLimit into
     * every page's <head> and drops the asset entirely — so the emitted shape of the site
     * would flip as the design system crosses a size threshold nobody is watching. 'never'
     * keeps one cacheable file under _astro/ for all eight routes, and keeps the HTML
     * diffable. */
    inlineStylesheets: 'never',
  },
});
