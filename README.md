# Jamground

Jamground is a Jamstack site with no database and no server-side application. Content lives as
schema-validated files in a separate git repository. Editors write it from `wp-admin` running
entirely in the browser, over WebAssembly — there is no PHP anywhere on any server. The site
itself builds to static HTML with Astro. Deploys run from an operator's machine over Ansible,
onto one VPS, and go live with a symlink flip.

See `docs/ARCHITECTURE.md` for why it's built this way, and `docs/CONTENT.md` for the content
contract itself.

## The two-repo model

This repository (`jamground-site`) is the build: Astro pages and components, the content
contract both the build and the editor import, the in-browser editor shell, and the Ansible
that deploys all of it. It is never editor-writable.

A second repository, `jamground-content`, holds only content — YAML frontmatter and Markdown
bodies, validated against the contract in `src/contract/`. The in-browser editor writes to it
directly through the GitHub API, as pull requests. Nothing in it can change how the site is
built or deployed. Two repos, on purpose: editor-writable bytes never sit beside build
configuration.

## Quickstart

```sh
npm ci
JAMGROUND_CONTENT_DIR=../jamground-content npm run dev     # local dev server
npm run build                                               # static build -> dist/
npm test                                                     # the gate — see CLAUDE.md
```

`JAMGROUND_CONTENT_DIR` names the content repository's root; unset, it defaults to the sibling
directory `../jamground-content`, so a normal side-by-side checkout of both repositories needs
no configuration at all. Node version is pinned in `.nvmrc`.

Every tracked file here is generic — `example.com`, `your-org`, an unroutable address. To build
or deploy under your own name, copy `.env.example` to `.env` (gitignored), fill it in, and
`set -a; . ./.env; set +a` before building or converging. Nothing loads it for you and nothing
in git ever holds a real value; `npm test` fails if one appears. See `infra/RUNBOOK.md`.

## Repo map

| Path | What's there |
|---|---|
| `src/contract/` | The schema — envelope, entities, blocks, shared definitions. Normative. |
| `src/pages/`, `src/components/`, `src/layouts/`, `src/lib/` | The Astro site: routes, block renderers, link resolution, the canonical YAML writer. |
| `editor/` | The in-browser editor: boots WordPress Playground (WASM) in the browser, round-trips content through it, writes back to `jamground-content` via GitHub's API. |
| `infra/` | Ansible roles and playbooks, the auth broker, the webhook receiver, deploy scripts. |
| `test/` | Contract, gate, and conformance tests for `src/` and `tools/`. |
| `tools/` | The gates: `check-config.mjs`, `check-playbooks.mjs`, `check-seed-canonical.mjs`. |
| `design/` | Design tokens and per-block CSS, imported by the Astro layouts. |
| `public/` | Static files passed through to the build root unchanged. |

## About the harness

This project was previously developed against a large specification, a set of architecture
decision records, release ledgers, and a decision register. All of that has been extracted to
`../jamground-harness`. Neither it nor the specification it carries is needed to build, run, or
test this tree — everything required lives in this repository.
