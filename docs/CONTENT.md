# The content contract

`src/contract/` (`envelope.ts`, `entities.ts`, `blocks.ts`, `defs.ts`) is normative. This
document describes it; if the two ever disagree, the code is right and this file is stale.

## Five entity kinds

Four are per-locale files under `content/<kind>/<locale>/<file>`, each carrying the envelope below:

- **page** — the envelope plus `blocks: Block[]` (at least one). The only kind with a body made
  of blocks rather than Markdown.
- **post** — the envelope plus `author` (required — a ref to an author's translation group),
  optional `excerpt`, `tags`, `related`, and a Markdown body after the frontmatter fence.
- **author** — the envelope plus `name` (required), optional `role`, `bio`, `avatar`.
- **navigation** — the envelope plus `items` (1–12 `NavigationItem`s). Each item carries a
  `label` and *exactly one* of `ref` (internal) or `href` (external); an item may nest one
  further level of children (also exactly-one-of), capped there by having no third field to
  nest into, not by a number.

**settings** is different: locale-neutral, one file (`content/settings/site.yaml`), no envelope
— `defaultLocale`, `locales`, `siteName`, `baseUrl`, optional `social`. A sibling,
`content/settings/redirects.yaml`, is optional and holds vanity/legacy path redirects; absent
means none.

## The envelope, in the order of record

```
id, translationOf, locale, slug, slugHistory?, title, status, publishedAt?, updatedAt, seo?, sourceHash?
```

This is the literal declaration order in `envelope.ts`, and it is the order every file is
serialised in — not a convention kept in sync with the schema by hand, but a direct consequence
of it: the canonical writer (`src/lib/canonical.ts`) derives key order from
`Object.keys(schema.shape)` at every depth, so there is no second list that could drift from the
schema.

| Field | Meaning |
|---|---|
| `id` | Immutable ULID. Never a URL, never the filename, and never what a link targets — see below. |
| `translationOf` | The translation-group id. See below. |
| `locale` | `xx-XX`; must match the containing directory. |
| `slug` | Mutable, URL-facing, unique per (collection, locale). |
| `slugHistory` | Every previous `slug`, oldest first; optional, drives 301s. |
| `title` | Required, non-empty. |
| `status` | `draft` or `published`, per locale — one locale's translation can publish while another is still a draft. |
| `publishedAt` | **Optional in the schema, but required when `status: published`.** A `superRefine` on the envelope enforces this directly (not a plain `.optional()`): omitting it is legal only on a draft, where — once present — it reads as a scheduled publish date rather than a historical one. |
| `updatedAt` | Required, always. |
| `seo` | Optional: `title` (≤70), `description` (≤160), `ogImage`, `noindex`. |
| `sourceHash` | Set on a translation when it is created; compared against the source to detect drift. |

## Identity, the translation group, and the URL

Three different things answer "which one is this," and they are not interchangeable:

- **`id`** is the immutable primary key of one locale's version of one entity — never a link
  target, never a URL.
- **`slug`** is the mutable, human-facing part of the URL; `slugHistory` remembers where it used
  to be.
- **`translationOf`** is the id of the *translation group* — the thing that is the same piece of
  content across every locale it has been written in. **This, not `id`, is what every `ref:`
  field and every `author:` field targets.** A link has to resolve to whichever locale is
  rendering it, and only the group — not any one locale's `id` — is addressable independent of
  locale. `src/lib/links.ts` builds its index keyed on `(translationOf, locale)` for exactly this
  reason, and resolves a reference by looking up that pair in the referring entity's own locale.

## Blocks

`blocks.ts` defines eleven types as one discriminated union, all `.strict()` (an unknown key is
a defect, not noise to ignore). Eight mirror a Gutenberg core block one for one — `paragraph`,
`heading` (levels 2–4), `list` (three explicit levels, each with its own `ordered`), `image`,
`quote`, `code`, `table`, `separator` — and round-trip against that block's own markup. Three are
custom `jamground/*` types with no core equivalent — `hero`, `featureGrid`, `cta` — and are
"dynamic": they save no markup of their own in the editor, so the matching Astro component
(`src/components/blocks/`) is their only renderer. `Page` is the one entity with a `blocks`
field; every other kind's body, where it has one, is Markdown.

## The canonical byte form

One writer, `src/lib/canonical.ts`, produces every file this contract writes, whether from the
Astro side or from the editor's export path, so there is one definition of "the same content"
rather than two formatters that might disagree:

- Unicode normalised to **NFC**, UTF-8 encoded.
- **LF** line endings only, **no BOM**, **exactly one trailing newline**.
- Key order derived from the schema's own declared shape at every depth (never a hand-written
  list, never input order) — which is what makes the envelope order above the order of record
  rather than a convention.
- Defensive YAML quoting on **keys as well as values**: any scalar a YAML 1.1 reader (PyYAML,
  libyaml, Psych, and others still in the wild) would parse as a boolean, null, int, float, or
  date is quoted, even though this contract's own YAML 1.2 writer would not quote it by default,
  and even when that scalar is a mapping key (an unquoted `off:` reads as `false:` under 1.1).

## Errors that are build failures, not warnings

Three names are cited directly in thrown error messages — `src/lib/links.ts`, and the render-time
guards in `src/components/blocks/Hero.astro` and `Cta.astro` — because
`test/contract/links.test.mjs` asserts on that exact text. They are defined here because nothing
else in this repository defines them any more.

**INV-11 — an unresolvable `ref:` is a build failure, never a fallback href.** Every path through
`hrefFor()` in `src/lib/links.ts` that cannot produce a real href throws a `LinkResolutionError`
tagged `INV-11` instead of returning one: a `ref:` naming a translation group no entity declares,
one with no member in the referring entity's own locale, or a resolved link that reached a
renderer without going through resolution at all (the guards in `Hero.astro`/`Cta.astro`). There
is no code path that emits a bare group id, an empty string, or a link to the wrong locale as a
fallback — the failure is loud and at build time, every time.

**INV-12 — a translation group may not have two members in one locale.** Enforced while building
the link index (`buildLinkIndex()`): the moment a second entity claims a `(translationOf,
locale)` pair already in the index, it throws, naming both entities. The alternative —
last-write-wins — would make the resolved href depend on directory iteration order, which is not
a decision this contract leaves to chance.

**OD-28 — a published entity may not link to a draft, in preview or in production; draft →
draft is allowed.** This is the specific drafts policy that `hrefFor()` enforces on top of
INV-11's general rule: when a build excludes drafts entirely, a link to a draft target has no
route to resolve to, full stop. When a build includes drafts (preview), a target that is a draft
now *does* have a route — but a **published** referrer linking to it still throws, so that a link
broken in production can never look fine in preview. A **draft** referrer linking to a draft
target is allowed: draft-to-draft is exactly what a preview build exists to support — a set of
pages being drafted together before anything about them is final.
