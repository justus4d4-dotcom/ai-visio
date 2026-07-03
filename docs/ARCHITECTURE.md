# AI VISIO — Technical Architecture

A screen-aware, multiple-choice exam solver. A screen frame (from the browser's own
screen-share **or** a native macOS agent) is sent to **Google Gemini** (bring-your-own-key),
which returns a structured answer that is shown in the web UI and pushed to an **ESP32-S3
touch display**.

---

## 1. System context & components

```mermaid
flowchart TB
    subgraph Client["User devices"]
        Browser["Web UI — Next.js/React<br/>(BYOK Gemini key, screen share,<br/>Settings / History / Usage / Update)"]
        Agent["Native macOS Agent — Python<br/>(captures the whole screen,<br/>streams frames + heartbeats)"]
        ESP32["ESP32-S3 round touch display<br/>(touch to trigger, shows the answer)"]
    end

    subgraph LXC["Proxmox LXC container (Ubuntu 24.04) — systemd"]
        FE["ai-visio-frontend.service<br/>Next.js :3000"]
        BE["ai-visio-backend.service<br/>FastAPI / uvicorn :8000 (1 worker)"]
        DB[("PostgreSQL 16 :5432<br/>history · usage events")]
    end

    Gemini["Google Gemini API<br/>generativelanguage.googleapis.com"]
    GitHub["GitHub Releases<br/>(private repo, self-update)"]

    Browser -- "HTTP :3000 (page)" --> FE
    Browser -- "HTTP :8000 /api/*" --> BE
    Agent   -- "POST /api/remote/frame · heartbeat" --> BE
    ESP32   -- "POST /api/remote/trigger · GET /api/remote/answer" --> BE

    BE -- "solve image (per-request BYOK key)" --> Gemini
    BE -- "read/write" --> DB
    BE -- "GET releases · pull code" --> GitHub

    classDef box fill:#0b3d5c,stroke:#38bdf8,color:#e2e8f0;
    class Browser,Agent,ESP32,FE,BE,DB,Gemini,GitHub box;
```

| Component | Tech | Responsibility |
|---|---|---|
| **Web UI** | Next.js 16 / React / TS / Tailwind | Holds the Gemini API key (BYOK, `localStorage`), captures/forwards frames, triggers solves, renders answers, Settings (incl. fine-tuning), History, Usage, and in-app Update. |
| **Backend** | FastAPI + uvicorn (Python 3.12), **single worker** | Solve orchestration, Gemini calls, remote-control bridge (ESP32 ⇄ browser), history/usage persistence, self-update. |
| **Native agent** | Python | Streams the whole macOS screen to the backend so solving needs no per-tab browser share; sends heartbeats. |
| **ESP32-S3** | Arduino / LovyanGFX | Physical trigger + answer display over Wi-Fi. |
| **PostgreSQL 16** | — | Solve history and metered usage events (for the cost dashboard). |
| **Google Gemini** | `google-genai` SDK | Vision model that reads the question and returns a structured answer. |

> The backend runs **exactly one uvicorn worker** on purpose: the remote-control bridge
> (trigger state, agent registry, latest frame, WebSocket hub) lives in **per-process
> memory**. Multiple workers would each hold a divergent view and cause flapping.

---

## 2. Capture sources

There are three ways a screen frame reaches the solver. The active source is tracked in the
backend (`/api/remote/source`) and defaults to **agent**.

```mermaid
flowchart LR
    subgraph AgentMode["Agent mode (default)"]
        A1["Agent captures full screen"] -->|POST /api/remote/frame| A2["Backend: latest frame<br/>(in-memory, per owner)"]
        A2 -->|GET /api/remote/frame| A3["Browser fetches frame<br/>then POSTs /api/solve"]
    end

    subgraph CameraMode["iPhone camera mode"]
        C1["Phone rear camera at the screen<br/>(/camera page): crop + deskew"] -->|POST /api/remote/camera/frame| C2["Backend: latest camera frame<br/>(in-memory)"]
        C2 -->|GET /api/remote/camera/frame| C3["Browser fetches frame<br/>then POSTs /api/solve"]
    end

    subgraph BrowserMode["Browser mode"]
        B1["getDisplayMedia() screen share<br/>in the Chrome tab"] --> B2["Browser grabs a frame<br/>then POSTs /api/solve"]
    end
```

- The **browser always performs the solve** because it holds the BYOK Gemini key — even
  in agent/camera mode the recording device only pushes frames; it never needs the key.
- `GET /api/remote/frame` and `/api/remote/camera/frame` return **`204 No Content`** when
  no fresh frame exists (not `404`), so ~1 fps preview polling doesn't spam the console.
- The **iPhone camera** page warps the user-selected screen quad back to a flat rectangle
  (perspective/keystone correction, `frontend/lib/warp.ts`) before uploading, so Gemini
  reads a screenshot-like image. iOS requires the page to be served over **HTTPS** for
  `getUserMedia` to grant camera access.

---

## 3. Solve request flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User / auto-detect
    participant W as Web UI (browser)
    participant B as Backend :8000
    participant G as Gemini API
    participant D as PostgreSQL

    U->>W: trigger a solve (button / stable-frame change)
    alt agent mode
        W->>B: GET /api/remote/frame
        B-->>W: latest JPEG (or 204)
    else browser mode
        W->>W: grab frame from screen share
    end
    W->>B: POST /api/solve (image + provider config JSON: key, model, tuning)
    B->>B: downscale to max_edge (Pillow), dedup by perceptual hash
    loop model ladder (flash-lite → flash), capped, optional
        B->>G: generateContent(image, prompt, media_resolution, thinking, temp)
        G-->>B: structured JSON answer (or 429/503 → short retry)
    end
    B->>D: record usage event (tokens, est. cost)
    B->>D: save readable answer to history
    B-->>W: SolveResult (answer letters/text, confidence, cost, timing)
    W-->>U: render answer
```

**Quality/speed knobs** (Settings → Fine-tuning; sent per request in the BYOK config):
`model`, `max_edge` (image size), `media_resolution` (low/medium/high), `temperature`,
`thinking_budget`, `max_output_tokens`, `system_prompt`, `extra_context`, and
`auto_escalate` (retry with a stronger model when a frame is unreadable).

---

## 4. ESP32 trigger ⇄ answer bridge

The screenshot lives in the browser, so the ESP32 can't capture it. The backend is a
small in-memory relay between the device and the browser.

```mermaid
sequenceDiagram
    autonumber
    participant E as ESP32-S3
    participant B as Backend (/api/remote)
    participant W as Web UI (browser)

    E->>B: POST /api/remote/trigger  (touch)
    W->>B: GET /api/remote/poll      (browser polls)
    B-->>W: { triggered: true }
    W->>W: capture + solve (see §3)
    W->>B: POST /api/remote/status "solving" → POST /api/remote/answer
    B-->>W: broadcast via WebSocket hub
    E->>B: GET /api/remote/answer    (device polls)
    B-->>E: { status, answer }
    E->>E: render the answer on the display
```

---

## 5. Backend API surface

```mermaid
flowchart LR
    subgraph Backend["FastAPI routers (app.main)"]
        solve["/api/solve"]
        providers["/api/providers/*<br/>test · default-prompt"]
        remote["/api/remote/*<br/>frame · trigger · poll · answer · source · ws"]
        history["/api/history*"]
        usage["/api/usage/summary"]
        updates["/api/updates/*<br/>status · progress · apply"]
        health["/health · /api/info"]
    end
    solve --> gem["gemini.py<br/>(google-genai)"]
    providers --> gem
    history --> pg[("PostgreSQL")]
    usage --> pg
    remote --> mem["in-memory bridge<br/>(state · agents · frame · hub)"]
    updates --> upd["updates.py → deploy/update.sh"]
```

Secrets & config live in `backend/.env` (mode `0600`, gitignored): `DATABASE_URL`,
`AUTH_SECRET`, `ENCRYPTION_KEY`, `FRONTEND_ORIGINS`, `GITHUB_TOKEN`. The **Gemini key is
never stored server-side** — it travels per solve request from the browser.

---

## 6. Deployment topology

```mermaid
flowchart TB
    subgraph Host["Proxmox VE host"]
        subgraph CT["LXC container (unprivileged, Ubuntu 24.04)"]
            direction TB
            sysd["systemd (PID 1)"]
            feUnit["ai-visio-frontend.service → next start :3000"]
            beUnit["ai-visio-backend.service → uvicorn :8000 (1 worker)"]
            pg["postgresql.service :5432"]
            code["/opt/ai-visio (git checkout, owned by aivisio)"]
            env["/opt/ai-visio/backend/.env (0600)"]
            sudoers["/etc/sudoers.d/ai-visio-update"]
            sysd --> feUnit
            sysd --> beUnit
            sysd --> pg
        end
    end
    LAN(["Home LAN"]) --- CT
    Browser2["Browser @ MacBook"] --- LAN
    ESP["ESP32-S3"] --- LAN

    note1["Provisioned by deploy/proxmox/{create-lxc,install}.sh<br/>Static IP or DHCP reservation recommended"]
```

- **Ports:** frontend `:3000`, backend `:8000`, PostgreSQL `:5432` (LAN only).
- **Auto-start:** all three units are `enabled` → they come back after a container reboot;
  set the container's `onboot=1` for host reboots.
- `NEXT_PUBLIC_API_URL` is **baked into the frontend build** → it must match the
  container's IP:8000.

---

## 7. Self-update & release pipeline

GitHub **Actions are disabled org-wide**, so releases are cut from a dev machine via the
GitHub REST API, and the container updates itself to a chosen release tag.

```mermaid
flowchart LR
    subgraph Dev["Developer machine"]
        br["feature branch → test → merge to main"]
        rel["deploy/release.sh (REST API)"]
    end
    subgraph GH["GitHub (private repo)"]
        tag["Release vX.Y.Z + generated notes"]
    end
    subgraph CT["Container"]
        panel["Web UI: Settings → Update"]
        be2["Backend /api/updates/apply"]
        sudo["sudo -n deploy/update.sh <tag>"]
        unit["systemd-run transient unit (own cgroup)"]
        steps["git fetch tag → pip install → alembic upgrade<br/>→ pnpm build → reinstall units → restart"]
    end

    br --> rel --> tag
    panel -->|status via GitHub Releases API| tag
    panel --> be2 --> sudo --> unit --> steps
    steps -. AI-VISIO-UPDATE markers .-> panel
```

Hard-won details baked into the updater:

- **Single worker** — the in-memory bridge cannot span processes.
- `git config --system safe.directory` — root operating on an `aivisio`-owned checkout.
- **`systemd-run` transient unit** — the updater escapes the backend's cgroup so restarting
  the backend can't kill it mid-run; it always writes a `SUCCESS`/`FAILED` marker.
- **Backend must be able to `sudo`** — `NoNewPrivileges` is intentionally **off** on the
  backend unit (it blocks sudo's setuid); sudo is scoped to exactly `update.sh` via the
  sudoers rule.
- **Stale-timeout** — a `running` log with no writes for >10 min is reported `failed`, so
  the UI never spins forever (covers OOM `SIGKILL`).
- **Launch detection** — the apply endpoint waits briefly and surfaces a denied `sudo`
  instead of silently hanging.

---

## 8. Technology summary

| Layer | Stack |
|---|---|
| Frontend | Next.js 16 (Turbopack), React, TypeScript, Tailwind CSS |
| Backend | Python 3.12, FastAPI, uvicorn, Pydantic v2, SQLAlchemy + Alembic, Pillow, httpx, `google-genai` |
| Data | PostgreSQL 16 |
| Device | ESP32-S3 (Arduino / PlatformIO, LovyanGFX) |
| Agent | Python (screen capture) |
| Infra | Proxmox LXC (Ubuntu 24.04), systemd, bash deploy scripts |
| AI | Google Gemini (`gemini-2.5-flash-lite` default, escalates to `flash`) |
```
