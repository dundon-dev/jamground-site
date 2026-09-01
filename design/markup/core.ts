/* THE OBSERVED HALF OF THE MARKUP CONTRACT — the eight core-derived block types, frozen.
 *
 * Every other file in this directory AUTHORS markup: one function per custom block, returning a
 * node description two renderers turn into HTML and into React. This one authors nothing. Core
 * blocks' markup is WordPress's own `save()` output, and our side of it is a REPRODUCTION —
 * `src/components/blocks/` emits by hand what `@wordpress/block-library` emits from its save.js.
 * There is no shared function that could make those agree by construction, because one of the two
 * renderers is not ours. So the contract for these eight is a RECORD rather than a definition, and
 * this is it: one row per case, holding the exact bytes Astro must produce.
 *
 * WHY IT IS A MODULE AND NOT A TEST'S LOCAL CONSTANT, which is where it lived until now. Two
 * tests, in two package trees, have to hold two different renderers to the same record, and a
 * record written twice is not one:
 *
 *   test/blocks/core.test.mjs        the real .astro files == `markup`, byte for byte
 *   editor/test/core-markup.test.mjs WordPress's own serialize() == `markup`, once parsed
 *
 * Transitively, Astro == WordPress — which is `10 §R5`'s "the fidelity gate passes for … all 8
 * core blocks", and the same transitive shape the custom blocks already use (custom.test.mjs holds
 * Astro to design/markup/, fidelity.test.mjs holds React to it). Before this file existed only the
 * first link was asserted: the frozen strings were written into core.test.mjs by hand, read off
 * core's save.js at authoring time, and nothing ever asked WordPress whether they were still true.
 * A WordPress upgrade that changed a core block's markup would have passed every gate in the
 * repository and split the site from the editor in silence — which is precisely the case `10 §R5`'s
 * own Notes say this gate exists to detect.
 *
 * THE TWO SIDES ARE NOT COMPARED THE SAME WAY, and cannot be. Astro is held to the bytes because
 * the bytes are what ships. WordPress is held to the parsed tree, because React self-closes void
 * elements and writes `alt=""` where Astro writes a bare `alt` — differences that vanish on parse
 * and are not drift (the same argument, and the same normaliser, as editor/test/fidelity.test.mjs).
 *
 * `wp` IS PRESENT ON EXACTLY THE ROWS editor/lib/blocks-to-wp.mjs REFUSES, which today is `image`
 * and only `image`: it needs a media upload path that does not exist (R10), so it has no arm in the
 * mapper and the editor-side test builds it from these attributes instead. Every other row goes
 * through the real mapper, so that path is exercised rather than bypassed.
 *
 * Zero imports, like every file here — see node.ts for why that rule covers the whole directory. */

export interface CoreCase {
  /** The case's name. Becomes the test name in both packages, so it reads as one suite. */
  name: string;
  /** The Astro component that renders this contract type. */
  component: string;
  /** The contract block. Drives the editor half through the real mapper, and is what the
   *  coverage assertions count types from. */
  block: { type: string; [field: string]: unknown };
  /** What the Astro component takes, where that is no longer the contract block minus `type`.
   *  Present on the `image` rows and nowhere else: `MediaRef.ref` is a path rooted at the content
   *  repository and a component is handed the RESOLVED `src` instead (src/lib/media.ts), so the
   *  contract shape and the prop shape have come apart for exactly the field that resolves.
   *  Absent means the two are still the same thing. */
  props?: Record<string, unknown>;
  /** Only where blocks-to-wp.mjs has no arm for the type. See the header. */
  wp?: { name: string; attributes: Record<string, unknown> };
  /** Astro's exact bytes, with whitespace between tags collapsed — that whitespace is Astro's
   *  formatting of the template, not part of the contract. */
  markup: string;
}

export const CORE_CASES: readonly CoreCase[] = [
  {
    name: 'paragraph — a bare <p>, no class',
    component: 'Paragraph.astro',
    block: { type: 'paragraph', text: 'Some copy.' },
    markup: '<p>Some copy.</p>',
  },

  // All three permitted levels, because the class is on the wrapper and a level that lost it
  // would be invisible in any single-level fixture.
  ...[2, 3, 4].map((level) => ({
    name: `heading — level ${level} gets wp-block-heading`,
    component: 'Heading.astro',
    block: { type: 'heading', level, text: 'A heading' },
    markup: `<h${level} class="wp-block-heading">A heading</h${level}>`,
  })),

  {
    name: 'separator — the hr and both default classes, unconditionally',
    component: 'Separator.astro',
    block: { type: 'separator' },
    markup: '<hr class="wp-block-separator has-alpha-channel-opacity">',
  },
  {
    name: 'code — pre/code wrapper, no language attribute anywhere',
    component: 'Code.astro',
    block: { type: 'code', text: 'const x = 1;' },
    markup: '<pre class="wp-block-code"><code>const x = 1;</code></pre>',
  },
  {
    name: 'code — empty text is a meaningful empty block, not an error',
    component: 'Code.astro',
    block: { type: 'code', text: '' },
    markup: '<pre class="wp-block-code"><code></code></pre>',
  },
  {
    name: 'quote — text becomes an unclassed inner <p>, citation an unclassed <cite>',
    component: 'Quote.astro',
    block: { type: 'quote', text: 'Quoted.', citation: 'Someone' },
    markup: '<blockquote class="wp-block-quote"><p>Quoted.</p><cite>Someone</cite></blockquote>',
  },
  {
    name: 'quote — citation is optional and omitted entirely when absent',
    component: 'Quote.astro',
    block: { type: 'quote', text: 'Quoted.' },
    markup: '<blockquote class="wp-block-quote"><p>Quoted.</p></blockquote>',
  },

  // The two `image` rows carry `wp` for the reason the header gives. `url` rather than `ref`, and
  // a literal empty `alt` for the decorative case, because those are WordPress's attribute names
  // and WordPress's way of saying it — the contract's `MediaRef` declares `decorative: true`
  // instead, and OD-22 is emphatic that the two are not the same statement.
  //
  // They carry `props` for a different reason: Image.astro takes a resolved `src`, not a `ref`.
  // The value below is left UNRESOLVED on purpose — this record is about markup SHAPE, and an
  // `src` is a string to it. Whether `media/a.jpg` becomes `/media/a.jpg`, and whether it fails
  // the build when the original is not committed, is test/media.test.mjs's question; asserting it
  // here as well would tie the frozen markup to a content root it has no business knowing about.
  {
    name: 'image — figure/img pair and a captioned figcaption',
    component: 'Image.astro',
    block: { type: 'image', media: { ref: 'media/a.jpg', alt: 'Alt text' }, caption: 'A caption' },
    props: { media: { src: 'media/a.jpg', alt: 'Alt text' }, caption: 'A caption' },
    wp: { name: 'core/image', attributes: { url: 'media/a.jpg', alt: 'Alt text', caption: 'A caption' } },
    markup: '<figure class="wp-block-image">'
      + '<img src="media/a.jpg" alt="Alt text">'
      + '<figcaption class="wp-element-caption">A caption</figcaption>'
      + '</figure>',
  },
  {
    name: 'image — decorative media gets an empty alt and no caption element',
    component: 'Image.astro',
    block: { type: 'image', media: { ref: 'media/b.jpg', decorative: true } },
    props: { media: { src: 'media/b.jpg', decorative: true } },
    wp: { name: 'core/image', attributes: { url: 'media/b.jpg', alt: '' } },
    markup: '<figure class="wp-block-image"><img src="media/b.jpg" alt></figure>',
  },

  {
    name: 'table — has-fixed-layout, a thead of th and a tbody of td, no merged cells',
    component: 'Table.astro',
    block: { type: 'table', head: ['Plan', 'Price'], rows: [['Starter', '$0'], ['Pro', '$9']] },
    markup: '<figure class="wp-block-table"><table class="has-fixed-layout">'
      + '<thead><tr><th>Plan</th><th>Price</th></tr></thead>'
      + '<tbody>'
      + '<tr><td>Starter</td><td>$0</td></tr>'
      + '<tr><td>Pro</td><td>$9</td></tr>'
      + '</tbody></table></figure>',
  },

  // `ordered: false` written out here, and absent from the nested levels below, on purpose: both
  // forms reach the same `<ul>`, and the contract permits both (e6d3d81 stopped the canonical
  // writer emitting the false). Which form round-trips is editor/test/roundtrip.test.mjs's
  // question; that both RENDER the same is this one's.
  {
    name: 'list — a flat unordered list, one <li> per item',
    component: 'List.astro',
    block: { type: 'list', ordered: false, items: [{ text: 'One' }, { text: 'Two' }] },
    markup: '<ul class="wp-block-list"><li>One</li><li>Two</li></ul>',
  },
  {
    name: 'list — ordered renders <ol>, each own level keeps its own ordered flag',
    component: 'List.astro',
    block: {
      type: 'list', ordered: true,
      items: [{ text: 'One', list: { ordered: false, items: [{ text: 'a' }] } }],
    },
    markup: '<ol class="wp-block-list">'
      + '<li>One<ul class="wp-block-list"><li>a</li></ul></li>'
      + '</ol>',
  },
  {
    name: 'list — nests to the full three levels the contract permits, list inside its own <li>',
    component: 'List.astro',
    block: {
      type: 'list', ordered: false,
      items: [{
        text: 'Level one',
        list: {
          ordered: true,
          items: [{ text: 'Level two', list: { items: [{ text: 'Level three' }] } }],
        },
      }],
    },
    markup: '<ul class="wp-block-list"><li>Level one'
      + '<ol class="wp-block-list"><li>Level two'
      + '<ul class="wp-block-list"><li>Level three</li></ul>'
      + '</li></ol>'
      + '</li></ul>',
  },
];

/** The eight contract types these cases must between them cover. Written out rather than derived
 *  from the rows above, so that deleting a row is a failure rather than a smaller suite. */
export const CORE_TYPES: readonly string[] = [
  'paragraph', 'heading', 'list', 'image', 'quote', 'code', 'table', 'separator',
];
