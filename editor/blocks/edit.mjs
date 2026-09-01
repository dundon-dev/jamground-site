// The `edit` components — the second renderer of the markup contract, and the reason the design
// system reaching the canvas (stage D) will do anything at all.
//
// EACH ONE RENDERS THE MARKUP MODULE AND NOTHING ELSE. `toElement(hero(attributes))` is the whole
// canvas output; there is no JSX here describing a hero a second time. That is what ADR-0013 means
// by agreement holding by construction, and it is what lets editor/test/fidelity.test.mjs assert
// `normalise(astro_html) == normalise(editor_dom)` over the module rather than over a component it
// would have to boot a block editor to render.
//
// SO THE TEXT IS EDITED IN THE SIDEBAR, NOT IN THE CANVAS, and that is a deliberate trade rather
// than an unfinished one. `RichText` would put the editing where an editor expects it, and would
// also put `<span data-rich-text-…>` wrappers and a `contenteditable` subtree inside the markup
// the fidelity gate compares — so the gate would have to be widened until it could no longer see
// a real difference, which is the failure mode 09 §6 spends a paragraph on. A sidebar field
// leaves the canvas showing exactly what the site will render.
//
// THE `wp` GLOBALS ARE A PARAMETER. Nothing here imports a WordPress package: the bundle reads
// `wp.element`, `wp.blockEditor` and `wp.components` off the global that WordPress itself printed,
// so a second React never enters the page and the bundle stays small enough to inline. Same
// discipline blocks-to-wp.mjs and attribute-guard.mjs use for the block API.
import { hero } from '../../design/markup/hero.ts';
import { featureGrid } from '../../design/markup/feature-grid.ts';
import { cta } from '../../design/markup/cta.ts';
import { toElement } from '../../design/markup/to-element.ts';

/** Contract attributes -> the markup module's props, per block.
 *
 *  The only translation that is not an identity is `Link`. The contract's is `{ label, ref }`
 *  where `ref` is a translation-group id; the markup module's is `{ label, href? }`. The editor
 *  has no resolver — an href exists only after src/lib/links.ts runs at build time — so the label
 *  travels and the href does not, which 09 §7 names explicitly as outside what the editor claims
 *  to show. Inventing `#` or rendering the raw ULID would be a target that goes somewhere wrong;
 *  the anchor is styled by its class, so it still looks right with none.
 */
const MARKUP = {
  hero: (a) => hero({
    heading: a.heading ?? '',
    body: a.body,
    // `src` is the RAW reference here. Astro hands the module a URL resolved against
    // content/media/; there is no such directory inside Playground and no resolver to consult,
    // so what the canvas shows is the contract's own path — which is what it showed before the
    // module drew the distinction. Same shape as `cta` one line down, where the label travels
    // and the href does not (09 §7).
    media: a.media ? { src: a.media.ref, alt: a.media.alt, decorative: a.media.decorative } : undefined,
    cta: a.cta ? { label: a.cta.label ?? '' } : undefined,
  }),
  featureGrid: (a) => featureGrid({
    columns: a.columns,
    items: Array.isArray(a.items) ? a.items : [],
  }),
  cta: (a) => cta({
    heading: a.heading ?? '',
    body: a.body,
    link: { label: a.link?.label ?? '' },
  }),
};

/** The controls, per block. Every one of them writes a contract field directly; there is no
 *  editor-only state to keep in step.
 *
 *  A FIELD WITH NO CONTROL IS NOT A FIELD THAT IS LOST. `hero.media`, `hero.cta` and
 *  `featureGrid.items[].icon` are registered attributes with no control here, so content
 *  carrying them imports, renders in this canvas, and exports unchanged. Shipping the attribute
 *  without the control is what makes the round trip lossless while the control is still missing;
 *  shipping the control without something for it to choose from would be the misleading surface
 *  stage A removed. `content/media/` is empty and there is no entity picker yet. */
function controlsFor(type, wp, { attributes, setAttributes }) {
  const el = wp.element.createElement;
  const { PanelBody, TextControl, TextareaControl, SelectControl, Button, Notice } = wp.components;

  // __nextHasNoMarginBottom / __next40pxDefaultSize: opting in to the styles these controls will
  // have by default in a later WordPress. Without them every render logs a deprecation warning
  // into the console the browser suite reads.
  const text = (label, value, onChange, help) => el(TextControl, {
    label, value: value ?? '', onChange, help,
    __nextHasNoMarginBottom: true, __next40pxDefaultSize: true,
  });
  const area = (label, value, onChange, help) => el(TextareaControl, {
    label, value: value ?? '', onChange, help, __nextHasNoMarginBottom: true,
  });

  if (type === 'hero') {
    return el(PanelBody, { title: 'Hero', initialOpen: true },
      text('Heading', attributes.heading, (heading) => setAttributes({ heading })),
      area('Body', attributes.body, (body) => setAttributes({ body: body || undefined })),
    );
  }

  if (type === 'cta') {
    return el(PanelBody, { title: 'Call to action', initialOpen: true },
      text('Heading', attributes.heading, (heading) => setAttributes({ heading })),
      area('Body', attributes.body, (body) => setAttributes({ body: body || undefined })),
      text('Link text', attributes.link?.label,
        (label) => setAttributes({ link: { ...(attributes.link ?? {}), label } }),
        'The page this links to is chosen elsewhere — there is no picker for it yet.'),
    );
  }

  const items = Array.isArray(attributes.items) ? attributes.items : [];
  const setItem = (index, patch) => setAttributes({
    items: items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
  });

  return el(PanelBody, { title: 'Feature grid', initialOpen: true },
    el(SelectControl, {
      label: 'Columns',
      value: String(attributes.columns),
      options: [2, 3, 4].map((n) => ({ label: String(n), value: String(n) })),
      // The contract's `columns` is `2 | 3 | 4` as NUMBERS; a SelectControl's value is a string,
      // and handing the union a "3" is a validation failure at save with a confusing message.
      onChange: (value) => setAttributes({ columns: Number(value) }),
      __nextHasNoMarginBottom: true, __next40pxDefaultSize: true,
    }),
    // Said before a save can fail on it, rather than after. The contract's `.min(2)` is the
    // authority; this is the same fact reaching the editor while there is still something to do
    // about it.
    items.length < 2 ? el(Notice, { status: 'warning', isDismissible: false },
      'A feature grid needs at least two features before it can be saved.') : null,
    ...items.map((item, index) => el(PanelBody, {
      key: index, title: item.heading || `Feature ${index + 1}`, initialOpen: false,
    },
      text('Heading', item.heading, (heading) => setItem(index, { heading })),
      area('Body', item.body, (body) => setItem(index, { body })),
      el(Button, {
        variant: 'secondary', isDestructive: true, size: 'small',
        onClick: () => setAttributes({ items: items.filter((_, i) => i !== index) }),
      }, 'Remove feature'),
    )),
    el(Button, {
      variant: 'primary',
      // Twelve is the contract's `.max(12)`, said here for the same reason the minimum is.
      disabled: items.length >= 12,
      onClick: () => setAttributes({ items: [...items, { heading: '', body: '' }] }),
    }, items.length >= 12 ? 'Twelve features is the maximum' : 'Add feature'),
  );
}

/**
 * Build the `editFor` that definitions.mjs's `registerCustomBlocks` takes.
 *
 * `useBlockProps` is applied to the markup module's ROOT element with cloneElement rather than to
 * a wrapper around it. A wrapper would be an element the markup contract does not contain, sitting
 * between the canvas and the block's own CSS — apiVersion 3 requires the props reach the outermost
 * rendered element, and the outermost element here belongs to the contract.
 */
export function makeEditFor(wp) {
  const { createElement, cloneElement } = wp.element;
  const { useBlockProps, InspectorControls } = wp.blockEditor;

  return function editFor(type) {
    return function Edit({ attributes, setAttributes }) {
      const tree = toElement(MARKUP[type](attributes), createElement);
      // Our own class is handed to useBlockProps rather than left on the element, so WordPress
      // merges its editor classes with it instead of replacing it.
      const blockProps = useBlockProps({ className: tree.props.className });
      return createElement(
        wp.element.Fragment,
        null,
        createElement(InspectorControls, null, controlsFor(type, wp, { attributes, setAttributes })),
        cloneElement(tree, blockProps),
      );
    };
  };
}
