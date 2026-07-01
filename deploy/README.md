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

```bash
# On the Proxmox host
cd /path/to/ai-visio/deploy/proxmox
BOOTSTRAP_ADMINS=you@example.com ./create-lxc.sh
```

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

## 7. Upgrades

```bash
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
