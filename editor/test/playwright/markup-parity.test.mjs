// THE DRIFT ASSERTION ADR-0013 NAMES: the same block, serialised by both registries, byte for byte.
//
// There are two JavaScript block registries in this system and they are configured in different
// files. The HOST page's is built by entry.mjs against @wordpress/blocks, and is the one
// blocks-to-wp.mjs writes the import tree into and export.mjs reads back. The EDITOR's is built
// inside Playground — core blocks by WordPress, the supports filter by the mu-plugin's section 2,
// the three jamground/* by the bundle section 14 enqueues. Nothing makes them agree except that
// both are written from the same lists, and `ac0a09f` is what it looks like when they stop:
// `className` support on one side and not the other meant the import path wrote
// `<h2 class="wp-block-heading">` and the editor re-saved `<h2>`, so parse() stopped matching
// save(), returned the whole registered schema valued undefined, and every save of a page a person
// had merely opened was refused.
//
// IT IS A BROWSER TEST BECAUSE HALF OF WHAT IT COMPARES ONLY EXISTS IN A BROWSER. The plan this
// came from put it at editor/test/markup-parity.test.mjs, which is in `npm test`'s editor glob —
// where there is no WASM instance, so the WordPress-side registry it names is not there to ask. A
// Node test could only have compared the host registry with a second copy of the configuration,
// which is block-supports.test.mjs's job and is a weaker claim: that the two LISTS agree, not that
// the two REGISTRIES produce the same bytes.
//
// WHAT IT CANNOT SEE, measured rather than reasoned about: a support that adds only a CONTROL.
// Removing `customClassName: false` from the host registry's list — so the two registries
// genuinely disagree — changes no byte here, because `customClassName` offers the "Additional CSS
// class(es)" field and does not alter what an untouched block serialises to. That is the same
// distinction stage B turned on (`className` is markup, `customClassName` is a control), and the
// control half is block-supports.test.mjs's job: it asserts the two LISTS are equal, in Node,
// where it costs nothing. This file asserts the two REGISTRIES produce the same bytes. Neither
// subsumes the other.
//
// It is also distinct from the fidelity gate, and both are wanted:
//
//   fidelity (editor/test/fidelity.test.mjs)  Astro HTML vs the edit component's DOM
//                                             catches a block that LOOKS wrong in the canvas
//   drift    (this file)                      host serialize() vs WASM serialize()
//                                             catches a save that cannot round-trip
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorDir = path.join(__dirname, '../../');
const distDir = path.join(editorDir, 'dist');

async function buildBundle() {
  execSync(`node ${path.join(editorDir, 'build.mjs')}`, { cwd: editorDir, stdio: 'pipe' });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = req.url === '/' || req.url === '/index.html' ? 'index.html' : req.url;
      fs.readFile(path.join(distDir, file)).then(
        (content) => {
          res.writeHead(200, {
            'Content-Type': String(file).endsWith('.js') ? 'application/javascript'
              : String(file).endsWith('.html') ? 'text/html' : 'text/plain',
          });
          res.end(content);
        },
        () => { res.writeHead(404); res.end('Not found'); },
      );
    });
    server.listen(0, 'localhost', () => resolve({ server, port: server.address().port }));
  });
}

/* One fixture per block the contract can hold, with attributes SET rather than left at their
 * defaults — an unset attribute is a value both registries agree about trivially. The three
 * jamground/* fixtures carry every field, including the two with no control, because the round
 * trip is exactly what makes shipping an attribute without a control safe.
 *
 * `core/image` is absent for the same reason it is absent from the inserter: both mappers refuse
 * it, so it is not a block this editor can produce. */
const FIXTURES = [
  ['core/paragraph', { content: 'Text with <strong>a mark</strong> in it' }, []],
  ['core/heading', { level: 3, content: 'A heading' }, []],
  ['core/list', { ordered: true }, [['core/list-item', { content: 'One' }], ['core/list-item', { content: 'Two' }]]],
  ['core/list', {}, [['core/list-item', { content: 'Unordered' }]]],
  ['core/quote', { citation: 'Someone' }, [['core/paragraph', { content: 'Quoted' }]]],
  ['core/code', { content: 'const x = 1 &lt; 2;' }, []],
  ['core/table', {
    head: [{ cells: [{ content: 'H', tag: 'th' }] }],
    body: [{ cells: [{ content: 'B', tag: 'td' }] }],
  }, []],
  ['core/separator', {}, []],
  ['jamground/hero', {
    heading: 'Pricing & plans', body: 'No setup fees.',
    media: { ref: 'media/hero-a1b2c3.jpg', alt: 'A team at work' },
    cta: { label: 'Get started', ref: '01M143VFF8TN0D6FNX3S6M5T49' },
  }, []],
  ['jamground/feature-grid', {
    columns: 4,
    items: [{ heading: 'A', body: 'one', icon: 'bolt' }, { heading: 'B', body: 'two' }],
  }, []],
  ['jamground/cta', {
    heading: 'Start now', body: 'It takes a minute.',
    link: { label: 'Begin', ref: '01M143VHDR61GWZ9Z89PHAPK4X' },
  }, []],
];

/* Serialise one fixture, and re-parse it, in whichever registry `api` is. Returned as data so the
 * two sides are compared in Node, where a failure prints both strings. */
const SERIALISE = `(api, fixtures) => fixtures.map(([name, attrs, inner]) => {
  const block = api.createBlock(name, attrs, inner.map(([n, a]) => api.createBlock(n, a)));
  const markup = api.serialize([block]);
  const reparsed = api.parse(markup);
  return {
    name,
    markup,
    // The round trip inside ONE registry, which is the property ac0a09f's defect broke. A block
    // whose serialize() does not survive its own parse() is one the editor cannot save.
    reserialised: api.serialize(reparsed),
    isValid: reparsed.every((b) => b.isValid !== false),
  };
})`;

test('markup parity: the host registry and the editor\'s registry serialise every block identically', async () => {
  await buildBundle();
  const { server, port } = await startServer();
  let browser, context, page;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });

    await page.waitForFunction(
      () => window.jamgroundReady === true || typeof window.jamgroundBootError !== 'undefined',
      { timeout: 240000 },
    );
    const bootError = await page.evaluate(() => window.jamgroundBootError);
    assert(!bootError, `No boot error should occur: ${bootError}`);

    // THE HOST REGISTRY, through the same `window.wpBlocksAPI` the shell exposes and the write
    // path uses — not a second registry stood up for the test.
    const host = await page.evaluate(
      ([serialise, fixtures]) => new Function('return ' + serialise)()(window.wpBlocksAPI, fixtures),
      [SERIALISE, FIXTURES],
    );

    // A post, and its edit screen, so the editor's registry is fully built: the mu-plugin's
    // section 2 filter and section 14's bundle both run on `enqueue_block_editor_assets`.
    const postId = await page.evaluate(async () => {
      const client = window.jamgroundClient;
      const root = await client.documentRoot;
      await client.writeFile(root + '/jp-parity-seed.php', `<?php require '${root}/wp-load.php';
        echo 'POST:' . wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Parity probe']);`);
      const out = await client.run({ code: `<?php require '${root}/jp-parity-seed.php';` });
      return (out.text.match(/POST:(\d+)/) || [])[1];
    });
    assert(postId, 'seed post should have been created');

    await page.evaluate(async (id) => {
      await window.jamgroundClient.goTo('/wp-admin/post.php?post=' + id + '&action=edit');
    }, postId);

    let admin = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      for (const f of page.frames()) {
        try {
          if (await f.locator('#editor, .interface-interface-skeleton, .editor-header').count()) { admin = f; break; }
        } catch {}
      }
      if (admin) break;
      await page.waitForTimeout(250);
    }
    assert(admin, 'the wp-admin frame should be reachable');

    // The bundle must have registered before the custom fixtures mean anything — otherwise
    // createBlock falls back to core/missing and the comparison below is between two unrelated
    // failures rather than between two registries.
    const bundle = await admin.evaluate(() => window.__jamgroundBlocks || null);
    assert(bundle && !bundle.error, `the block bundle must have registered: ${bundle && bundle.error}`);

    const editor = await admin.evaluate(
      ([serialise, fixtures]) => new Function('return ' + serialise)()(window.wp.blocks, fixtures),
      [SERIALISE, FIXTURES],
    );

    // Against a false green: two empty lists are equal. This is the assertion that would notice
    // if the evaluate above ever started returning nothing.
    assert.equal(host.length, FIXTURES.length);
    assert.equal(editor.length, FIXTURES.length);

    for (let i = 0; i < FIXTURES.length; i++) {
      const [name] = FIXTURES[i];
      assert.equal(host[i].name, name);

      assert.equal(
        editor[i].markup, host[i].markup,
        `${name} serialises differently in the two registries.\n` +
        `  host   : ${JSON.stringify(host[i].markup)}\n` +
        `  editor : ${JSON.stringify(editor[i].markup)}\n` +
        'This is the ac0a09f class: the import path writes one thing and the editor saves another.',
      );

      // And each side round-trips its own markup. Byte equality between two registries that both
      // produce markup they cannot re-parse would be agreement about something broken.
      for (const [where, side] of [['host', host[i]], ['editor', editor[i]]]) {
        assert.equal(side.reserialised, side.markup, `${name}: serialize(parse(m)) !== m in the ${where} registry`);
        assert.equal(side.isValid, true, `${name}: re-parsed invalid in the ${where} registry`);
      }
    }

    // The markup contract 11 §4c freezes, asserted on the bytes both registries agreed on — so a
    // WordPress upgrade that changed core's save() output would fail here rather than pass as
    // "both registries changed together".
    const byName = Object.fromEntries(host.map((r) => [r.name, r.markup]));
    assert.match(byName['core/heading'], /<h3 class="wp-block-heading">/);
    assert.match(byName['core/list'], /<ul class="wp-block-list">|<ol class="wp-block-list">/);
    assert.match(byName['core/separator'], /class="wp-block-separator has-alpha-channel-opacity"/);
    assert.match(byName['core/table'], /<figure class="wp-block-table">/);
    // The custom blocks are dynamic: a self-closing delimiter carrying attributes and no HTML.
    for (const name of ['jamground/hero', 'jamground/feature-grid', 'jamground/cta']) {
      const markup = byName[name];
      assert.ok(
        markup.startsWith(`<!-- wp:${name} {`) && markup.endsWith('} /-->') && !markup.includes('\n'),
        `${name} must serialise as a single self-closing delimiter (11 §4b), got: ${markup}`,
      );
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
