// jsdom shim — @wordpress/block-library transitively loads @wordpress/block-editor,
// which touches `window` at module scope. A DOM is not WordPress; the adapter has a real
// one in the browser. CJS, required before the @wordpress
// packages so `window` exists at their module-load time.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.navigator = dom.window.navigator; global.self = dom.window;
global.HTMLElement = dom.window.HTMLElement; global.Element = dom.window.Element;
global.Node = dom.window.Node; global.getComputedStyle = dom.window.getComputedStyle;
global.MutationObserver = dom.window.MutationObserver || class { observe(){} disconnect(){} };
global.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
global.requestIdleCallback = (cb) => setTimeout(() => cb({ timeRemaining: () => 50 }), 0);
global.cancelIdleCallback = (id) => clearTimeout(id);
global.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
