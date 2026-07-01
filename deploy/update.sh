#!/usr/bin/env bash
#
# update.sh — Update an existing AI Image Interpreter deployment to a release ref.
#
# Triggered by the backend (POST /api/updates/apply) via a scoped sudoers rule, or
# run by hand:  sudo /opt/ai-visio/deploy/update.sh v1.2.3
#
# It fetches the requested git ref (a release tag/branch), reinstalls backend deps,
# runs DB migrations, rebuilds the frontend, and restarts both systemd services.
# All output is tee'd to $UPDATE_LOG with machine-readable markers the backend polls:
#   AI-VISIO-UPDATE: START <ref>
#   AI-VISIO-UPDATE: SUCCESS   (on success)
#   AI-VISIO-UPDATE: FAILED    (on any failure)
#
set -uo pipefail

# ── Config (env-overridable, matching install.sh) ─────────────────────────────
APP_USER="${APP_USER:-aivisio}"
APP_DIR="${APP_DIR:-/opt/ai-visio}"
REPO_URL="${REPO_URL:-https://github.com/justus4d4-dotcom/ai-visio}"
# Read-only token for private-repo pulls. The backend passes it through the env; it
# is used only for the fetch and never written to the stored git remote.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
UPDATE_LOG="${UPDATE_LOG:-${APP_DIR}/update.log}"

# Fall back to the token already stored in the backend .env, so a manual
# `sudo update.sh <ref>` works without re-passing GITHUB_TOKEN on the command line.
if [[ -z "$GITHUB_TOKEN" && -f "${APP_DIR}/backend/.env" ]]; then
  GITHUB_TOKEN="$(sed -n 's/^[[:space:]]*GITHUB_TOKEN[[:space:]]*=[[:space:]]*//p' "${APP_DIR}/backend/.env" | tail -n1 | tr -d '"'"'"'\r')"
fi

TARGET_REF="${1:-}"

# Must be root (systemd-run + systemctl below need it).
[[ "$(id -u)" -eq 0 ]] || { echo "update.sh: must run as root (via sudo)." >&2; exit 1; }

# ── Detach from the caller's cgroup ───────────────────────────────────────
# The backend spawns this script inside the ai-visio-backend systemd cgroup. Since the
# script restarts that very service at the end, a plain child would be SIGKILLed by
# systemd mid-flight, leaving no SUCCESS/FAILED marker (the UI then hangs on
# "Updating…"). Re-exec once as a transient systemd unit so we run in our own cgroup
# and always finish, independent of the backend restart.
if [[ -z "${AI_VISIO_DETACHED:-}" ]] && command -v systemd-run >/dev/null 2>&1; then
  exec systemd-run --collect --quiet --unit="ai-visio-update-$(date +%s)" \
    --setenv=AI_VISIO_DETACHED=1 \
    --setenv=GITHUB_TOKEN="$GITHUB_TOKEN" \
    --setenv=REPO_URL="$REPO_URL" \
    --setenv=APP_DIR="$APP_DIR" \
    --setenv=APP_USER="$APP_USER" \
    --setenv=UPDATE_LOG="$UPDATE_LOG" \
    "$0" "$TARGET_REF"
fi

# Send everything to the log (and stdout) from here on.
exec > >(tee -a "$UPDATE_LOG") 2>&1

marker() { printf 'AI-VISIO-UPDATE: %s\n' "$*"; }
log() { printf '\033[1;34m[update]\033[0m %s\n' "$*"; }

# Guarantee exactly one terminal marker on every exit path (except SIGKILL/OOM, which
# the backend catches via a staleness timeout). Without this a mid-run crash leaves the
# log at START and the UI spins forever.
_marked=0
fail() { printf '\033[1;31m[update] ERROR:\033[0m %s\n' "$*" >&2; _marked=1; marker "FAILED"; exit 1; }
trap '[[ "$_marked" -eq 1 ]] || marker "FAILED"' EXIT
trap 'exit 143' TERM INT   # run the EXIT trap on SIGTERM instead of dying silently

[[ -n "$TARGET_REF" ]] || fail "no target ref given."
# Defence in depth: the backend already validates the ref, but re-check here.
[[ "$TARGET_REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || fail "invalid target ref: $TARGET_REF"
[[ -d "$APP_DIR/.git" ]] || fail "no git checkout at $APP_DIR."

marker "START ${TARGET_REF}"
log "Updating $APP_DIR to ${TARGET_REF}…"

export GIT_TERMINAL_PROMPT=0

# The checkout is owned by $APP_USER but we run as root, so git would refuse with
# "detected dubious ownership". Mark it safe system-wide (/etc/gitconfig) so it works
# regardless of which HOME the updater runs under (e.g. via systemd-run). Idempotent.
git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR" \
  || git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true

# Build an authenticated fetch URL for private repos; keep the token off disk.
FETCH_URL="$REPO_URL"
if [[ -n "$GITHUB_TOKEN" ]]; then
  case "$REPO_URL" in
    https://github.com/*)
      FETCH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL#https://github.com/}"
      ;;
  esac
fi

# ── Fetch + checkout the target ref ───────────────────────────────────────────
log "Fetching ${TARGET_REF}…"
git -C "$APP_DIR" fetch --tags --force "$FETCH_URL" "$TARGET_REF" || fail "git fetch failed."
git -C "$APP_DIR" checkout -f "$TARGET_REF" 2>/dev/null \
  || git -C "$APP_DIR" checkout -f FETCH_HEAD || fail "git checkout failed."
git -C "$APP_DIR" reset --hard FETCH_HEAD || fail "git reset failed."
git -C "$APP_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── Backend deps + migrations ─────────────────────────────────────────────────
BACKEND_DIR="$APP_DIR/backend"
log "Installing backend dependencies…"
sudo -u "$APP_USER" "$BACKEND_DIR/.venv/bin/pip" install -e "$BACKEND_DIR" \
  || fail "pip install failed."
log "Running database migrations…"
( cd "$BACKEND_DIR" && sudo -u "$APP_USER" "$BACKEND_DIR/.venv/bin/alembic" upgrade head ) \
  || fail "alembic upgrade failed."

# ── Frontend build ────────────────────────────────────────────────────────────
FRONTEND_DIR="$APP_DIR/frontend"
log "Building frontend…"
( cd "$FRONTEND_DIR" && sudo -u "$APP_USER" pnpm install --frozen-lockfile 2>/dev/null \
  || sudo -u "$APP_USER" pnpm install ) || fail "pnpm install failed."
( cd "$FRONTEND_DIR" && sudo -u "$APP_USER" pnpm build ) || fail "pnpm build failed."

# ── Refresh systemd units + restart ───────────────────────────────────────────
log "Reinstalling systemd units…"
install -m 0644 "$APP_DIR/deploy/ai-visio-backend.service"  /etc/systemd/system/ai-visio-backend.service
install -m 0644 "$APP_DIR/deploy/ai-visio-frontend.service" /etc/systemd/system/ai-visio-frontend.service
systemctl daemon-reload

_marked=1
marker "SUCCESS"
log "Update to ${TARGET_REF} complete — restarting services…"
# We run as a transient systemd unit (see top), so restarting ai-visio-backend here
# cannot kill this script — it completes in its own cgroup.
systemctl restart ai-visio-frontend
systemctl restart ai-visio-backend
