# ai-visio+ native screen agent

A small, headless Python program that records your **whole Mac screen** and streams it to
the backend. Use it instead of the Chrome `getDisplayMedia` share when you'd rather not
keep a browser tab sharing the screen.

The agent only **records** — it does not call Gemini and needs **no API key**. The web
app (which holds your BYOK key) fetches the latest frame and does the interpreting when a
trigger fires. Select **Native app** as the capture source in the web UI to use it.

## How it fits in

```
agent records screen ──POST /api/remote/frame──▶ backend stores latest frame
                                                      ▲
ESP32 touch ─▶ backend (trigger) ─▶ browser polls ───┘ then GET /api/remote/frame
                                     browser solves it with YOUR Gemini key
                                          │
                              answer pushed back ─▶ ESP32 display
```

The agent posts a heartbeat so the web UI can list it and let you switch between
**Chrome tab** and **Native app** as the capture source. Only the selected source is
used, so a frame is never solved twice. The web app tab must be open (it holds the key).

## Install

```bash
cd agent
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

mkdir -p ~/.config/ai-visio-agent
cp config.example.toml ~/.config/ai-visio-agent/config.toml
# edit the file: set backend_url (use your LAN IP if devices need it). No API key needed.
```

macOS will ask for **Screen Recording** permission the first time (System Settings →
Privacy & Security → Screen Recording). Grant it to the app that runs Python (your
terminal, or `Python.app` inside the venv), then re-run.

## Run

Foreground (to test):

```bash
python ai_visio_agent.py --config ~/.config/ai-visio-agent/config.toml -v
```

Then open the web app, and under **Capture source** pick **Native app**. Tap the ESP32
(or click **Simulate screen touch**) — the browser interprets the agent's current screen.

Tuning: `--fps 2` streams faster (fresher frames); `--monitor 0` captures all displays
stitched together; `--backend-url http://192.0.2.10:8000` overrides the config.

CLI flags override the config file and `AIVISIO_*` env vars, e.g.
`--backend-url http://192.0.2.10:8000 --monitor 1 --fps 2`.

## Running it hidden in the background — options

Ranked from most to least "set and forget":

### 1. launchd (recommended — auto-start at login, auto-restart, fully hidden)

Use the provided template `com.aivisio.agent.plist`:

```bash
# edit the absolute paths inside the plist first, then:
cp com.aivisio.agent.plist ~/Library/LaunchAgents/com.aivisio.agent.plist
launchctl load -w ~/Library/LaunchAgents/com.aivisio.agent.plist   # start + enable
launchctl list | grep aivisio                                      # verify
launchctl unload -w ~/Library/LaunchAgents/com.aivisio.agent.plist # stop + disable
tail -f /tmp/aivisio-agent.log                                     # watch output
```

This runs with no window, starts on login, and restarts if it crashes.

### 2. `nohup` (quick, no config; survives closing the terminal)

```bash
nohup python ai_visio_agent.py --config ~/.config/ai-visio-agent/config.toml \
  > /tmp/aivisio-agent.log 2>&1 &
disown
# stop it later:
pkill -f ai_visio_agent.py
```

### 3. `caffeinate` (keep the Mac awake while it runs, e.g. lid open on power)

```bash
nohup caffeinate -dimsu python ai_visio_agent.py > /tmp/aivisio-agent.log 2>&1 &
```

Combine with option 1 by wrapping the launchd `ProgramArguments` in `caffeinate` if you
want it awake continuously.

### 4. `tmux` / `screen` (detached session you can re-attach to)

```bash
tmux new -s aivisio 'python ai_visio_agent.py -v'
# detach: Ctrl-b then d      reattach: tmux attach -t aivisio
```

### 5. A packaged menu-bar/background app (most polished, more work)

Wrap the script with [`rumps`](https://github.com/jaredks/rumps) for a menu-bar icon, or
bundle it with `py2app`/`PyInstaller` into a `.app` with `LSUIElement=true` in its
`Info.plist` so it runs with no Dock icon. Overkill for a single user, but nice if you
distribute it.

### 6. Raycast Script Commands (start/stop from the Raycast launcher)

Ready-made commands live in [`raycast/`](raycast/):

1. Raycast → **Extensions → Script Commands → Add Directories** → pick `agent/raycast`.
   "Start screen capture" and "Stop screen capture" now show up in Raycast.
2. Grant **Raycast** the *Screen Recording* permission (System Settings → Privacy &
   Security → Screen Recording) — the agent inherits it from Raycast.
3. Edit the `AGENT_DIR` / `PYTHON` / `CONFIG` paths at the top of
   `raycast/start-ai-visio-agent.sh` if yours differ.

The start command uses `@raycast.mode silent` and detaches the process with
`nohup … & disown`, so the agent keeps running in the background after Raycast returns.
Run it again and it won't launch a duplicate; use the stop command (or `pkill -f
ai_visio_agent.py`) to end it. Logs go to `/tmp/aivisio-agent.log`.


> Notes
> - Screen Recording permission is tied to the *bundle* that launches Python. If you
>   switch from Terminal to launchd/`Python.app`, you may need to grant it again.
> - `monitor = 1` captures the primary display; `0` stitches all displays together.
> - Keep `config.toml` private (`chmod 600`) — it holds your Gemini key.
