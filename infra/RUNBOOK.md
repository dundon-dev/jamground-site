# infra/RUNBOOK.md — deploying Jamground

This is a guide for standing up your own deployment, not a record of one. Every
environment-specific value below is a placeholder — the same ones `jamground.config.mjs` and
`.env.example` already use (`example.com`, `your-org`, `203.0.113.10`) — and none of it is a
secret; secrets are named by path only, in §Secrets.

## Prerequisites

- One VPS running a Debian- or Ubuntu-family Linux with systemd (every role installs packages
  with `apt` and manages services with `systemd`), reachable over SSH by a user that can `sudo`
  to root. Any provider works; nothing here is provider-specific.
- A domain you control, able to carry an A record for the apex and for whatever subdomains you
  route `edit.`, `hooks.` and preview builds through, plus a DNS provider that can do DNS-01
  challenges if you want wildcard certificates (the shipped `certificates` role assumes
  Cloudflare; adapt it if you use another).
- A GitHub organisation or user owning two repositories: this site's code, and a separate content
  repository (`jamground-content` by default — see the README's two-repo model).
- A GitHub OAuth App for the in-browser editor, with callback `https://edit.<your-domain>/`.
- A GitHub machine ("bot") account holding a fine-grained personal access token scoped to write
  the content repository only.
- On the machine you run Ansible *from*: `ansible-core 2.20.1` and the pinned collections —
  `ansible-galaxy collection install -r infra/ansible/requirements.yml`. Node is installed **on
  the box** by the `toolchain` role itself; you do not need it there beforehand.

## Configuration

Copy `.env.example` to `.env` and fill it in. That is the whole of it — `.env` is gitignored,
and it is the only file you edit. Nothing tracked in this repository ever holds a real value:
`npm run check:config` (part of `npm test`) fails the build if one appears in a tracked file,
and skips `.env` precisely because that is where they belong.

Six values declare the deployment's identity. Each is read from the environment by **both**
halves — by `jamground.config.mjs` at build time and by `infra/ansible/group_vars/all.yml` at
converge time — and each falls back to the generic placeholder committed beside it, so a clone
that configures nothing still builds. `check:config` compares the two *declarations*, the
variable and the fallback, and fails if they ever disagree:

| Variable | `jamground.config.mjs` | `infra/ansible/group_vars/all.yml` | Meaning | If unset |
|---|---|---|---|---|
| `JAMGROUND_DOMAIN` | `domain` | `jamground_domain` | The apex the site is served from; `edit.`, `hooks.`, `preview.` hang off it. | `example.com` |
| `JAMGROUND_GITHUB_ORG` | `githubOrg` | `jamground_github_org` | The GitHub organisation or user owning both repositories. | `your-org` |
| `JAMGROUND_SITE_REPO` | `siteRepo` | `jamground_site_repo` | This repository's name. | `jamground-site` |
| `JAMGROUND_CONTENT_REPO` | `contentRepo` | `jamground_content_repo` | The content repository's name. | `jamground-content` |
| `JAMGROUND_CONTENT_BRANCH` | `contentBranch` | `jamground_content_branch` | The branch content publishes from. | `main` |
| `JAMGROUND_OAUTH_CLIENT_ID` | `oauthClientId` | `jamground_oauth_client_id` | The OAuth App's **public** client id — never the secret. | `Ov23liEXAMPLE0CLIENT` |

Everything else (site URL, editor origin, redirect URI, `org/repo` slugs) is derived from these
six by rule, on both sides. An **empty** value counts as unset on both sides too, so a
half-filled `.env` gets the placeholder rather than a blank.

Your `.env` never leaves this machine, and a deploy does not run here — it runs on the box, from
the checkouts the box pulled. So the converge writes the six down there too, as
`/etc/jamground/deploy.env` (`roles/deploy`), and `jamground-deploy` sources that before it
builds. Same six values, same `KEY=value` shape, same one-line idiom reading it; root-owned and
mode `0644`, because all six are public by construction — they are baked into the editor bundle
at build time wherever they are written. **No secret is ever written there**; the three that
exist are the ones in §Secrets, and they stay at those paths. A box that has never converged
`deploy` has no such file, and `jamground-deploy` builds the placeholders rather than refusing to
run — which is the one thing you would notice as `example.com` in the canonical URLs.

Three more values belong to *your machine*, never to the deployment, and are never committed.
`infra/ansible/inventory.yml` reads them the same way:

| Variable | Meaning | If unset |
|---|---|---|
| `JAMGROUND_VPS_HOST` | the box's address | `203.0.113.10` — unroutable, so a clone that configured nothing fails to connect rather than converging a stranger's server |
| `JAMGROUND_VPS_SSH_USER` | the account Ansible connects as | `root` |
| `JAMGROUND_VPS_SSH_KEY` | the private key on this machine | `~/.ssh/id_ed25519` |

### Getting `.env` into the environment

Neither Ansible nor Node reads `.env` on its own, and no dependency was added to make either of
them do it. Source it into the environment instead, which is one line of shell and is the whole
mechanism:

```sh
set -a; . ./.env; set +a
```

`set -a` marks every variable assigned from then on for export, so the plain `KEY=value` lines
in `.env` become environment variables; `set +a` stops that again. Run it in the shell you are
about to converge, build, or run `editor/build.mjs` from. Forget it and you get the
placeholders — a site built for `example.com` and a converge aimed at an unroutable address —
rather than a half-configured deployment.

## Secrets: what goes on the box, by hand

No secret value is ever committed to either repository. Each of these is placed on the box by an
operator, before the role that needs it converges:

| Secret | Path on the box | Notes |
|---|---|---|
| OAuth App Client secret | `/etc/jamground/oauth-client.secret` | mode `0640`; read only by the broker's own unprivileged account |
| Bot's fine-grained PAT | dropped at `/root/jamground.pat`; the `bot_token` role relocates it to `/etc/jamground/github-bot.token` and deletes the world-readable original | |
| DNS API token for DNS-01 issuance | `/etc/jamground/acme/dns.ini`, in `certbot-dns-cloudflare`'s ini format | mode `0600` — certbot refuses to use it otherwise |

Everything else with a security boundary — the per-repository deploy keys, the webhook's HMAC
secret — is generated on the box by the roles themselves (`content_repos`, `webhook`) and never
touches your machine or either repository.

| Thing | Value |
|---|---|
| SSH | `root@203.0.113.10`, key `~/.ssh/id_ed25519` |
| Release root | `/srv/jamground` — `current`/`previous` symlinks, `releases/<UTC>-<contentSha7>-<siteSha7>/` |

## Converging

```sh
set -a; . ./.env; set +a      # see §Configuration — without this you converge the placeholders
cd infra/ansible
ansible-playbook site.yml
```

Each role is tagged with its own name, so a change confined to one part of the box can converge
that part alone:

```sh
ansible-playbook site.yml --tags editor_shell   # ship the editor bundle, nothing else
ansible-playbook site.yml --list-tags           # the twelve names
```

That is worth reaching for when the alternative is disproportionate: a change under `editor/`
is shipped entirely by `editor_shell`, and a full converge to deliver it would also run certbot
and have `content_repos` pull, rebuild and re-flip the site for a build whose output did not
change. **Tags select; they do not satisfy dependencies** — a tagged run assumes everything the
role converges after is already in place and does not check, so the ordering below still governs
a first converge, and an unqualified `site.yml` remains the operation to reach for whenever that
assumption is not safe.

Twelve roles converge in order, each depending only on what already ran: `users` (the two
service accounts and the no-argument sudo grant), `bot_token`, `toolchain` (pinned Node),
`nginx`, `certificates`, `broker` (the OAuth token exchange), `editor_shell` (the editor's
vhost), `webhook` (the receiver, plus the timer that drains its queue into preview builds),
`deploy` (the release
mechanism, seeded with one placeholder release so `current` is never dangling), `content_repos`
(clones both repositories and performs the first real build), `isolation` (build resource
slices), and `selfcheck` last, since its checks are live against whatever the box now actually
serves. A clean re-converge should report no changes.

## Verifying

Each role has a matching read-only playbook under `infra/ansible/verify/` that asserts live
state on the box, rather than trusting the converge's own change count — plus one that only
checks connectivity:

| Verify playbook | Confirms |
|---|---|
| `ping.yml` | the inventory host is reachable at all |
| `users.yml` | the two service accounts and the sudoers grant exist |
| `bot-token.yml` | the bot token is in place and world-unreadable |
| `toolchain.yml` | the pinned Node version is installed and on `PATH` for the build account |
| `nginx.yml` | nginx is installed, enabled, its config is valid, and the `hooks.` vhost is in the config it is actually running |
| `certificates.yml` | the certificate exists and covers the names the configuration expects |
| `broker.yml` | the auth broker service is running and answering on localhost |
| `editor-shell.yml` | the editor bundle is deployed and its vhost is live |
| `webhook.yml` | the receiver is running, an unsigned delivery is refused both directly and routed by name through nginx, and the queue consumer's timer is enabled |
| `deploy.yml` | `current` is a real symlink into `releases/`, the deploy mechanism is present and executable, and `/etc/jamground/deploy.env` carries the six identity values and nothing else |
| `content-repos.yml` | both repositories are cloned, each over its own read-only deploy key |
| `isolation.yml` | the build resource slices exist, and the preview per-build unit runs the real build script rather than a placeholder |
| `selfcheck.yml` | the periodic self-check timer is installed and enabled |

Run any of them the same way `site.yml` runs, in a shell that has sourced `.env`:

```sh
set -a; . ../../.env; set +a
ansible-playbook -i inventory.yml verify/deploy.yml
```

## Deploying

`content_repos` performs the first build. After that, a deploy is running the script `deploy`
shipped, against the two already-cloned repositories. This one runs **on the box**, and it takes
its identity from `/etc/jamground/deploy.env` — which the converge wrote from your `.env` — rather
than from your `.env` itself, which the box never sees. The only two things you hand it are the two
checkout directories, and they are named `_CHECKOUT` rather than `_REPO` on purpose:
`JAMGROUND_SITE_REPO` and `JAMGROUND_CONTENT_REPO` already mean the two repository *names* to the
build that runs inside this script, and a directory passed under those names would be read as a
name.

Run it **as root**, which is not the same as running the build as root: the script performs the two
halves at two privilege levels itself, dropping to `jamground-build` for `npm ci && npm run build`
and keeping only the symlink flip and the nginx reload privileged. Root is the one account here
that can make that drop — `jamground-build` holds no sudo at all and `jamground` holds exactly three
no-argument entries — so running the script as either of them instead builds as that account and,
in `jamground`'s case, leaves the shared site checkout owned by an account the preview build cannot
write.

```sh
sudo env \
  JAMGROUND_SITE_CHECKOUT=/srv/jamground/repos/site \
  JAMGROUND_CONTENT_CHECKOUT=/srv/jamground/repos/content \
  /usr/local/bin/jamground-deploy
```

It builds fresh (`npm ci && npm run build`), verifies the result — the build exited zero, the
default locale's index page exists, the release manifest parses — and only then flips `current`
to the new release with one atomic `mv -T`. A build or a check that fails leaves `current`
untouched; nothing partial is ever served.

## Previews

A pull request against the content repository builds its own staging site, with nothing to run by
hand: GitHub POSTs to `https://hooks.<domain>/`, the receiver queues the delivery, and
`jamground-hooks-consume.path` starts the consumer the moment the job lands — the timer beside it
is a five-minute backstop for a delivery arriving mid-build, not the mechanism — and it runs the
build. The result
is at `https://pr-<N>.preview.<domain>/`, and closing the pull request removes it.

To build one by hand — the same script, same arguments the consumer passes:

```sh
sudo -u jamground-build env \
  JAMGROUND_SITE_CHECKOUT=/srv/jamground/repos/site \
  JAMGROUND_CONTENT_CHECKOUT=/srv/jamground/repos/content \
  /usr/local/bin/jamground-preview-build 42 refs/pull/42/head
```

When a preview does not appear, the queue is the place to look, and nothing is ever thrown away:

```sh
journalctl -u jamground-hooks-consume --since -1h
ls /var/lib/jamground-hooks/queue    # waiting
ls /var/lib/jamground-hooks/failed   # tried, could not be handled — the delivery is intact
```

A job in `failed/` also makes the last consumer run exit non-zero, so `systemctl status
jamground-hooks-consume` keeps saying so. Re-run one by moving it back into `queue/`.

## Deploying automatically

A merged pull request deploys production on its own; the section above is now the manual path, for
a site change or a repair rather than for content.

The chain is short and split across two accounts on purpose. The webhook queue consumer
(`jamground-build`, no sudo at all) turns a `pull_request.closed` + `merged` delivery into one JSON
file in `/var/lib/jamground/deploy-requests/`. `jamground-deploy-request.path` sees it and starts
`jamground-deploy-request.service`, which runs as `jamground` and takes **nothing from that file but
its existence**: it claims every request, calls `sudo jamground-deploy-now` — a fixed, no-argument
wrapper that refreshes the content checkout and runs `jamground-deploy` — and then deletes the
requests it claimed. What an unprivileged process can say is "a merge happened"; what it cannot say
is what to run.

```sh
journalctl -u jamground-deploy-request --since -1h
ls /var/lib/jamground/deploy-requests          # waiting to be claimed
ls /var/lib/jamground/deploy-requests.claimed  # in flight, or left by a run that died
ls /var/lib/jamground/deploy-requests.failed   # the deploy failed; the request is intact
```

A failed deploy never flips, so production keeps serving the previous release. The requests move to
`failed/` naming the pull request, the unit stays in `failed` so `systemctl status` keeps saying
so, and `jamground-selfcheck` raises the box's existing alarm on both that and a request left
unclaimed for ten minutes. **There is no automatic retry** — a content defect that fails the build
would otherwise rebuild for ever. Re-run one by moving it back:

```sh
sudo -u jamground mv /var/lib/jamground/deploy-requests.failed/<name> \
                     /var/lib/jamground/deploy-requests/
```

To exercise the chain without a merge, write a request as the account that really writes them:

```sh
sudo -u jamground-build install -m 0644 /dev/stdin \
  /var/lib/jamground/deploy-requests/$(date +%s)000-smoke.json <<<'{"reason":"smoke test"}'
journalctl -fu jamground-deploy-request
```

**One lock covers every build in the site checkout.** `jamground-deploy` and
`jamground-preview-build` both `flock` `/srv/jamground/repos/site/.build.lock`, because the deploy's
`npm ci` deletes the `node_modules` a preview build may be using. Each waits up to 900s. A deploy
that timed out waiting says so and leaves `current` untouched.

## Rollback

There is no separate rollback script — every flip already records what `current` pointed at
beforehand as `previous`, so rolling back is staging that same target and re-running the one
privileged flip:

```sh
target=$(readlink /srv/jamground/previous)
ln -sfn "$target" /srv/jamground/.current.tmp
sudo /usr/local/sbin/jamground-release-switch
sudo /usr/local/sbin/jamground-reload-nginx
```

Releases are pruned by count on every flip — the last five, plus whatever `current` and
`previous` point at — never by age, so a quiet week cannot prune away a rollback target. That
also means rollback only reaches back one step by default; recovering an older release means
pointing `.current.tmp` at its `releases/<name>` directory directly, if it hasn't been pruned.

## Open items

- DNS providers generally cannot scope a DNS-edit API token below the whole zone. The token in
  `/etc/jamground/acme/dns.ini` can therefore rewrite every record in the zone it belongs to, not
  just this project's. If the box is ever compromised, rotate that token first.
- There is no backup story here beyond git: nothing on the box is treated as data, so recovery
  from a lost box is re-provisioning a fresh one and re-running `site.yml`, never a restore.
- Do not create an AAAA record for a host unless the box actually answers on IPv6. An AAAA that
  does not answer is worse than no AAAA at all — it fails intermittently instead of falling back.
