# AI Image Interpreter

Self-hosted assistant that captures a region of a shared MacBook screen, sends the
image to a vision LLM (bring-your-own-key) for interpretation, and pushes the result
to a round **Waveshare ESP32-S3-Touch-LCD-1.28** display in real time.

```
MacBook browser ──getDisplayMedia──▶ Next.js UI ──frames──▶ FastAPI
                                                              │
                                       dedup (sha256) ────────┤
                                       Google Gemini ─────────┤
                                                              ▼
                                              WebSocket push ──▶ ESP32-S3 round display
                                                              │
                                                          PostgreSQL (users, keys, history)
```

## Repository layout

| Path        | What it is                                                              |
| ----------- | ----------------------------------------------------------------------- |
| `backend/`  | FastAPI app: OCR, BYOK LLM client, auth, WebSocket hub, REST API        |
| `frontend/` | Next.js 16 / React 19 UI: screen capture, history, device + admin pages |
| `agent/`    | Native macOS screen-capture agent (headless alternative to the Chrome tab) |
| `firmware/` | PlatformIO ESP32-S3 + LVGL firmware for the round display               |
| `deploy/`   | systemd units + setup notes for running inside the LXC container        |

## How it works

1. You open the web app on the MacBook and click **Start capture**, sharing the window
   you want interpreted. Frames are grabbed every few seconds in the browser.
2. Each frame is sent to FastAPI and forwarded to **Google Gemini** image understanding
   (no local OCR). Identical frames are de-duplicated (sha256) so the same image is
   never sent twice.
3. Gemini interprets the image and returns a concise result using **your** Gemini API
   key. To keep costs low the default model is `gemini-2.5-flash-lite`, "thinking" is
   disabled, and frames are downscaled before sending.
4. The result (a short label + text + confidence) is stored in Postgres and
   **pushed over WebSocket** to the configured ESP32 display, which renders it on the
   round screen.

## Quick start (development)

```bash
# 1. Postgres
docker run -d --name aiexams-pg -e POSTGRES_PASSWORD=aiexams \
  -e POSTGRES_DB=aiexams -p 5432:5432 postgres:16

# 2. Backend
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e .
cp .env.example .env            # edit secrets
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# 3. Frontend
cd ../frontend
pnpm install
cp .env.example .env.local      # edit Google OAuth + API URL
pnpm dev                        # http://localhost:3000
```

System OCR dependency (Debian/Ubuntu LXC):

```bash
# No system OCR needed — images go directly to Gemini.
```

## Production (LXC + systemd)

See [deploy/README.md](deploy/README.md).

## Firmware

See [firmware/README.md](firmware/README.md). The device runs a WiFi captive portal on
first boot; enter your WiFi and the server address, then set the device IP in the web UI
under **Devices**.

## Security notes

- API keys are encrypted at rest (Fernet) before being written to Postgres.
- Only whitelisted Google accounts can sign in; an **Admin** can add/remove emails.
- The app is intended for your own LAN; do not expose it to the public internet without
  putting it behind a reverse proxy with TLS and additional auth.
