/* jamground/feature-grid — the markup contract (11 §4c): jp-feature-grid[data-columns], __item,
 * __heading, __body. See node.ts for why this directory imports nothing. */
import { el, type Node } from './node.ts';

export interface FeatureGridProps {
  columns: number;
  items: readonly { heading: string; body: string; icon?: string }[];
}

export function featureGrid(props: FeatureGridProps): Node {
  return el('section', { class: 'jp-feature-grid', 'data-columns': props.columns },
    props.items.map((item) => el('div', { class: 'jp-feature-grid__item' }, [
      el('h3', { class: 'jp-feature-grid__heading' }, [item.heading]),
      el('p', { class: 'jp-feature-grid__body' }, [item.body]),
      // `icon` IS DELIBERATELY NOT RENDERED. It is a contract field with no markup contract —
      // there is no design/icons/ directory yet — so it round-trips through the editor and
      // reaches no element here. Adding it is a markup-contract change, not a template tweak.
    ])),
  );
}
