# Deployment (LXC + systemd)

Production deployment of **AI Image Interpreter** as two bare processes (FastAPI
backend + Next.js frontend) managed by systemd, with PostgreSQL 16 alongside, inside a
Debian/Ubuntu LXC container on the homeserver.

> The app is intended for your own LAN. Do not expose it to the public internet without
> a reverse proxy with TLS and additional auth.

## Automated Proxmox deployment (recommended)

Two scripts under [`proxmox/`](proxmox/) automate everything below:

- [`proxmox/create-lxc.sh`](proxmox/create-lxc.sh) — run **on the Proxmox host** (as
  root). Creates an unprivileged Ubuntu 24.04 LXC, starts it, and runs the provisioning
  script inside it.
- [`proxmox/install.sh`](proxmox/install.sh) — the in-container provisioning script
  (installs deps, PostgreSQL, backend, frontend, and systemd units). It is invoked
  automatically by `create-lxc.sh`, but can also be run by hand inside an existing
  container.

If you already have the repo checked out on the Proxmox host:

```bash
# On the Proxmox host
cd /path/to/ai-visio/deploy/proxmox
BOOTSTRAP_ADMINS=you@example.com ./create-lxc.sh
```

### Bootstrap from a bare Proxmox host (nothing checked out yet)

If the Proxmox host has **no copy of the repo**, pull the two deploy scripts straight
from the (private) repo with your GitHub token, then run `create-lxc.sh`. It clones the
rest of the code into the new container using the same token.

```bash
# On the Proxmox host, as root.
export GITHUB_TOKEN=github_pat_xxx          # fine-grained: Contents=Read, or classic: repo
REPO=justus4d4-dotcom/ai-visio
API="https://api.github.com/repos/${REPO}/contents/deploy/proxmox"

mkdir -p /root/ai-visio-deploy && cd /root/ai-visio-deploy
for f in create-lxc.sh install.sh; do
  curl -fsSL \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.raw" \
    "${API}/${f}?ref=main" -o "$f"
done
chmod +x create-lxc.sh

# Create the unprivileged LXC and provision backend + frontend + PostgreSQL.
BOOTSTRAP_ADMINS=you@example.com ./create-lxc.sh
```

The GitHub API `contents` endpoint (with `Accept: application/vnd.github.raw`) works for
private repos, unlike the plain `raw.githubusercontent.com` URL. The token is only used
to fetch code — `install.sh` rewrites the container's git remote to the tokenless URL,
so the PAT is never persisted on disk. When it finishes it prints the container IP; open
`http://<container-ip>:3000`.

### Private repository access

This is a **private** repo, so the container needs credentials to fetch the code.
Pick one of the following.

**Option A — GitHub token (simplest).** Create a Personal Access Token with read-only
access to the repo (fine-grained PAT with **Contents: Read**, or a classic PAT with the
`repo` scope), then pass it via `GITHUB_TOKEN`:

```bash
# On the Proxmox host
GITHUB_TOKEN=github_pat_xxx BOOTSTRAP_ADMINS=you@example.com ./create-lxc.sh
```

The token is used only to fetch the code and is **not** written to disk — the stored
git remote is rewritten to the tokenless URL after cloning. (Interactive credential
prompts are disabled, so a missing/invalid token fails fast instead of hanging.)

**Option B — no clone at all (offline copy).** Create the container, then copy your
local working tree straight in and run `install.sh` (which will reuse the existing
checkout instead of cloning):

```bash
# On the Proxmox host, from your local repo checkout
pct create 110 local:vztmpl/ubuntu-24.04-standard_*.tar.zst \
  --hostname ai-visio --cores 2 --memory 2048 --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1
pct start 110
# Push the code (exclude local build/venv artifacts) and provision
tar --exclude .git --exclude '**/.venv' --exclude '**/node_modules' \
    --exclude '**/.next' -czf - -C /path/to/ai-visio . \
  | pct exec 110 -- bash -c 'mkdir -p /opt/ai-visio && tar -xzf - -C /opt/ai-visio'
pct push 110 deploy/proxmox/install.sh /root/install.sh --perms 0755
pct exec 110 -- env BOOTSTRAP_ADMINS=you@example.com bash /root/install.sh
```

**Option C — SSH deploy key.** Add a read-only deploy key to the repo and switch
`REPO_URL` to the SSH form (`git@github.com:owner/repo.git`), placing the private key
at `/root/.ssh/id_ed25519` inside the container before running `install.sh`.

Common overrides (all optional env vars):

| Variable            | Default                          | Purpose                                  |
| ------------------- | -------------------------------- | ---------------------------------------- |
| `CTID`              | `110`                            | Container ID                             |
| `HOSTNAME`          | `ai-visio`                       | Container hostname                       |
| `CORES` / `MEMORY`  | `2` / `2048`                     | CPU cores / RAM (MB)                     |
| `DISK_GB`           | `8`                              | Root disk size                           |
| `STORAGE`           | `local-lvm`                      | Proxmox storage for the rootfs           |
| `BRIDGE`            | `vmbr0`                          | Network bridge                           |
| `IPCONFIG`          | `ip=dhcp`                        | e.g. `ip=192.0.2.10/24,gw=192.0.2.10` |
| `REPO_URL`/`REPO_REF` | GitHub repo / `main`           | Source to deploy                         |
| `GITHUB_TOKEN`      | *(empty)*                        | PAT for cloning a private repo           |
| `BOOTSTRAP_ADMINS`  | *(empty)*                        | Comma-separated admin emails             |
| `DB_PASSWORD`       | *(auto-generated)*               | PostgreSQL password                      |

`install.sh` auto-generates `AUTH_SECRET`, `ENCRYPTION_KEY`, and (if unset) the DB
password, writing them to `/opt/ai-visio/backend/.env` (mode `0600`). It bakes the
container's primary IP into `NEXT_PUBLIC_API_URL` / `FRONTEND_ORIGINS`; override with
`API_URL` and `FRONTEND_ORIGINS` if you front the app with a reverse proxy or DNS name.

The manual steps below document what these scripts do, in case you want to run them
by hand or adapt them to another host.

## 1. LXC container

Create an unprivileged Debian 12 / Ubuntu 24.04 container (Proxmox example):

```bash
# On the Proxmox host
pct create 110 local:vztmpl/debian-12-standard_*.tar.zst \
  --hostname ai-visio --cores 2 --memory 2048 --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1
pct start 110
pct enter 110
```

Inside the container, install dependencies:

```bash
apt update && apt install -y \
  python3.12 python3.12-venv git curl ca-certificates postgresql postgresql-contrib

# Node 20 + pnpm for the frontend
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pnpm
```

## 2. Application user + code

```bash
useradd --system --create-home --shell /usr/sbin/nologin aivisio
mkdir -p /opt/ai-visio && chown aivisio:aivisio /opt/ai-visio
git clone https://github.com/justus4d4-dotcom/ai-visio /opt/ai-visio
chown -R aivisio:aivisio /opt/ai-visio
```

## 3. PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER aiexams WITH PASSWORD 'change-this-db-pass';
CREATE DATABASE aiexams OWNER aiexams;
SQL
```

## 4. Backend

```bash
cd /opt/ai-visio/backend
sudo -u aivisio python3.12 -m venv .venv
sudo -u aivisio .venv/bin/pip install -e .

# Secrets file (mode 0600). Generate strong keys:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"   # AUTH_SECRET
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # ENCRYPTION_KEY
sudo -u aivisio tee /opt/ai-visio/backend/.env >/dev/null <<'ENV'
DATABASE_URL=postgresql+psycopg://aiexams:change-this-db-pass@localhost:5432/aiexams
AUTH_SECRET=change-me
ENCRYPTION_KEY=change-me
FRONTEND_ORIGINS=http://ai-visio.local:3000
ENV
chmod 600 /opt/ai-visio/backend/.env

# Run migrations
sudo -u aivisio .venv/bin/alembic upgrade head
```

## 5. Frontend

```bash
cd /opt/ai-visio/frontend
sudo -u aivisio pnpm install
# NEXT_PUBLIC_API_URL is baked in at build time — point it at the backend.
echo 'NEXT_PUBLIC_API_URL=http://ai-visio.local:8000' | sudo -u aivisio tee .env.production
sudo -u aivisio pnpm build
```

## 6. systemd units

```bash
cp /opt/ai-visio/deploy/ai-visio-backend.service  /etc/systemd/system/
cp /opt/ai-visio/deploy/ai-visio-frontend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-visio-backend ai-visio-frontend

systemctl status ai-visio-backend ai-visio-frontend
journalctl -u ai-visio-backend -f
```

The backend listens on `:8000`, the frontend on `:3000`. Open
`http://<container-ip>:3000` from the MacBook, add your Gemini API key in **Settings**,
and set the ESP32 device IP under **Devices**.

## 6b. Public demo over Cloudflare Tunnel (`visio.example.com`)

For a public demo — and to make the **iPhone camera** capture source work — the app must
be served over HTTPS: iOS only grants `getUserMedia` (camera) access in a secure context.
A Cloudflare Tunnel provides that TLS with no self-signed certs, and lets us serve the
whole app under **one** hostname so there is no CORS or mixed-content to manage.

The tunnel routes **same-origin**: everything under `/api` (including the ESP32 WebSocket
at `/api/remote/ws`) goes to the FastAPI backend, everything else to Next.js. All frontend
requests already target `${NEXT_PUBLIC_API_URL}/api/...`, so pointing that base URL at the
public hostname is enough.

**1. Tunnel ingress.** A ready-made config lives at
[`cloudflared/config.yml`](cloudflared/config.yml). If you already run `cloudflared` on
the host, either merge its two `ingress` rules into your existing config, or add a
**Public Hostname** in the Zero Trust dashboard for a remotely-managed tunnel:

| Path        | Service                  |
| ----------- | ------------------------ |
| `/api/*`    | `http://localhost:8000`  |
| *(default)* | `http://localhost:3000`  |

Point DNS at the tunnel once: `cloudflared tunnel route dns <tunnel> visio.example.com`.

**2. App env must match the public hostname.** Because `NEXT_PUBLIC_API_URL` is baked in
at build time, rebuild the frontend after changing it:

```bash
# Backend: allow the public origin (same-origin, but set it explicitly)
sudo -u aivisio sed -i \
  's#^FRONTEND_ORIGINS=.*#FRONTEND_ORIGINS=https://visio.example.com#' \
  /opt/ai-visio/backend/.env
systemctl restart ai-visio-backend

# Frontend: same-origin API base, then rebuild + restart
echo 'NEXT_PUBLIC_API_URL=https://visio.example.com' \
  | sudo -u aivisio tee /opt/ai-visio/frontend/.env.production
cd /opt/ai-visio/frontend && sudo -u aivisio pnpm build
systemctl restart ai-visio-frontend
```

The backend already runs with `--proxy-headers` (see the unit), so it honours Cloudflare's
`X-Forwarded-Proto`/`-For`. Nothing needs to bind publicly — only `cloudflared` reaches
`:3000`/`:8000` on localhost.

**3. Use it.** Open `https://visio.example.com` on the desktop and pick the
**iPhone** capture source; on the phone open `https://visio.example.com/camera`,
aim at the screen, drag the four corners, and **Start streaming**.

## 7. Upgrades

### In-app auto-update (recommended)

The web UI can update the running deployment to the latest **GitHub Release** from
**Settings → Update**. That section shows the installed version vs. the latest release,
release notes and history, and an **Update** button that fetches the release, runs
migrations, rebuilds the frontend and restarts both services — streaming the log live.

Two things must be configured on the container for this to work:

**a) A read-only GitHub token** so the backend can list releases and pull the private
repo. Add it to the backend `.env` (fine-grained PAT with **Contents: Read**, or a
classic PAT with the `repo` scope):

```bash
echo 'GITHUB_TOKEN=github_pat_xxx' | sudo -u aivisio tee -a /opt/ai-visio/backend/.env
chmod 600 /opt/ai-visio/backend/.env
systemctl restart ai-visio-backend
```

**b) A scoped sudoers rule.** The backend runs unprivileged as `aivisio`, but the
update ([`deploy/update.sh`](update.sh)) must run as root (git pull, pip/alembic,
systemd). Grant `aivisio` permission to run **only** that one script as root:

```bash
chmod +x /opt/ai-visio/deploy/update.sh
cat >/etc/sudoers.d/ai-visio-update <<'SUDO'
aivisio ALL=(root) NOPASSWD: /opt/ai-visio/deploy/update.sh
SUDO
chmod 0440 /etc/sudoers.d/ai-visio-update
visudo -cf /etc/sudoers.d/ai-visio-update   # validate syntax
```

The backend launches `sudo -n /opt/ai-visio/deploy/update.sh <release-tag>` detached in
a new session (so it survives the backend restart it performs) and passes `GITHUB_TOKEN`
through the environment. The requested tag is validated against the list of known
release tags and a strict allowlist regex before being passed as an argv (no shell), so
the endpoint can't be used to run arbitrary refs. Progress is written to
`/opt/ai-visio/update.log`, which the UI polls via `GET /api/updates/progress`.

Set `UPDATE_ENABLED=false` in the backend `.env` to disable the feature (the Update
button is then greyed out).

### Release workflow

The updater targets **GitHub Releases**, so cut a release for each version you want to
ship:

1. Tag the commit and push (e.g. `git tag v1.2.0 && git push origin v1.2.0`).
2. Create a **Release** for that tag on GitHub and write the release notes in its body
   (they render in the Update panel). Mark it *pre-release* to keep it out of the
   "latest" comparison.

The container updates to the newest non-pre-release tag.

### Manual upgrade (fallback)

```bash
sudo /opt/ai-visio/deploy/update.sh v1.2.0     # or any release tag
# …or the old by-hand steps:
cd /opt/ai-visio && sudo -u aivisio git pull
cd backend  && sudo -u aivisio .venv/bin/pip install -e . && sudo -u aivisio .venv/bin/alembic upgrade head
cd ../frontend && sudo -u aivisio pnpm install && sudo -u aivisio pnpm build
systemctl restart ai-visio-backend ai-visio-frontend
```

## Monitoring

The web UI exposes an LLM **Monitoring** dashboard (`/usage`) backed by
`GET /api/usage/summary`, showing token usage and estimated Gemini cost (today / last 7
days / all time) plus per-day and per-model breakdowns. Costs are estimates derived from
public Gemini list prices in `backend/app/pricing.py`; cache hits are recorded at $0.
