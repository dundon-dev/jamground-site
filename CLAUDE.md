# CLAUDE.md

Jamground is a Jamstack site with no database: content is schema-validated files in a sibling
git repository (`../jamground-content`), edited from `wp-admin` running as WebAssembly in the
browser, built to static HTML with Astro, and deployed by Ansible to one VPS with a
release-directory symlink flip. See `README.md`, `docs/ARCHITECTURE.md`, and `docs/CONTENT.md`
before making structural changes — they're short, and current.

## Two repos

This repository is code, build config, and infra. It is never editor-writable. Content — the
actual pages, posts, authors — lives only in `../jamground-content`. Never add content files
here, and never add build config there.

## The gate

`npm test` must stay green; it runs the config-identity check, the content contract tests, the
conformance tests, and the editor's own test suite. `npm run test:infra` is separate and requires
`ansible-playbook` on `PATH` — kept apart so `npm test` passes on a machine with no Ansible
installed. Run both before committing anything under `src/`, `editor/`, or `infra/`.

`npm run test:browser` is the third chain and the easiest one to forget, because `npm test`'s
editor glob is deliberately non-recursive and never reaches it. It boots WordPress Playground in
a real browser against the live content repository, so it needs network, takes minutes, and
spends `api.github.com` budget. Run it as:

```sh
set -a; . ./.env; set +a          # or it resolves the committed placeholders and 404s
export GITHUB_TOKEN=$(gh auth token)   # 60 requests/hour becomes 5000
npm run test:browser
```

Without the token the unauthenticated limit runs out after two passes and the third fails in
about a second, in ways that look nothing like a test failure and much like broken code. **Anything touching
`editor/entry.mjs`, `editor/lib/`, the mu-plugin, or a WordPress post type is only covered
here.** Two regressions shipped green because it was not run.

## Conventions

- `src/contract/` is normative. Don't hand-edit a schema's derived shape or duplicate a check
  that already lives there.
- `src/lib/canonical.ts` is the only writer of contract YAML, on both the build and editor sides.
  Never hand-format frontmatter.
- No `.php` file may exist outside `editor/` — it's conformance-tested (`test/conformance/no-php.test.mjs`).
- Never commit a secret or an environment-specific value; see `.env.example` and
  `infra/RUNBOOK.md`.
