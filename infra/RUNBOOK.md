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

Twelve roles converge in order, each depending only on what already ran: `users` (the two
service accounts and the no-argument sudo grant), `bot_token`, `toolchain` (pinned Node),
`nginx`, `certificates`, `broker` (the OAuth token exchange), `editor_shell` (the editor's
vhost), `webhook` (the receiver, shipped live and unused until wired up), `deploy` (the release
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
| `nginx.yml` | nginx is installed, enabled, and its config is valid |
| `certificates.yml` | the certificate exists and covers the names the configuration expects |
| `broker.yml` | the auth broker service is running and answering on localhost |
| `editor-shell.yml` | the editor bundle is deployed and its vhost is live |
| `webhook.yml` | the receiver is running and its HMAC secret is in place |
| `deploy.yml` | `current` is a real symlink into `releases/`, the deploy mechanism is present and executable, and `/etc/jamground/deploy.env` carries the six identity values and nothing else |
| `content-repos.yml` | both repositories are cloned, each over its own read-only deploy key |
| `isolation.yml` | the build resource slices exist |
| `selfcheck.yml` | the periodic self-check timer is installed and enabled |

Run any of them the same way `site.yml` runs, in a shell that has sourced `.env`:

```sh
set -a; . ../../.env; set +a
ansible-playbook -i inventory.yml verify/deploy.yml
```

## Deploying

`content_repos` performs the first build. After that, a deploy is running the script `deploy`
shipped, against the two already-cloned repositories. This one runs **on the box**, as the build
account, so it takes its identity from `/etc/jamground/deploy.env` — which the converge wrote
from your `.env` — rather than from your `.env` itself, which the box never sees. The only two
things you hand it are the two checkout directories, and they are named `_CHECKOUT` rather than
`_REPO` on purpose: `JAMGROUND_SITE_REPO` and `JAMGROUND_CONTENT_REPO` already mean the two
repository *names* to the build that runs inside this script, and a directory passed under those
names would be read as a name.

```sh
sudo -u jamground-build \
  JAMGROUND_SITE_CHECKOUT=/srv/jamground/repos/site \
  JAMGROUND_CONTENT_CHECKOUT=/srv/jamground/repos/content \
  /usr/local/bin/jamground-deploy
```

It builds fresh (`npm ci && npm run build`), verifies the result — the build exited zero, the
default locale's index page exists, the release manifest parses — and only then flips `current`
to the new release with one atomic `mv -T`. A build or a check that fails leaves `current`
untouched; nothing partial is ever served.

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
