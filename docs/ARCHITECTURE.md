# Architecture

Jamground has three moving parts: content as files in git, an editor that runs entirely in the
browser, and a static build that deploys by flipping a symlink. Each exists for a specific
reason, below.

## Content as files in git, in a second repository

There is no database. An entity — a page, a post, an author, a navigation tree, or the site's
settings — is a YAML-frontmatted file (Markdown body, for posts) that validates against the
schema in `src/contract/`. That schema is imported, by relative path, by both the Astro build
and the browser editor bundle; neither re-derives it, so there is exactly one definition of what
a valid entity looks like.

Content lives in a repository of its own (`jamground-content`), separate from this one. The
reason is blast radius, not convenience: the in-browser editor writes to the content repository
through the GitHub API, using a token scoped to nothing else. This repository — the Astro
source, the contract, the editor shell, and the Ansible that deploys all of it — is never
editor-writable. On the box, the same split holds at the credential level: `content_repos`
clones each repository through its own read-only deploy key, cut for that one repository alone,
so a compromised key exposes exactly the repository it was issued for and nothing else.

## The editor: WordPress Playground, in the browser, no PHP on any server

Editors work in `wp-admin`. That `wp-admin` is not served by a PHP process anywhere — it is
WordPress Playground, a WebAssembly build of WordPress that boots and runs entirely inside the
visitor's own browser tab. `editor/entry.mjs` boots Playground from a blueprint and then writes
one small file into Playground's in-memory filesystem: `editor/mu-plugin/jamground.php`, which
restricts the block inserter to the set the contract can represent and strips block features the
contract has no field for. That file is the only `.php` in this entire repository, and a
conformance test fails the build if a second one ever appears outside `editor/`, or if any
import from the site's own build graph ever reaches into `editor/` at all — the two do not share
code at runtime, only the contract they both import.

Because the mu-plugin runs inside a sandboxed, single-user WASM instance with no server behind
it, it cannot be a security boundary — Playground has no concept of authorization to enforce.
It is a content-quality mechanism: it keeps what a person can insert lined up with what the
contract can express, nothing more. The actual security boundary is the GitHub layer described
above and below: what the editor's token can reach, and what a human has to approve before it
merges.

Editing is a round trip, not a live save. The shell imports existing content into Playground's
blocks, a person edits it there, and on save the shell maps Playground's blocks back to
contract-shaped YAML and Markdown, written through GitHub's Git Data API as one atomic
multi-file commit (the one-file-per-commit Contents API cannot keep copy and imagery together),
opened as a draft pull request. Nothing is live until that PR merges.

Consequently, the VPS never runs PHP, never runs WordPress, and never runs a database. It serves
static files and two small Node services (below).

## Authentication: a broker holds the secret, the browser never does

The editor shell is a registered GitHub OAuth App's callback (`https://edit.<domain>/`). Its
public Client ID is declared once, in `jamground.config.mjs`, and re-derived for the browser
bundle in `editor/config.mjs` — it is public by design, since it ends up in the shipped
JavaScript regardless of where it is written. What is committed there is a placeholder of the
right shape; the real one comes from `JAMGROUND_OAUTH_CLIENT_ID` in the operator's gitignored
`.env` and is baked into the bundle by `editor/build.mjs` as an esbuild `define`, so the
repository stays generic and the shipped bundle stays reviewable.

The Client *secret* is a different thing entirely and never reaches git or the browser. Sign-in
uses PKCE: the browser generates a code verifier and challenge, sends the challenge to GitHub's
authorize screen, and gets back a short-lived code. That code, together with the verifier — never
the secret — is posted to `/token` on the editor's own origin, which nginx proxies to a small
stateless Node service on localhost: the auth broker (`infra/broker/broker.mjs`, run by the
`broker` role under its own unprivileged account). The broker is the only thing on the box that
reads the Client secret, from a path an operator places it at by hand, never templated by
Ansible and never committed. It performs the code-for-token exchange with GitHub server-side,
answers only its own exact origin (never `*`), and holds nothing: no database, no session, no
file, no log of the token. The browser receives the resulting GitHub access token and keeps it
only in memory — gone on reload, never written to storage or a cookie — and uses it directly
against GitHub's own APIs from then on.

## The build: static Astro, drafts as one flag, links resolved before render

The build is Astro configured for static output. Content collections are loaded from
`$JAMGROUND_CONTENT_DIR/content` (default: the sibling `../jamground-content`); locale-neutral
singletons (`settings/site.yaml`, `settings/redirects.yaml`) are read and validated directly,
since they carry no envelope for the collection loader to key on. One environment flag,
`JAMGROUND_INCLUDE_DRAFTS`, decides whether draft entities are built at all — unset or empty
means excluded, `1` means included, anything else is a hard error rather than a silent default.
Preview and production are the same code path with one flag, never a fork.

A `ref:` field never holds a URL; it holds a translation-group id (see `docs/CONTENT.md`).
`src/lib/links.ts` resolves every such reference to a real path at build time, not at render
time, and throws rather than emitting a fallback: an unresolvable reference, a reference to a
group with no member in the referring locale, or a published entity linking to a draft are all
build failures. A broken link cannot reach production, and it cannot look fine in preview and
broken in production either, because both builds enforce the same rule.

## Deploy: Ansible, one VPS, a release directory, an atomic flip

`infra/ansible/site.yml` converges one host through twelve roles — accounts, the Node toolchain,
nginx, TLS certificates, the auth broker, the editor's vhost, the webhook receiver, the deploy
mechanism, the two content clones, build resource isolation, and a periodic self-check, in that
order. The box pulls; nothing pushes to it. There is no CI/CD service — an operator (or, once
wired to the webhook, the box itself) runs the playbook and the deploy script directly.

A deploy builds into a fresh, timestamped directory under `/srv/jamground/releases/`, verifies
the result (the build exited zero, the default locale's index page exists, the release manifest
parses), and only then flips `/srv/jamground/current` to it with a single `mv -T` — an atomic
rename, never an unlink-then-relink that could serve a half-updated root. A build or a check
that fails never becomes current; the previous release keeps serving, untouched.

Rollback reuses the same mechanism rather than a separate script. Every flip records what
`current` pointed at beforehand as `/srv/jamground/previous`, so rolling back is staging that
same target and flipping again — see `infra/RUNBOOK.md`. Old releases are pruned by count (the
last five, plus whatever `current` and `previous` point at), never by age, so a quiet week
cannot prune away the one release a rollback needs.

## What ships live and empty

Three pieces of infrastructure are converged, verified and reachable, but nothing drives them.
They are real systemd units and real nginx server blocks, not plans — which is exactly what
makes them easy to mistake for working features. Each is listed here so the next person finds
the gap by reading rather than by deploying.

**Previews are routed but never built.** `roles/nginx` serves `pr-<N>.preview.<domain>` from
`<previews_root>/<N>`, and the path-traversal guard on it is sound (the capture is digits only).
`roles/isolation` installs `jamground-preview-build@.service` with the resource envelope a
preview build should run inside. But its `ExecStart` is `/bin/true`, nothing instantiates the
unit, and nothing ever writes into `<previews_root>`. Every preview URL therefore returns 404.
The editor deliberately surfaces no preview link for this reason: a control that hands an editor
a dead URL is worse than no control. Wiring it means giving the unit a real build command, having
something instantiate it per change, and only then surfacing the URL.

**There is no automatic deploy.** `roles/webhook` runs `infra/hooks/server.mjs`, which
authenticates GitHub's HMAC, refuses replays and enqueues the delivery — correctly, and with its
own tests. Nothing consumes that queue. `jamground-deploy` (`roles/deploy`) is the real build,
verify, release-directory and symlink-flip mechanism, and it is invoked by hand. So publishing a
change updates the content repository and does not update the site. Anyone expecting a push to
reach the live site will find it did not, and no error will have been raised anywhere, because
nothing failed — nothing was asked to run.

**`jamground-production-build.service` is a resource envelope, not a build.** Its `ExecStart` is
also `/bin/true`; `jamground-deploy` is invoked directly rather than through systemd, so the
envelope constrains nothing today.
