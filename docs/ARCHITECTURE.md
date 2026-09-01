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
two files into Playground's in-memory filesystem: `editor/mu-plugin/jamground.php` and, beside
it, the block bundle. The mu-plugin restricts the block inserter to the set the contract can
represent and strips block features the contract has no field for. It also narrows the *surface*
— the admin menu is Posts, Pages and Authors and nothing else, the dashboard's widgets and
WordPress's own marketing and update notices are gone, patterns and the site editor are closed
rather than merely unlisted, and the rich-text toolbar offers only the four marks `InlineText`
allows. And it rewrites WordPress's own links to the site (below). That file is the only `.php` in
this entire repository, and a
conformance test fails the build if a second one ever appears outside `editor/`, or if any
import from the site's own build graph ever reaches into `editor/` at all — the two do not share
code at runtime, only the contract they both import.

What is trimmed is chosen by one test: whether a save path reads it back. `read-posts.mjs` reads
three WordPress fields — `post_title`, `post_name`, `post_content` — so an excerpt, a featured
image, a category, a page template and a discussion setting are all controls an editor can
operate whose values cannot reach a commit. Those are removed. Status and visibility are not,
because `import.mjs` sets `post_status` from the contract's own `status` and the distinction is
true information about the entity; that an *edit* to it does not travel is a real remaining gap,
and hiding the panel would conceal it rather than close it. `core/image` left the inserter for
the harder version of the same reason: both mappers refuse it for want of a media path, so while
it was offered an editor could do work that could not be saved anywhere. `jamground/cta` is out
for the same reason from the other direction: it is registered and round-trips, but its `link` is
required and names another entity, and there is no picker for one yet.

### The three custom blocks, and why they need a JavaScript bundle

`hero`, `featureGrid` and `cta` have no core equivalent, and registering them in PHP alone does
not work: PHP registration gives a `render_callback` and a REST presence and gives no `edit`
component, so the block is registered and never appears in the inserter. There is no build step
inside Playground either, so the bundle is built by `editor/build.mjs` with esbuild and carried in
as the second file the shell writes.

What that bundle renders is not a second template. The element structure and class names of every
custom block live once, in `design/markup/<block>.ts`; the Astro component renders that
description to HTML for the site and the `edit` component renders the same description through
`createElement` for the canvas, so the two agree by construction rather than by a diff. The
mu-plugin sends the design system — tokens, element defaults, the core `wp-block-*` selectors and
the three block sheets — into the canvas as editor styles, which is what makes a block in wp-admin
carry the site's colours, type and spacing. `design/site.css` is deliberately not sent: it holds
the page, and the canvas is not one.

Two gates hold this in place, and they catch different things. `editor/test/fidelity.test.mjs`
compares the Astro HTML with the editor's DOM and catches a block that looks wrong in the canvas;
`editor/test/playwright/markup-parity.test.mjs` compares what the two block registries serialise
and catches a save that cannot round-trip. Neither subsumes the other.

### wp-admin's own links name the site, not the WASM instance

WordPress resolves "View Page", "Preview" and the admin bar's site name through `home_url()`,
which in Playground is the scoped WASM origin with plain `?p=` permalinks — so every one of them
used to open this instance's own theme rendering, at an address unrelated to the site. Nothing
filtered them.

The real address is not computed in PHP, and must not be: `src/lib/links.ts` holds the routing
table exactly once. Each kind's helper is a field on its `KINDS` row (`sitePath`), so
`editor/lib/site-links.mjs` calls the helper and stores the answer, and the result travels to PHP
as a JSON data file — the same discipline `read-posts.mjs` states for the post-type list, where
nothing composes PHP around a value. The mu-plugin does a lookup and no arithmetic.

Which entities have an address depends on where the site currently is. While a change is open the
origin is that change's staging host, which renders drafts; while none is open it is production,
which does not — so a draft with no change open has no address anywhere, gets no entry, and its
link is *removed* rather than pointed somewhere untrue. The same rule covers an entity created
mid-session without a case of its own: no save has written it, so it is not in the map.

Two things about this are worth knowing before reading a rewritten link as more than it is. The
map is built from the slug **on disk**, not the one WordPress currently holds, because the
staging site serves what the last save wrote — being one save behind is agreement with the site
being linked to, not staleness. And WordPress's "Preview" means *see your unsaved draft*, which
nothing here can do: the shell cannot reach Gutenberg's DOM across the Playground origin
boundary, and staging rebuilds from the save, not from typing. It is pointed at the same real
address as the permalink because that is the closest true thing, and the caveat is said in words
on the shell's status line. A shell-owned preview control would let WordPress's button be removed
honestly; `entry.mjs` already reserves the identifier and `VOCAB.preview` already exists for it.

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

Two things about a preview are worth knowing before reading one as if it were the site.

**`/` on a preview host is the production redirect, and it had to be added deliberately.** The
build emits no bare-root `index.html` — only the default locale's — so every server block that
serves this site needs `location = / { return 301 /en-us/; }` or `/` falls through `try_files` to a
root with no index and nginx answers 403. The production blocks always had it and the preview
blocks did not, for the whole of this pipeline's earlier life: the previews were built, correct and
serving at `/en-us/`, while the single address `previewUrlFor()` hands an editor was the one that
could not work. Nothing caught it, because every check on the box — `verify/nginx.yml`,
`jamground-selfcheck` — sent the production Host, and the one offline gate that knew the preview
URL ended in `/` never asked what answered it. `verify/nginx.yml` now sends a `pr-<N>.preview.`
Host, and `test/gates/preview-work-root.test.mjs` now derives the preview blocks' expected redirect
target from the production blocks so the two cannot diverge again.

**A preview's canonical URLs point at production.** `astro.config.mjs` sets `site` to the
production origin for both builds — that is the same "one flag is the entire difference" property
above, and changing it per build would fork the two code paths this design exists to keep unified —
so `<link rel="canonical">` and `hreflang` in a preview name `https://<domain>/…`, not the preview
host. Following one leaves the preview. Nothing is wrong with the preview; the canonical is simply
about where the page will live, not where it is being shown.

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

**`jamground-production-build.service` is a resource envelope, not a build.** Its `ExecStart` is
still `/bin/true`, and it stays that way for two specific reasons rather than for want of a pass:
it is `User=jamground-build`, which cannot flip the release symlink, and `PrivateNetwork=yes`,
which cannot fetch the merge it would be deploying. The automatic deploy below therefore joins
`jamground-production.slice` — inheriting the CPU weight, which is the part that matters when a
preview build is running beside it — rather than being instantiated through this unit. (Its
preview counterpart is no longer a placeholder either.)

**Three paragraphs that used to be here have been discharged, and are worth keeping in outline
because each names a gap that looked exactly like a working feature.** Previews were built while
the editor did not link to them; the shell now shows the staging address when a change opens, on
save, and on send-for-review. There was no automatic production deploy: a merged pull request
updated the content repository and left the live site alone, which ran for three merges with every
unit active and every check green. And **wp-admin's own "View" and "Preview" links pointed at the
WASM instance** for the whole of the editor's earlier life — the address an editor is most likely
to click to check their work was the one that could not show it, while the shell's status line
beside it carried the correct staging address all along. Nothing caught it, because no test had
ever asked what `get_permalink()` returned. All three are described where they now work — the
preview address and the link rewriting in the editor section above, and the deploy below.

## Deploying on merge: a request an unprivileged process can write

`deployProductionOnMerge` in `infra/hooks/lib/consumer.mjs` was a named, called, deliberately empty
function for exactly as long as three prerequisites went unanswered. It is now the seam it was
reserved as, and what it does is write a file.

The queue consumer runs as `jamground-build`, which holds **no sudo at all**. On `closed` +
`merged` it enqueues one small JSON request into `/var/lib/jamground/deploy-requests/` — the same
atomic temp-then-rename `enqueue` the delivery queue uses, so a `.path` unit's `*.json` glob can
never fire on a half-written one. `jamground-deploy-request.path` starts
`jamground-deploy-request.service`, which runs as `jamground` and **takes nothing from that request
but its existence**: it claims every file, invokes a fixed no-argument wrapper, and deletes what it
claimed. What an unprivileged decision can say is *a merge happened*; what it cannot say is *what
to run*. That asymmetry is the whole design, and it is why the handover is a directory of files
rather than a call.

The three prerequisites, each discharged rather than worked around:

1. **Privilege.** `sudo env JAMGROUND_*_CHECKOUT=… jamground-deploy` is an argument-taking
   privileged command, and this box grants none. `jamground-deploy-now` (`roles/deploy`, root-owned
   `0700`) fixes both checkout paths and the build account inside itself, so the third sudoers
   entry — the only privilege this added — still takes no arguments. It also refreshes the content
   checkout first, because `jamground-deploy` builds what is on disk and `roles/content_repos` only
   pulls at converge time: without that step an automatic deploy would rebuild the same commit,
   record the same `contentSha`, flip, and exit 0.
2. **One lock.** Both build scripts now `flock` `$JAMGROUND_SITE_CHECKOUT/.build.lock`. The path is
   derived rather than declared, and every alternative is unopenable by one side: the previews
   image is a different filesystem the deploy must not write, and `/srv/jamground` is not in the
   consumer's `ReadWritePaths` — putting it there would hand a build that executes pull-request
   content write access to `releases/` and `current`. The converge creates the file owned by
   `jamground-build`, because whoever locks first creates it and a root-owned lock is `EACCES` for
   every preview build afterwards.
3. **A failure policy.** The deploy itself is unchanged — it never flips on a failure, so
   production keeps serving. What is added is being *noticed*, since nobody watches an automatic
   deploy: requests move to `deploy-requests.failed/` intact, the unit stays in `failed`, and
   `jamground-selfcheck` alarms on that, on a request left unclaimed for ten minutes (a `.path`
   unit that has silently stopped firing), and on `current`'s manifest naming an older content SHA
   than the checkout holds. **There is no automatic retry**: a content defect that fails the build
   would otherwise rebuild for ever.
