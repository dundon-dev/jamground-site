/* Internal-link extraction and classification, for the assertion that every href the build
 * emits points at a route the build actually generated.
 *
 * Why this exists: route-set-equality proves dist/ contains exactly the routes content/
 * entails, but says nothing about whether any anchor points AT one — a page could pass that
 * check while still linking to a bare, unresolved id that 404s in a browser. That gap is
 * this file.
 *
 * A regex rather than an HTML parser, deliberately. Every byte of dist/**.html is emitted by
 * our own Astro templates: raw HTML in content is banned, PostBody throws on encountering
 * it, and inline markdown renders as literal text so prose emits no anchor at all. The
 * repo has zero devDependencies and exact production pins; pulling in parse5 would touch the
 * lockfile and add a name to dependency-closure's walk to buy robustness against markup
 * shapes that cannot occur. If content ever can carry authored HTML, revisit this choice
 * rather than patching the regex. */

const ANCHOR = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Every href value in `html`, in document order, HTML-entity-decoded. */
export function extractHrefs(html) {
  const out = [];
  for (const match of html.matchAll(ANCHOR)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    out.push(decodeEntities(raw));
  }
  return out;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // last: an encoded ampersand must not re-trigger the others
}

/** `{ kind }` where kind is 'external' | 'fragment' | 'internal' | 'violation'.
 *  A violation carries `why`. Only 'internal' goes on to routeFileFor. */
export function classifyHref(raw) {
  const href = raw.trim();

  if (href === '') return { kind: 'violation', why: 'empty href' };
  if (href.startsWith('#')) return { kind: 'fragment' };

  // ExternalUrl (defs.ts) permits https:, mailto: and tel: — and bans plaintext http:
  // by name, so an http: link is a violation rather than something to wave through.
  if (/^https:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
    return { kind: 'external' };
  }
  if (/^http:/i.test(href)) {
    return { kind: 'violation', why: 'plaintext http: is banned by ExternalUrl (11 §1)' };
  }
  if (href.startsWith('//')) return { kind: 'external' }; // protocol-relative

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return { kind: 'violation', why: `unrecognised URL scheme in "${href}"` };
  }

  // The defect this file guards against has exactly this shape: a relative reference, so
  // the browser resolves it against the current directory and lands somewhere that was
  // never generated.
  if (!href.startsWith('/')) {
    return { kind: 'violation', why: `"${href}" is not a root-relative path` };
  }

  return { kind: 'internal' };
}

/** A root-relative URL path -> the dist-relative file that must exist to serve it, in the
 *  same form deriveExpectedRoutes() emits. Returns `{ file }`, `{ allowed }` for the one
 *  documented non-file route, or `{ why }` for a violation. */
export function routeFileFor(path) {
  const clean = path.replace(/[?#].*$/, '');

  // `/` is served by nginx's own redirect to the default locale — one hand-written line at
  // infra/ansible/roles/nginx/templates/nginx.conf.j2:41. It is a legitimate
  // link target that corresponds to no file in dist/.
  if (clean === '/') return { allowed: true };

  if (clean.endsWith('/')) return { file: `${clean.slice(1)}index.html` };
  if (clean.endsWith('.html')) return { file: clean.slice(1) };

  // Under trailingSlash: 'always' with build.format: 'directory', an extensionless path with
  // no trailing slash is what a static host answers 404 to. Astro emits no such route.
  return { why: `"${clean}" has no trailing slash (trailingSlash: 'always')` };
}
