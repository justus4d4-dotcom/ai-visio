#!/usr/bin/env bash
#
# create-lxc.sh — Create an unprivileged Ubuntu 24.04 LXC on a Proxmox host and
# provision AI Image Interpreter inside it.
#
# Run this ON THE PROXMOX HOST (as root). It creates the container, starts it,
# copies install.sh in, and runs it. All tunables are environment variables so
# you can override them without editing the script:
#
#   CTID=110 HOSTNAME=ai-visio BRIDGE=vmbr0 ./create-lxc.sh
#
# By default the container gets its IP via DHCP. Set IPCONFIG to a static
# address, e.g. IPCONFIG="ip=192.0.2.10/24,gw=192.0.2.10".
#
set -euo pipefail

# ── Tunables ──────────────────────────────────────────────────────────────────
CTID="${CTID:-110}"
HOSTNAME="${HOSTNAME:-ai-visio}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
SWAP="${SWAP:-512}"
DISK_GB="${DISK_GB:-8}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
# Ubuntu 24.04 ships Python 3.12, which the backend requires (requires-python >=3.12).
TEMPLATE="${TEMPLATE:-ubuntu-24.04-standard_24.04-2_amd64.tar.zst}"
BRIDGE="${BRIDGE:-vmbr0}"
IPCONFIG="${IPCONFIG:-ip=dhcp}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"

# Repo + app config passed through to install.sh
REPO_URL="${REPO_URL:-https://github.com/justus4d4-dotcom/ai-visio}"
REPO_REF="${REPO_REF:-main}"
# For a private fork, export GITHUB_TOKEN with read-only Contents access before running.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
BOOTSTRAP_ADMINS="${BOOTSTRAP_ADMINS:-}"
DB_PASSWORD="${DB_PASSWORD:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1;32m[create-lxc]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[create-lxc] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null 2>&1 || die "pct not found — run this on the Proxmox host."
[[ "$(id -u)" -eq 0 ]] || die "must run as root."

if pct status "$CTID" >/dev/null 2>&1; then
  die "CTID $CTID already exists. Set CTID=<free id> or destroy it first."
fi

# ── Ensure the template is present ────────────────────────────────────────────
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  log "Template $TEMPLATE not found locally; downloading…"
  pveam update >/dev/null 2>&1 || true
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" \
    || die "Could not download template $TEMPLATE. Run 'pveam available' to pick a valid one."
fi

# ── Create + start the container ──────────────────────────────────────────────
log "Creating container $CTID ($HOSTNAME)…"
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap "$SWAP" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},${IPCONFIG}" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --onboot 1

log "Starting container…"
pct start "$CTID"

# Give the network a moment to come up.
for _ in $(seq 1 15); do
  if pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1; then break; fi
  sleep 2
done

# ── Provision inside the container ────────────────────────────────────────────
[[ -f "$SCRIPT_DIR/install.sh" ]] || die "install.sh not found next to create-lxc.sh"

log "Copying install.sh into the container…"
pct push "$CTID" "$SCRIPT_DIR/install.sh" /root/install.sh --perms 0755

log "Running provisioning inside the container…"
pct exec "$CTID" -- env \
  REPO_URL="$REPO_URL" \
  REPO_REF="$REPO_REF" \
  GITHUB_TOKEN="$GITHUB_TOKEN" \
  BOOTSTRAP_ADMINS="$BOOTSTRAP_ADMINS" \
  DB_PASSWORD="$DB_PASSWORD" \
  bash /root/install.sh

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
log "Done. Container $CTID is up."
[[ -n "$IP" ]] && log "Open the web UI at: http://${IP}:3000"
log "Backend API: http://${IP:-<container-ip>}:8000"
