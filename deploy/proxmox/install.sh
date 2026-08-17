#!/usr/bin/env bash
#
# install.sh — Provision AI Image Interpreter inside a fresh Debian/Ubuntu LXC.
#
# Idempotent-ish: safe to re-run to pick up code changes. Installs system deps,
# PostgreSQL, the FastAPI backend, the Next.js frontend, and systemd units.
#
# Intended to be invoked by create-lxc.sh, but you can also run it by hand inside
# the container:
#
#   REPO_URL=... BOOTSTRAP_ADMINS=you@example.com bash install.sh
#
set -euo pipefail

# ── Config (env-overridable) ──────────────────────────────────────────────────
APP_USER="${APP_USER:-aivisio}"
APP_DIR="${APP_DIR:-/opt/ai-visio}"
REPO_URL="${REPO_URL:-https://github.com/justus4d4-dotcom/ai-visio}"
REPO_REF="${REPO_REF:-main}"
# For a private fork, supply a GitHub token with read-only Contents access. It is
# used only to fetch the code and is not written to disk.
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"

DB_NAME="${DB_NAME:-aiexams}"
DB_USER="${DB_USER:-aiexams}"
DB_PASSWORD="${DB_PASSWORD:-}"

BOOTSTRAP_ADMINS="${BOOTSTRAP_ADMINS:-}"
# Public origin(s) the browser uses to reach the frontend/backend. Defaults to
# the container's primary IP if left blank.
FRONTEND_ORIGINS="${FRONTEND_ORIGINS:-}"
API_URL="${API_URL:-}"

export DEBIAN_FRONTEND=noninteractive

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "must run as root inside the container."

PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
: "${FRONTEND_ORIGINS:=http://${PRIMARY_IP}:3000}"
: "${API_URL:=http://${PRIMARY_IP}:8000}"

# ── Secrets ───────────────────────────────────────────────────────────────────
gen_urlsafe() { python3 -c "import secrets; print(secrets.token_urlsafe(48))"; }
# On a re-run, reuse the DB password already stored in .env so the role ALTER
# below stays in sync with it (otherwise psycopg fails with "password
# authentication failed"). token_urlsafe never contains ':' or '@', so parsing
# the DATABASE_URL is safe.
if [[ -z "$DB_PASSWORD" && -f "$APP_DIR/backend/.env" ]]; then
  DB_PASSWORD="$(sed -n 's|^DATABASE_URL=postgresql+psycopg://[^:]*:\(.*\)@localhost.*|\1|p' "$APP_DIR/backend/.env")"
fi
[[ -n "$DB_PASSWORD" ]] || DB_PASSWORD="$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")"

# ── System packages ───────────────────────────────────────────────────────────
log "Installing system packages…"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg \
  python3 python3-venv python3-dev build-essential \
  postgresql postgresql-contrib

# Verify Python >= 3.12 (backend requires-python).
PYVER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)'; then
  die "Python $PYVER found, but the backend requires >= 3.12. Use an Ubuntu 24.04 template."
fi
log "Python $PYVER OK."

# Node.js + pnpm (via NodeSource).
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
if ! command -v pnpm >/dev/null 2>&1; then
  log "Installing pnpm…"
  npm install -g pnpm
fi

# ── Application user + code ───────────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user $APP_USER…"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# Build an authenticated fetch URL for private repos. The token is used only for
# the transfer; the remote stored in .git/config is the clean, tokenless URL.
# Fail fast instead of hanging on a credential prompt if auth is missing/wrong.
export GIT_TERMINAL_PROMPT=0
FETCH_URL="$REPO_URL"
if [[ -n "$GITHUB_TOKEN" ]]; then
  case "$REPO_URL" in
    https://github.com/*)
      FETCH_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL#https://github.com/}"
      ;;
    *)
      log "GITHUB_TOKEN set but REPO_URL is not an https://github.com/ URL — ignoring token."
      ;;
  esac
fi

if [[ -d "$APP_DIR/.git" ]]; then
  log "Updating existing checkout in $APP_DIR…"
  # The tree is owned by $APP_USER but we run git as root here — tell git it's safe.
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 "$FETCH_URL" "$REPO_REF"
  git -C "$APP_DIR" checkout -f "$REPO_REF" 2>/dev/null || true
  git -C "$APP_DIR" reset --hard FETCH_HEAD
  git -C "$APP_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
else
  log "Cloning $REPO_URL ($REPO_REF) into $APP_DIR…"
  mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$REPO_REF" "$FETCH_URL" "$APP_DIR"
  # Strip the token from the stored remote so it never lands on disk.
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── PostgreSQL ────────────────────────────────────────────────────────────────
log "Configuring PostgreSQL…"
systemctl enable --now postgresql

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL

# Create the database if it doesn't already exist. Force UTF8 via template0 —
# on an LXC with a broken/C locale the cluster defaults to SQL_ASCII, which makes
# psycopg3 return text as bytes and breaks SQLAlchemy. template0 lets us pick UTF8
# even when the cluster's default locale is C.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" \
    --encoding=UTF8 --template=template0 --lc-collate=C --lc-ctype=C "$DB_NAME"
fi

DATABASE_URL="postgresql+psycopg://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"

# ── Backend ───────────────────────────────────────────────────────────────────
log "Setting up backend…"
BACKEND_DIR="$APP_DIR/backend"
sudo -u "$APP_USER" python3 -m venv "$BACKEND_DIR/.venv"
sudo -u "$APP_USER" "$BACKEND_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$APP_USER" "$BACKEND_DIR/.venv/bin/pip" install -e "$BACKEND_DIR"

# Write the .env only if missing, so re-runs don't rotate secrets.
ENV_FILE="$BACKEND_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Writing backend .env (secrets generated)…"
  AUTH_SECRET="$(gen_urlsafe)"
  ENCRYPTION_KEY="$("$BACKEND_DIR/.venv/bin/python" -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
  install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<ENV
DATABASE_URL=${DATABASE_URL}
AUTH_SECRET=${AUTH_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
BOOTSTRAP_ADMINS=${BOOTSTRAP_ADMINS}
FRONTEND_ORIGINS=${FRONTEND_ORIGINS}
GITHUB_TOKEN=${GITHUB_TOKEN}
ENV
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
else
  log "Backend .env already exists — leaving secrets untouched."
fi

log "Running database migrations…"
( cd "$BACKEND_DIR" && sudo -u "$APP_USER" "$BACKEND_DIR/.venv/bin/alembic" upgrade head )

# ── Frontend ──────────────────────────────────────────────────────────────────
log "Building frontend (NEXT_PUBLIC_API_URL=${API_URL})…"
FRONTEND_DIR="$APP_DIR/frontend"
echo "NEXT_PUBLIC_API_URL=${API_URL}" | install -o "$APP_USER" -g "$APP_USER" -m 0644 /dev/stdin "$FRONTEND_DIR/.env.production"
( cd "$FRONTEND_DIR" && sudo -u "$APP_USER" pnpm install --frozen-lockfile 2>/dev/null || sudo -u "$APP_USER" pnpm install )
( cd "$FRONTEND_DIR" && sudo -u "$APP_USER" pnpm build )

# ── systemd units ─────────────────────────────────────────────────────────────
log "Installing systemd units…"
install -m 0644 "$APP_DIR/deploy/ai-visio-backend.service"  /etc/systemd/system/ai-visio-backend.service
install -m 0644 "$APP_DIR/deploy/ai-visio-frontend.service" /etc/systemd/system/ai-visio-frontend.service
systemctl daemon-reload
systemctl enable --now ai-visio-backend ai-visio-frontend
systemctl restart ai-visio-backend ai-visio-frontend

# ── In-app self-update ────────────────────────────────────────────────────────
# Allow the unprivileged backend to run ONLY the update script as root, so the
# "Update" button in Settings can pull a new release and restart the services.
if [[ -f "$APP_DIR/deploy/update.sh" ]]; then
  log "Configuring self-update (sudoers + update.sh)…"
  chmod +x "$APP_DIR/deploy/update.sh"
  install -m 0440 /dev/stdin /etc/sudoers.d/ai-visio-update <<SUDO
$APP_USER ALL=(root) NOPASSWD: $APP_DIR/deploy/update.sh
SUDO
  visudo -cf /etc/sudoers.d/ai-visio-update >/dev/null || {
    log "WARNING: sudoers validation failed — removing rule; in-app update disabled."
    rm -f /etc/sudoers.d/ai-visio-update
  }
else
  log "NOTE: deploy/update.sh not present — skipping in-app self-update wiring."
fi
log "  Frontend: ${FRONTEND_ORIGINS}"
log "  Backend:  ${API_URL}"
log "  DB user:  ${DB_USER}  (password stored in ${ENV_FILE})"
[[ -n "$BOOTSTRAP_ADMINS" ]] || log "  NOTE: BOOTSTRAP_ADMINS was empty — set it and re-run, or no one can sign in as admin."
