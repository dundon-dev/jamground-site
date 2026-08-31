// The mu-plugin: allowlist, stripped supports, block assets, welcome guide, the trimmed
// admin surface, the inline-format allowlist, and site links that name the site.
//
// The admin-surface half of this is only observable here. `remove_menu_page`,
// `wp_dashboard_setup`, `unregisterFormatType` and the permalink filters all run inside the
// WASM instance, so no Node test can see any of them — and `npm test`'s editor glob is
// non-recursive and never reaches this directory. If this file is not run, that whole half of
// the mu-plugin is unverified.
//
// The allowlist alone is a content-quality / round-trip mechanism, never a security
// control — this test only observes what the inserter offers, in-browser. There is no
// jamground/* block in this release, so the inserter assertion owed here is the NEGATIVE
// one: forbidden core blocks (Columns, Cover, Group, …) must not appear. The positive form —
// a custom block appearing — has no reproducible artefact and is not asserted.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { SITE_URL } from '../../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, {
    cwd: editorDir,
    stdio: 'pipe',
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(distDir, 'index.html')).then((content) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        });
      } else {
        const filePath = path.join(distDir, req.url);
        fs.readFile(filePath).then(
          (content) => {
            const contentType = req.url.endsWith('.js') ? 'application/javascript' : 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
          },
          () => {
            res.writeHead(404);
            res.end('Not found');
          }
        );
      }
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

test('mu-plugin: allowlist, supports, block assets, welcome guide, trimmed admin, formats, site links', async () => {
  await buildBundle();

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => {
      return window.jamgroundReady === true || typeof window.jamgroundBootError !== 'undefined';
    }, { timeout: 240000 });

    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    // Create a post and navigate to its edit screen so the mu-plugin's admin_init and
    // enqueue_block_assets hooks fire for a request made after the file was written.
    const postId = await page.evaluate(async () => {
      const client = window.jamgroundClient;
      const root = await client.documentRoot;
      await client.writeFile(root + '/jp-seed.php', `<?php require '${root}/wp-load.php';
        $id = wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Probe',
          'post_content'=>"<!-- wp:heading -->\\n<h2 class=\\"wp-block-heading\\">Section</h2>\\n<!-- /wp:heading -->"]);
        echo 'POST:' . $id;`);
      const s = await client.run({ code: `<?php require '${root}/jp-seed.php';` });
      return (s.text.match(/POST:(\d+)/) || [])[1];
    });
    assert(postId, 'seed post should have been created');

    await page.evaluate(async (id) => {
      await window.jamgroundClient.goTo('/wp-admin/post.php?post=' + id + '&action=edit');
    }, postId);

    // Find the frame that actually holds wp-admin, whatever the nesting (the iframe is
    // cross-origin, so the shell page cannot inspect it directly — Playwright can).
    let admin = null;
    let canvasFrame = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (!admin && await f.locator('#editor, .interface-interface-skeleton, .editor-header').count()) admin = f;
          if (!canvasFrame && await f.locator('.block-editor-writing-flow, .block-editor-block-list__layout').count()) canvasFrame = f;
        } catch {}
      }
      if (admin && canvasFrame) break;
      await page.waitForTimeout(250);
    }
    assert(admin, 'the wp-admin frame should be reachable');

    // 4. Welcome guide suppressed.
    const welcomeGuideCount = await admin.locator('.edit-post-welcome-guide, .components-guide').count();
    assert.equal(welcomeGuideCount, 0, 'the welcome guide should not appear');

    // 3. enqueue_block_assets: the shared stylesheet loads inside the editor canvas.
    const cf = canvasFrame && canvasFrame !== admin ? canvasFrame : admin.childFrames()[0];
    assert(cf, 'the editor canvas frame should be reachable');
    const probe = await cf.locator('body').evaluate((b) => getComputedStyle(b).getPropertyValue('--jp-mu-plugin'));
    assert.equal(String(probe).trim(), 'present', 'enqueue_block_assets CSS should be inside the canvas');

    // 1. allowed_block_types_all: the inserter is restricted. This is the NEGATIVE
    // assertion — no jamground/* block exists yet, so
    // only the absence of disallowed core blocks is checked.
    await admin.locator('button[aria-label*="Block Inserter" i]').first().click({ timeout: 15000 });
    await page.waitForTimeout(3000);
    const names = [...new Set(
      (await admin.locator('.block-editor-block-types-list__item-title').allInnerTexts()).map((s) => s.trim()).filter(Boolean)
    )];
    assert(names.length > 0, 'the inserter should offer at least one block');
    assert(
      !names.some((n) => /^(Columns|Cover|Group|Buttons|Gallery)$/i.test(n)),
      `the inserter should not offer disallowed blocks, got: ${names.join(', ')}`
    );

    // 1b. THE POSITIVE FORM, which this test never asserted. The negative above passes just
    // as well against an inserter that offers nothing at all, and an empty inserter is a
    // failure mode this project has shipped before (a held-back entity produced a
    // fully-working, completely empty wp-admin). Eight blocks, by name.
    for (const expected of ['Paragraph', 'Heading', 'List', 'Quote', 'Code', 'Table', 'Separator']) {
      assert(
        names.some((n) => n.toLowerCase() === expected.toLowerCase()),
        `the inserter should offer ${expected}, got: ${names.join(', ')}`
      );
    }

    // 1c. Image is gone, and its absence is the point rather than an oversight: both mappers
    // refuse it, so while it was offered an editor could do work that could not be saved.
    assert(
      !names.some((n) => /^image$/i.test(n)),
      `the inserter should not offer Image while there is no media path, got: ${names.join(', ')}`
    );

    // 10. The inline-format allowlist. Asserted through the registry rather than by opening
    // the toolbar's "More" menu: the menu's markup is Gutenberg's to change, the registry is
    // the thing the mu-plugin actually acts on, and a toolbar assertion that silently stops
    // finding its selector would pass for the wrong reason.
    // The registry is the `core/rich-text` data store, not a function on wp.richText — that
    // module exports register/unregister only, which is what the mu-plugin calls.
    const formats = await admin.evaluate(() => {
      const store = window.wp && wp.data && wp.data.select('core/rich-text');
      return store ? store.getFormatTypes().map((f) => f.name).sort() : null;
    });
    assert(formats, 'the core/rich-text store should be reachable in the editor frame');
    assert(formats.length > 0, 'the format registry should not be empty — an empty one would pass every check below for the wrong reason');
    for (const kept of ['core/bold', 'core/italic', 'core/code', 'core/link']) {
      assert(formats.includes(kept), `${kept} is one of the contract's four marks, got: ${formats.join(', ')}`);
    }
    for (const gone of ['core/strikethrough', 'core/superscript', 'core/subscript', 'core/text-color', 'core/image']) {
      assert(
        !formats.includes(gone),
        `${gone} has no contract representation and throws at save time, so it must not be offered, got: ${formats.join(', ')}`
      );
    }

    // 12. Site links name the site. Two cases, and the second is the honest-absence one.
    //
    // A real imported entity carries `_jamground_id`, so it was in the map boot wrote and its
    // permalink is rewritten. The probe post above does NOT — it was inserted directly, after
    // boot — so it has no address anywhere and its preview link must be empty rather than a
    // WASM address presented as the site.
    const links = await page.evaluate(async (probeId) => {
      const client = window.jamgroundClient;
      const root = await client.documentRoot;
      await client.writeFile(root + '/jp-links-probe.php', `<?php require '${root}/wp-load.php';
        $ours = get_posts(['post_type' => ['post', 'page'], 'post_status' => ['publish', 'draft'],
          'numberposts' => 1, 'meta_query' => [['key' => '_jamground_id', 'compare' => 'EXISTS']]]);
        echo json_encode([
          'imported'        => $ours ? get_permalink($ours[0]->ID) : null,
          'importedStatus'  => $ours ? $ours[0]->post_status : null,
          'probePermalink'  => get_permalink(${probeId}),
          'probePreview'    => get_preview_post_link(${probeId}),
          'homeUrl'         => home_url('/'),
        ]);`);
      const out = await client.run({ code: `<?php require '${root}/jp-links-probe.php';` });
      return JSON.parse(out.text);
    }, postId);

    assert(links.imported, 'at least one imported entity should be in the database to check a link against');
    // Only a published entity has an address while no change is open, which is exactly the
    // rule the map applies — so this pair of assertions is conditional on the same fact.
    if (links.importedStatus === 'publish') {
      assert(
        links.imported.startsWith(SITE_URL),
        `an imported entity's permalink should name the site, got: ${links.imported}`
      );
      assert(
        !links.imported.includes('playground.wordpress.net'),
        `a permalink must not name the WASM origin, got: ${links.imported}`
      );
      assert(
        /\/[^/]+\/$/.test(links.imported),
        `a permalink should be a real path with a trailing slash, as links.ts promises, got: ${links.imported}`
      );
      // The WASM origin is what every one of these links used to be, so it is worth naming as
      // the thing that must no longer appear.
      assert(
        links.homeUrl.includes('playground.wordpress.net'),
        `home_url() should still be the WASM origin — if it is not, this test is no longer proving the filters did the work, got: ${links.homeUrl}`
      );
    }

    assert.equal(
      links.probePreview, '',
      `an entity with no address anywhere should get no preview link, got: ${links.probePreview}`
    );

    // 5/6/7/8/9. The trimmed admin surface, on the screen the blueprint lands an editor on.
    await page.evaluate(async () => { await window.jamgroundClient.goTo('/wp-admin/'); });

    let dash = null;
    const dashDeadline = Date.now() + 60000;
    while (Date.now() < dashDeadline) {
      for (const f of page.frames()) {
        try {
          if (await f.locator('#adminmenu').count()) { dash = f; break; }
        } catch {}
      }
      if (dash) break;
      await page.waitForTimeout(250);
    }
    assert(dash, 'the dashboard should be reachable');

    // 5. Exactly the three kinds this product round-trips — asserted as a SET, so a menu that
    // reappears fails here as loudly as one that goes missing.
    const menuIds = (await dash.locator('#adminmenu > li').evaluateAll(
      (lis) => lis
        .filter((li) => !li.classList.contains('wp-menu-separator') && li.id !== 'collapse-menu')
        .map((li) => li.id)
    )).sort();
    assert.deepEqual(
      menuIds,
      ['menu-pages', 'menu-posts', 'menu-posts-jamground_author'],
      `the menu should be Posts, Pages, Authors and nothing else, got: ${menuIds.join(', ')}`
    );

    // 6. The admin bar keeps nothing that leads out of the product. `my-account` is the one
    // worth naming: WordPress re-adds it at priority 9999, so this assertion is the only thing
    // standing between the mu-plugin's priority and a silent regression.
    for (const node of ['wp-logo', 'new-content', 'comments', 'my-account', 'command-palette']) {
      assert.equal(
        await dash.locator(`#wp-admin-bar-${node}`).count(), 0,
        `the admin bar should not offer ${node}`
      );
    }

    // 12, second half. The site name is the one admin-bar node that stays, and it stays only
    // because it now has a real address to point at.
    const siteNameHref = await dash.locator('#wp-admin-bar-site-name a').first().getAttribute('href');
    assert(siteNameHref, 'the admin bar should still name the site');
    assert(
      siteNameHref.startsWith(SITE_URL) && !siteNameHref.includes('playground.wordpress.net'),
      `the site name should link to the site, got: ${siteNameHref}`
    );

    // 7. Every core widget, and the welcome panel.
    for (const box of ['welcome-panel', 'dashboard_primary', 'dashboard_right_now',
                       'dashboard_activity', 'dashboard_quick_press', 'dashboard_site_health']) {
      assert.equal(
        await dash.locator(`#${box}`).count(), 0,
        `the dashboard should not show ${box}`
      );
    }

    // 8. The footer says nothing about WordPress or its version.
    assert.equal(await dash.locator('#footer-thankyou').count(), 0, 'the footer thank-you should be gone');
    const upgrade = (await dash.locator('#footer-upgrade').allInnerTexts()).join('').trim();
    assert.equal(upgrade, '', `the footer should name no version, got: ${upgrade}`);

    // 9. Help tabs, and therefore the Help button.
    assert.equal(await dash.locator('#contextual-help-link').count(), 0, 'the help tab button should be gone');
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
    server.close();
  }
});
