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
Preview and production are the same code path with one flag, never a fork: `jamground-deploy`
leaves it unset and `jamground-preview-build` sets it to `1`, which is the entire difference
between what a staging site shows and what the live site shows.

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
order. The box pulls; nothing pushes to it. There is no CI/CD service — an operator runs the
playbook and the deploy script directly. The one thing the box now does on its own is build
staging sites: GitHub's webhook is the trigger, and the box does the fetching (see below).

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

## Staging: a preview site per change, built by the box

Opening a pull request against the content repository builds a staging site for it, reachable at
`https://pr-<N>.preview.<domain>/`. Five pieces make that one chain, and each existed alone
before it existed as a chain:

1. **nginx routes two names.** `pr-<N>.preview.<domain>` is served from `<previews_root>/<N>`
   (the capture is digits only, which is the whole path-traversal guard), and
   `hooks.<domain>` proxies to the receiver on localhost. The second of those was missing for the
   whole of this pipeline's earlier life — see below.
2. **The receiver takes the delivery.** `infra/hooks/server.mjs` verifies GitHub's HMAC over the
   raw bytes, refuses a replayed delivery id, and writes the job to a filesystem queue. It parses
   nothing: what the payload *means* is not its decision to make.
3. **The consumer makes the decision.** `infra/hooks/lib/consumer.mjs`, run by
   `jamground-hooks-consume.timer` about once a minute, reads the queue oldest-first and turns
   each `pull_request` delivery into one of three outcomes — build the preview
   (`opened`/`reopened`/`synchronize`), tear it down (`closed`), or drop a delivery this pipeline
   has no opinion about. A job it cannot handle is moved to `<state>/failed/` intact and the run
   exits non-zero, because a queue that empties on error looks exactly like one that succeeded.
4. **The build produces the site.** `jamground-preview-build` (`roles/isolation`) fetches the
   pull request's head ref into a private ref namespace, extracts it with `git archive` — the
   shared content checkout never leaves `main` — and builds the site checkout against that tree
   with `JAMGROUND_INCLUDE_DRAFTS=1`, into an out directory of its own. It publishes into
   `<previews_root>/<N>` only after the build exits zero and the default locale's index page
   exists, which is the same discipline `jamground-deploy` applies before it flips `current`.
5. **Closing the pull request removes it**, so the previews filesystem holds one static root per
   *open* change and no more.

Nothing in that chain runs as anything but `jamground-build`, the account with no sudo at all.
That is also why the consumer invokes the build script directly rather than starting
`jamground-preview-build@<N>.service`: `systemctl start` with an instance name is an
argument-taking privileged command, and the two sudo entries this box grants take no arguments
precisely so there is no path or option injection surface. The templated unit is real and
instantiable by hand, and it keeps `PrivateNetwork=yes` — which is what makes it the wrong host
for the automatic path, since fetching a ref pushed a second ago needs a network.

## What ships live and empty

Some infrastructure is converged, verified and reachable while nothing drives it. Real systemd
units and real nginx server blocks are exactly what makes such a gap easy to mistake for a
working feature, so what is still empty is listed here, to be found by reading rather than by
deploying.

**The first hop used to be missing, and that is worth keeping written down.** `roles/webhook`
authenticates GitHub's HMAC, refuses replays and enqueues correctly, with its own tests — and for
the whole of its earlier life it never received anything, because no `server_name hooks.<domain>`
existed in any template. Deliveries fell through to nginx's default server and GitHub recorded
`405` for every one. Every part looked healthy from the box: the unit was active, the secret was
in place, the certificate covered the name, `nginx -t` passed. Nothing but GitHub's own delivery
log knew. `verify/nginx.yml` now asserts the vhost against `nginx -T`'s output and
`verify/webhook.yml` POSTs to the name and requires the receiver's own `401`, so the same gap
cannot reopen quietly.

**Previews are built, but the editor still does not link to them.** The URL is live and a change
now populates it; nothing in `wp-admin` tells an editor it exists. That is deliberate for as long
as the link would be a guess — it becomes a real control once the shell can tell whether a given
pull request's build has landed yet, rather than handing out a URL that may still be 404 for
another minute.

**There is no automatic production deploy.** `jamground-deploy` (`roles/deploy`) is the real
build, verify, release-directory and symlink-flip mechanism, and it is still invoked by hand: a
merged pull request updates the content repository and does not update the live site. The seam is
`deployProductionOnMerge` in `infra/hooks/lib/consumer.mjs` — a named, called, deliberately empty
function on the `closed` + `merged` path, so there is exactly one place to wire and it is already
reached by the tests. Wiring it needs three things it does not have yet: a way to run the flip,
which needs the `jamground` account's two no-argument sudo wrappers rather than the
`jamground-build` account the consumer runs as; one lock shared with `jamground-preview-build`,
because `jamground-deploy` starts with an `npm ci` that deletes the dependency tree a preview
build may be using in the same checkout; and a decision about what a failed automatic deploy
should do that a failed manual one does not.

**`jamground-production-build.service` is a resource envelope, not a build.** Its `ExecStart` is
still `/bin/true`; `jamground-deploy` is invoked directly rather than through systemd, so the
envelope constrains nothing today. (Its preview counterpart is no longer a placeholder.)
