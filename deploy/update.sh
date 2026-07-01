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

# Send everything to the log (and stdout) from here on.
exec > >(tee -a "$UPDATE_LOG") 2>&1

marker() { printf 'AI-VISIO-UPDATE: %s\n' "$*"; }
log() { printf '\033[1;34m[update]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[update] ERROR:\033[0m %s\n' "$*" >&2; marker "FAILED"; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "must run as root (via sudo)."
[[ -n "$TARGET_REF" ]] || fail "no target ref given."
# Defence in depth: the backend already validates the ref, but re-check here.
[[ "$TARGET_REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || fail "invalid target ref: $TARGET_REF"
[[ -d "$APP_DIR/.git" ]] || fail "no git checkout at $APP_DIR."

marker "START ${TARGET_REF}"
log "Updating $APP_DIR to ${TARGET_REF}…"

export GIT_TERMINAL_PROMPT=0

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

marker "SUCCESS"
log "Update to ${TARGET_REF} complete — restarting services…"
# Restart last. This kills this script's parent (the backend), but because we run in a
# new session (setsid) the restart still completes. Detach so a backend restart can't
# interrupt the frontend restart mid-flight.
systemctl restart ai-visio-frontend
systemctl restart ai-visio-backend
