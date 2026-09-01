import { defineConfig } from 'astro/config';
// The one place the deployment's identity is declared (jamground.config.mjs's own header
// explains why it is a committed plain module rather than an environment variable).
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteUrl } from './jamground.config.mjs';
import { copyMedia, mediaFile } from './src/lib/media.ts';

/* MEDIA ORIGINALS INTO THE BUILD, which nothing did before — `public/` holds robots.txt and
 * nothing else, and `content/media/` lives in the OTHER repository, so no amount of `publicDir`
 * configuration reaches it (that setting takes one directory, and this project already uses it).
 * src/lib/media.ts turns a reference into `/media/<file>`; this is what puts the bytes there.
 *
 * BOTH HOOKS, because a media reference that works in the built site and 404s in `npm run dev` is
 * a difference nobody would think to check for. `astro:build:done` copies; `astro:server:setup`
 * serves the same directory out of the dev server without copying anything.
 *
 * THE BUILD HALF IS VERIFIED END TO END and the dev half is not: `astro dev` does not start in the
 * sandbox this was written in — identically on the config before this integration existed, so it
 * is the environment and not this code. The lookup it depends on, `mediaFile`, is tested directly
 * (test/media.test.mjs, traversal included); what is unobserved is the hook wiring around it. One
 * `npm run dev` and a request for `/media/<a committed filename>` settles it.
 *
 * It is an integration rather than a Vite plugin because `dir` — the resolved output directory —
 * is what `astro:build:done` is handed, and hard-coding `dist/` beside a config that could name
 * another one is how the two come apart. */
function jamgroundMedia() {
  return {
    name: 'jamground:media',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const copied = copyMedia(fileURLToPath(dir));
        logger.info(copied.length
          ? `copied ${copied.length} media original(s) into media/`
          : 'no media originals to copy');
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/media', (req, res, next) => {
          const name = basename(decodeURIComponent((req.url ?? '').split('?')[0]));
          const file = mediaFile(name);
          if (!file) return next();
          createReadStream(file).pipe(res);
        });
      },
    },
  };
}

export default defineConfig({
  site: siteUrl,
  integrations: [jamgroundMedia()],
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
