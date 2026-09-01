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
// control — this test only observes what the inserter offers, in-browser.
//
// THE POSITIVE FORM IS NOW ASSERTED, and this file is the only place it can be. PoC-7d
// (03 §Custom-blocks) found that PHP registration alone gives a registered type that never
// appears in the inserter, so the three jamground/* blocks are registered by a JavaScript bundle
// the shell writes into the WASM filesystem — and every step of that has the same symptom when it
// goes wrong: an inserter that is quietly short, with nothing in any console. The bundle can fail
// to be written, fail to be enqueued, fail to find `wp.blockEditor`, or register a block that
// hook 1's allowlist then filters back out. None of those is visible from Node.
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

    // 1d. THE THREE CUSTOM BLOCKS, and each assertion below distinguishes one way the chain
    // fails from the others. `window.__jamgroundBlocks` is set by the bundle itself, so it tells
    // "the bundle never ran" apart from "the bundle ran and registered nothing" — which the
    // registry alone cannot, because a block could in principle be there for another reason.
    const bundle = await admin.evaluate(() => window.__jamgroundBlocks || null);
    assert(bundle, 'the block bundle did not run at all — check that entry.mjs wrote jamground-blocks.js and section 14 enqueued it');
    assert(!bundle.error, `the block bundle ran and failed: ${bundle.error}`);
    assert.deepEqual(bundle.registered, ['jamground/hero', 'jamground/feature-grid', 'jamground/cta']);

    const custom = await admin.evaluate(() => {
      const types = {};
      for (const name of ['jamground/hero', 'jamground/feature-grid', 'jamground/cta']) {
        const type = wp.blocks.getBlockType(name);
        types[name] = type ? {
          hasEdit: typeof type.edit === 'function',
          savesNull: type.save() === null,
          attributes: Object.keys(type.attributes).sort(),
          customClassName: wp.blocks.hasBlockSupport(type, 'customClassName', true),
          html: wp.blocks.hasBlockSupport(type, 'html', true),
        } : null;
      }
      return types;
    });

    for (const [name, type] of Object.entries(custom)) {
      assert(type, `${name} is not in the editor's registry — the bundle ran but did not register it`);
      // The `edit` is the whole reason a bundle exists rather than PHP registration. PoC-7d's
      // finding was precisely a registered type WITHOUT one, which never reached the inserter.
      assert(type.hasEdit, `${name} has no edit component, which is the PoC-7d failure exactly`);
      assert(type.savesNull, `${name} must be dynamic — 11 §4b`);
      // Correction 2: `register_block_type_args` (section 2) does not fire for a block registered
      // in JavaScript only, so these three must carry their own stripped supports. If this fails,
      // the Advanced panel is offering an "Additional CSS class(es)" field that export refuses.
      assert.equal(type.customClassName, false, `${name} must strip customClassName itself — no PHP filter reaches it`);
      assert.equal(type.html, false, `${name} must not offer an HTML edit view of markup the contract owns`);
    }
    // A SUPERSET, AND A TRIPWIRE ON WHAT MAKES IT ONE. WordPress adds `lock`, `metadata` and
    // `style` to every block it registers, so the registered set is never just the contract's
    // fields — which is why attribute-guard.mjs allowlists a jamground/* block from the
    // definitions table and not from `getBlockType().attributes`. Pinned in both directions: the
    // contract's fields must all be there, and the extras must be exactly those three, so a
    // WordPress upgrade adding a fourth arrives as a failure here rather than as three
    // attributes' worth of silent slack in layer 3.
    const WP_UNIVERSAL = ['lock', 'metadata', 'style'];
    for (const [name, contractFields] of [
      ['jamground/hero', ['body', 'cta', 'heading', 'media']],
      ['jamground/feature-grid', ['columns', 'items']],
      ['jamground/cta', ['body', 'heading', 'link']],
    ]) {
      for (const field of contractFields) {
        assert(custom[name].attributes.includes(field), `${name} must register ${field}, got: ${custom[name].attributes.join(', ')}`);
      }
      assert.deepEqual(
        custom[name].attributes.filter((a) => !contractFields.includes(a)).sort(), WP_UNIVERSAL,
        `${name} registered attributes beyond the contract and WordPress's own three`,
      );
    }

    // 1e. And what the INSERTER does with them, which is a different question from what the
    // registry holds: hook 1 filters the registry down, so a registered block can be absent here.
    for (const expected of ['Hero', 'Feature grid']) {
      assert(
        names.some((n) => n.toLowerCase() === expected.toLowerCase()),
        `the inserter should offer ${expected}, got: ${names.join(', ')}`
      );
    }
    // Call to action is registered and round-trips, and is deliberately NOT offered: `Cta.link` is
    // required and there is no entity picker, so one inserted from this menu could not be saved.
    // Same argument as Image, one line up.
    assert(
      !names.some((n) => /^call to action$/i.test(n)),
      `the inserter should not offer Call to action while there is no entity picker, got: ${names.join(', ')}`
    );

    // 1f. THE CANVAS, which is the assertion the fidelity gate cannot make. That gate compares the
    // markup module's two renderings in Node; this compares what the REAL edit component put in
    // the REAL editor against the markup contract 11 §4c freezes. Between them they close the
    // chain: Astro == module (custom.test.mjs), module == React (fidelity.test.mjs), React == the
    // canvas (here).
    await admin.evaluate(() => {
      const block = wp.blocks.createBlock('jamground/hero', {
        heading: 'Fidelity probe', body: 'Body text.',
      });
      wp.data.dispatch('core/block-editor').insertBlocks(block);
    });
    await page.waitForTimeout(2000);

    const heroShape = await cf.locator('section.jp-hero').first().evaluate((section) => ({
      tag: section.tagName.toLowerCase(),
      heading: section.querySelector('.jp-hero__heading')
        && { tag: section.querySelector('.jp-hero__heading').tagName.toLowerCase(),
             text: section.querySelector('.jp-hero__heading').textContent },
      body: section.querySelector('.jp-hero__body')
        && { tag: section.querySelector('.jp-hero__body').tagName.toLowerCase(),
             text: section.querySelector('.jp-hero__body').textContent },
      // Absent attributes must render no element at all, not an empty one — an empty <img> in the
      // canvas would be a picture of a hero the site will not draw.
      media: section.querySelectorAll('.jp-hero__media').length,
      cta: section.querySelectorAll('.jp-hero__cta').length,
      // The wrapper question: apiVersion 3 puts the block props on the outermost element, and if
      // that element is a div wrapping our section, the block CSS has an extra box to fight.
      wrappedInDiv: section.parentElement.classList.contains('wp-block'),
    }));

    assert.equal(heroShape.tag, 'section');
    assert.deepEqual(heroShape.heading, { tag: 'h2', text: 'Fidelity probe' });
    assert.deepEqual(heroShape.body, { tag: 'p', text: 'Body text.' });
    assert.equal(heroShape.media, 0, 'an absent media must render no <img>');
    assert.equal(heroShape.cta, 0, 'an absent cta must render no <a>');
    assert.equal(heroShape.wrappedInDiv, false, 'useBlockProps must land on the contract\'s own root element');

    // 3b. THE DESIGN SYSTEM REACHED THE BLOCK, which is a different claim from the marker above.
    // The marker proves section 3's `enqueue_block_assets` half ran; this proves the editor-styles
    // half arrived and applies to the hero just inserted. Computed values, not the presence of a
    // <style> tag: a stylesheet that loads and matches nothing looks exactly like one that works.
    // ARRIVING IS NOT WINNING, and this used to assert only arriving. The canvas is a WordPress
    // theme's document as well as ours: Twenty Twenty-Five's theme.json generates `h1,h2,h3,h4,h5,h6
    // { font-weight: 400; letter-spacing: -0.1px }` and a `body { font-family: Manrope }`, into a
    // stylesheet the editor injects AFTER `block_editor_settings_all`'s. Element selectors on both
    // sides, equal specificity, later wins — so every element default in design/base.css lost while
    // every class rule in design/blocks/*.css won, and the canvas rendered the right panels in the
    // wrong typeface. Section 3's `wp_theme_json_data_theme` filter takes the theme's styles out of
    // the way; this is what says so.
    //
    // COMPARED AGAINST THE TOKENS RESOLVED IN THIS DOCUMENT, not against a copy of their values.
    // The old assertion was `/system-ui|-apple-system|Segoe|sans-serif/i` against the computed
    // family, and `Manrope, sans-serif` matches it — a generic fallback is in every stack, so the
    // regex passed on the theme's font for as long as the defect existed. A probe element that
    // reads `var(--jp-font-sans)` in the same document cannot be satisfied that way, and needs no
    // updating when a token changes.
    const styled = await cf.locator('section.jp-hero').first().evaluate((section) => {
      const h = section.querySelector('.jp-hero__heading');
      const body = section.querySelector('.jp-hero__body');
      const hs = getComputedStyle(h);
      const bs = getComputedStyle(body);

      const probe = document.createElement('div');
      probe.style.cssText = 'font-family: var(--jp-font-sans); font-weight: var(--jp-weight-bold);'
        // `--jp-tracking-tight` is in `em`, so it resolves against the element's OWN size, and the
        // hero heading's size is a clamp() on the viewport — the probe has to be given the size it
        // is standing in for or the comparison is between two different multiplications.
        + ` color: var(--jp-color-heading); letter-spacing: var(--jp-tracking-tight);`
        + ` font-size: ${hs.fontSize}`;
      document.body.appendChild(probe);
      const want = getComputedStyle(probe);
      const wanted = {
        fontFamily: want.fontFamily, fontWeight: want.fontWeight,
        color: want.color, letterSpacing: want.letterSpacing,
      };
      probe.remove();
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue('--jp-color-heading').trim(),
        wanted,
        heading: { fontFamily: hs.fontFamily, fontWeight: hs.fontWeight, color: hs.color,
                   letterSpacing: hs.letterSpacing, fontSize: hs.fontSize },
        // The BODY carries the other half: `p` and `body` are element selectors too, so a heading
        // that is right does not make a paragraph right.
        body: { fontFamily: bs.fontFamily, fontWeight: bs.fontWeight },
      };
    });
    assert.notEqual(styled.token, '', 'design/tokens.css did not reach the canvas — every rule below it reads these custom properties');
    // The block sheet's own rule, not an element default — so this distinguishes "tokens.css and
    // base.css arrived" from "design/blocks/hero.css arrived". A class selector, so it was never
    // the one at risk; kept because losing it would go unnoticed.
    assert.notEqual(styled.heading.fontSize, '', 'the hero heading has no font size at all');
    assert.notEqual(styled.heading.color, 'rgb(0, 0, 0)',
      'the heading is still the browser default black, so the design system matched nothing');

    assert.equal(styled.heading.fontFamily, styled.wanted.fontFamily,
      `the canvas heading should be set in --jp-font-sans, got: ${styled.heading.fontFamily}`);
    assert.equal(styled.heading.fontWeight, styled.wanted.fontWeight,
      `the canvas heading should be --jp-weight-bold, got: ${styled.heading.fontWeight}`);
    assert.equal(styled.heading.letterSpacing, styled.wanted.letterSpacing,
      `the canvas heading should carry --jp-tracking-tight, got: ${styled.heading.letterSpacing}`);
    assert.equal(styled.heading.color, styled.wanted.color,
      `the canvas heading should be --jp-color-heading, got: ${styled.heading.color}`);
    assert.equal(styled.body.fontFamily, styled.wanted.fontFamily,
      `the canvas body copy should be set in --jp-font-sans, got: ${styled.body.fontFamily}`);
    assert.equal(styled.body.fontWeight, '400',
      `the canvas body copy should be --jp-weight-normal, got: ${styled.body.fontWeight}`);

    // AND THE CANVAS LAYS OUT TO THE SITE'S OWN WIDTH. Section 3's filter hands WordPress
    // `var(--jp-container)` for the content size rather than a copy of its value, so the width the
    // canvas column takes and the width design/blocks/*.css caps each section at are one
    // declaration. Asserted as two `max-width` resolutions rather than two measured widths, because
    // a canvas narrower than the container clamps both and makes any width comparison pass.
    const widths = await cf.locator('body').evaluate((body) => {
      const measure = (value) => {
        const probe = document.createElement('div');
        probe.style.cssText = `max-width: ${value}`;
        body.appendChild(probe);
        const resolved = getComputedStyle(probe).maxWidth;
        probe.remove();
        return resolved;
      };
      return { token: measure('var(--jp-container)'), wp: measure('var(--wp--style--global--content-size)') };
    });
    assert.match(widths.token, /^\d+(\.\d+)?px$/, `--jp-container did not resolve in the canvas, got: ${widths.token}`);
    assert.equal(widths.wp, widths.token,
      `the canvas content width should BE --jp-container, got: ${widths.wp} against ${widths.token}`);

    // 3c. AND WP-ADMIN IS UNDAMAGED. The reason section 3 uses two mechanisms rather than one:
    // `enqueue_block_assets` reaches the admin page as well as the canvas, so the element defaults
    // — `body { font-family }`, `h1`–`h4`, `p`, `a` — would restyle every screen in wp-admin if
    // they went that way. They go through `block_editor_settings_all` instead, which WordPress
    // scopes to the canvas. This is the assertion that would notice if that ever changed: the
    // previous test could only see the CSS arriving, never what else it landed on.
    const chrome = await admin.evaluate(() => {
      const bar = document.querySelector('#wpadminbar');
      const menu = document.querySelector('#adminmenu');
      return {
        barFont: bar && getComputedStyle(bar).fontFamily,
        barBackground: bar && getComputedStyle(bar).backgroundColor,
        menuFont: menu && getComputedStyle(menu).fontFamily,
        bodyFont: getComputedStyle(document.body).fontFamily,
      };
    });
    assert(chrome.barFont, 'the admin bar should be present to compare against');
    // WordPress's own admin stack, not ours. `--jp-font-sans` resolves to a stack starting with a
    // system font, so this is asserted on the exact string WordPress sets rather than on a
    // family name both stacks could share.
    for (const [where, font] of [['the admin bar', chrome.barFont], ['the admin menu', chrome.menuFont], ["wp-admin's body", chrome.bodyFont]]) {
      assert.match(font, /Helvetica Neue|sans-serif/i, `${where} should keep WordPress's own type, got: ${font}`);
      assert.equal(/var\(--jp-/.test(font), false, `${where} is reading a jamground token`);
    }
    assert.notEqual(chrome.barBackground, 'rgba(0, 0, 0, 0)', 'the admin bar lost its background');

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

    // 12. The rooms behind the doors, asserted through the registries the mu-plugin actually
    // acts on rather than through the editor's chrome — the same reason the format allowlist
    // above is checked against `core/rich-text` and not against the toolbar. A pattern picker
    // that changed its markup would make a UI assertion pass for the wrong reason; an empty
    // registry cannot.
    const closed = await page.evaluate(async () => {
      const client = window.jamgroundClient;
      const root = await client.documentRoot;
      await client.writeFile(root + '/jp-closed-probe.php', `<?php require '${root}/wp-load.php';
        $wp_block = get_post_type_object('wp_block');
        echo json_encode([
          'patterns'           => array_column(WP_Block_Patterns_Registry::get_instance()->get_all_registered(), 'name'),
          'patternCategories'  => count(WP_Block_Pattern_Categories_Registry::get_instance()->get_all_registered()),
          'coreBlockPatterns'  => (bool) current_theme_supports('core-block-patterns'),
          'blockTemplates'     => (bool) current_theme_supports('block-templates'),
          'wpBlockShowUi'      => (bool) $wp_block->show_ui,
          'wpBlockShowInRest'  => (bool) $wp_block->show_in_rest,
        ]);`);
      const out = await client.run({ code: `<?php require '${root}/jp-closed-probe.php';` });
      return JSON.parse(out.text);
    });

    assert.deepEqual(
      closed.patterns, [],
      `no block pattern should be registered — a pattern is a pre-built layout of blocks the contract cannot represent, got: ${closed.patterns.join(', ')}`
    );
    assert.equal(closed.patternCategories, 0, 'an empty pattern registry should leave no categories to browse either');
    assert.equal(closed.coreBlockPatterns, false, 'core-block-patterns theme support should be removed');
    assert.equal(closed.blockTemplates, false, 'block-templates theme support should be removed — it is what offers the site editor and the Template panel');
    assert.equal(closed.wpBlockShowUi, false, 'synced patterns (wp_block) are stored in a database deleted on the next reload, so they must have no UI');
    assert.equal(closed.wpBlockShowInRest, false, 'wp_block must also leave the REST index, which is what feeds the inserter and the admin data layer');

    // 12b. And the routes. Section 5 leaves `edit.php`/`post.php` reachable on purpose; these
    // are the ones nothing in the product has business on, so landing on one should put an
    // editor somewhere they can work rather than on a screen that cannot save.
    for (const closedScreen of ['site-editor.php', 'themes.php']) {
      await page.evaluate(async (screen) => {
        await window.jamgroundClient.goTo('/wp-admin/' + screen);
      }, closedScreen);

      let landed = null;
      const routeDeadline = Date.now() + 60000;
      while (Date.now() < routeDeadline) {
        for (const f of page.frames()) {
          try { if (await f.locator('#adminmenu').count()) { landed = f; break; } } catch {}
        }
        if (landed) break;
        await page.waitForTimeout(250);
      }
      assert(landed, `${closedScreen} should redirect to an ordinary admin screen, which has #adminmenu`);
      assert.equal(
        await landed.locator('#site-editor, .edit-site, .wp-full-overlay, #wpbody-content .theme-browser').count(), 0,
        `${closedScreen} should not render its own screen`
      );
    }

    // 13. Site links name the site. Two cases, and the second is the honest-absence one.
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
