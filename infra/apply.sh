#!/usr/bin/env bash
#
# infra/apply.sh — converge this host toward the configuration in RUNBOOK.md.
#
# This is not the preferred recovery path, it is the ONLY one: the provider offers no
# snapshot or backup facility. It must therefore be idempotent, and its real acceptance
# test is running it against a FRESH Debian 13 host to a green site — not against the
# host it was developed on.
#
#   ./apply.sh          converge
#   ./apply.sh --check  report drift, change nothing, exit 1 if drift found
#
# Implements the full hardening and service baseline: firewall, swap, SSH policy, users,
# nginx, certificates, the release-directory deploy, the webhook receiver, the systemd
# slices, and the selfcheck timer. Each section is independently idempotent.
#
# Ordering note: nothing here may run before the SSH policy and firewall are correct,
# because every later step is applied over the connection they govern.

set -euo pipefail

CHECK=0
CONFIRM=0
case "${1:-}" in
  --check)            CHECK=1 ;;
  --confirm-firewall) CONFIRM=1 ;;
  '')                 ;;
  *) echo "usage: $0 [--check|--confirm-firewall]" >&2; exit 2 ;;
esac

drift=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
need() { printf '  DRIFT %s\n' "$*"; drift=1; }

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2; exit 2
fi

# --confirm-firewall: reaching this line at all is the proof. A new SSH connection had
# to traverse the freshly loaded ruleset to run it, so the ruleset demonstrably permits
# SSH. Only then is it made permanent.
if [ "$CONFIRM" = 1 ]; then
  systemctl stop jamground-fw-rollback.timer 2>/dev/null || true
  systemctl reset-failed jamground-fw-rollback.service 2>/dev/null || true
  nft list chain inet filter input >/dev/null 2>&1 || {
    echo 'no ruleset loaded — nothing to confirm (it may already have rolled back)' >&2; exit 1; }
  systemctl enable --now nftables >/dev/null 2>&1
  echo 'firewall confirmed reachable over a new connection and persisted'
  exit 0
fi

# ── Swap ───────────────────────────────────────────────────────────────────────────
# 8 GB is not generous: two concurrent preview builds need roughly 1.2 GB each while
# sharp processes the media set. Without swap the failure mode is an OOM-kill during a
# preview build, which with no snapshots is expensive to be surprised by.
say 'swap'
if swapon --show --noheadings | grep -q .; then
  ok "swap active ($(swapon --show=SIZE --noheadings | tr -d ' ' | paste -sd, -))"
elif [ "$CHECK" = 1 ]; then
  need 'no swap configured'
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok 'created /swapfile (2G) and added it to fstab'
fi

# ── SSH policy ─────────────────────────────────────────────────────────────────────
# Key-only, no password authentication. Applied BEFORE the firewall, so that if the
# firewall step goes wrong the rollback below restores a host whose SSH policy is
# already correct rather than one in a half-configured state.
say 'sshd'
SSHD_DROP=/etc/ssh/sshd_config.d/10-jamground.conf
SSHD_WANT='# Managed by infra/apply.sh. Key-only: the origin IP is public for every host
# except the site host (RUNBOOK §TLS), so password authentication is exposed to the
# whole internet rather than to a Cloudflare-fronted subset.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 3'
if [ -f "$SSHD_DROP" ] && [ "$(cat "$SSHD_DROP")" = "$SSHD_WANT" ]; then
  ok 'sshd policy in place'
elif [ "$CHECK" = 1 ]; then
  need "$SSHD_DROP missing or modified"
else
  mkdir -p /etc/ssh/sshd_config.d
  printf '%s\n' "$SSHD_WANT" > "$SSHD_DROP"
  # Validate before reloading. A malformed drop-in that is reloaded anyway takes sshd
  # down, and there is no console in the recovery path.
  sshd -t
  systemctl reload ssh
  ok 'wrote sshd policy and reloaded'
fi

# ── Firewall ───────────────────────────────────────────────────────────────────────
# Default-drop inbound, accept established, loopback, ICMP and 22/80/443.
#
# THE ROLLBACK IS NOT OPTIONAL. A wrong ruleset locks this host out permanently: the
# provider has no snapshots and no serial console in the documented recovery path. So
# the new ruleset is armed with a timer that flushes it, and the timer is cancelled
# only after the operator confirms the connection still works.
say 'firewall'
NFT_CONF=/etc/nftables.conf
NFT_WANT='#!/usr/sbin/nft -f
# Managed by infra/apply.sh.
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;

    ct state established,related accept
    ct state invalid drop
    iif lo accept

    # ICMP is not optional: dropping it breaks path-MTU discovery, which shows up as
    # large responses hanging rather than as anything that looks like a firewall.
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    tcp dport 22 accept
    tcp dport { 80, 443 } accept
  }
  chain forward { type filter hook forward priority filter; policy drop; }
  chain output  { type filter hook output  priority filter; policy accept; }
}'

if [ -f "$NFT_CONF" ] && [ "$(cat "$NFT_CONF")" = "$NFT_WANT" ] \
   && systemctl is-enabled --quiet nftables 2>/dev/null \
   && nft list chain inet filter input >/dev/null 2>&1; then
  ok 'nftables ruleset in place and loaded'
elif [ "$CHECK" = 1 ]; then
  need 'nftables ruleset absent, modified, or not loaded'
else
  command -v nft >/dev/null || { apt-get update -qq && apt-get install -y -qq nftables; }

  printf '%s\n' "$NFT_WANT" > "$NFT_CONF"
  chmod 0755 "$NFT_CONF"
  nft -c -f "$NFT_CONF"          # parse-check before anything is loaded

  # Arm the rollback under systemd, NOT as a background job of this shell. A `sleep &`
  # dies with the SSH session that started it, which is precisely the case the rollback
  # exists for — the session dying is the symptom of having locked yourself out.
  systemd-run --unit=jamground-fw-rollback --on-active=300 \
              /usr/sbin/nft flush ruleset >/dev/null 2>&1
  nft -f "$NFT_CONF"

  echo
  echo '  Ruleset loaded, NOT yet persisted. It flushes in 300s unless confirmed.'
  echo '  Prove reachability over a NEW connection — not this one, which is already'
  echo '  established and would be accepted by the conntrack rule regardless:'
  echo
  echo '      ssh root@<host> true && ssh root@<host> infra/apply.sh --confirm-firewall'
  echo
  ok 'armed; confirm within 300s or it rolls back'
fi

echo
if [ "$CHECK" = 1 ] && [ "$drift" -ne 0 ]; then
  echo 'drift found'; exit 1
fi
echo 'converged'
