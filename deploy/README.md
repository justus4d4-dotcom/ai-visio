# Deployment (LXC + systemd)

Production deployment of **AI Image Interpreter** as two bare processes (FastAPI
backend + Next.js frontend) managed by systemd, with PostgreSQL 16 alongside, inside a
Debian/Ubuntu LXC container on the homeserver.

> The app is intended for your own LAN. Do not expose it to the public internet without
> a reverse proxy with TLS and additional auth.

## 1. LXC container

Create an unprivileged Debian 12 / Ubuntu 24.04 container (Proxmox example):

```bash
# On the Proxmox host
pct create 110 local:vztmpl/debian-12-standard_*.tar.zst \
  --hostname ai-exams --cores 2 --memory 2048 --swap 512 \
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
useradd --system --create-home --shell /usr/sbin/nologin aiexams
mkdir -p /opt/ai-exams && chown aiexams:aiexams /opt/ai-exams
git clone https://github.com/justus4d4-dotcom/ai-visio /opt/ai-exams
chown -R aiexams:aiexams /opt/ai-exams
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
cd /opt/ai-exams/backend
sudo -u aiexams python3.12 -m venv .venv
sudo -u aiexams .venv/bin/pip install -e .

# Secrets file (mode 0600). Generate strong keys:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"   # AUTH_SECRET
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # ENCRYPTION_KEY
sudo -u aiexams tee /opt/ai-exams/backend/.env >/dev/null <<'ENV'
DATABASE_URL=postgresql+psycopg://aiexams:change-this-db-pass@localhost:5432/aiexams
AUTH_SECRET=change-me
ENCRYPTION_KEY=change-me
FRONTEND_ORIGINS=http://ai-exams.local:3000
ENV
chmod 600 /opt/ai-exams/backend/.env

# Run migrations
sudo -u aiexams .venv/bin/alembic upgrade head
```

## 5. Frontend

```bash
cd /opt/ai-exams/frontend
sudo -u aiexams pnpm install
# NEXT_PUBLIC_API_URL is baked in at build time — point it at the backend.
echo 'NEXT_PUBLIC_API_URL=http://ai-exams.local:8000' | sudo -u aiexams tee .env.production
sudo -u aiexams pnpm build
```

## 6. systemd units

```bash
cp /opt/ai-exams/deploy/ai-exams-backend.service  /etc/systemd/system/
cp /opt/ai-exams/deploy/ai-exams-frontend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-exams-backend ai-exams-frontend

systemctl status ai-exams-backend ai-exams-frontend
journalctl -u ai-exams-backend -f
```

The backend listens on `:8000`, the frontend on `:3000`. Open
`http://<container-ip>:3000` from the MacBook, add your Gemini API key in **Settings**,
and set the ESP32 device IP under **Devices**.

## 7. Upgrades

```bash
cd /opt/ai-exams && sudo -u aiexams git pull
cd backend  && sudo -u aiexams .venv/bin/pip install -e . && sudo -u aiexams .venv/bin/alembic upgrade head
cd ../frontend && sudo -u aiexams pnpm install && sudo -u aiexams pnpm build
systemctl restart ai-exams-backend ai-exams-frontend
```

## Monitoring

The web UI exposes an LLM **Monitoring** dashboard (`/usage`) backed by
`GET /api/usage/summary`, showing token usage and estimated Gemini cost (today / last 7
days / all time) plus per-day and per-model breakdowns. Costs are estimates derived from
public Gemini list prices in `backend/app/pricing.py`; cache hits are recorded at $0.
