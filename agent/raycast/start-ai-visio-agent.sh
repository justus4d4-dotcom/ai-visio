#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Start screen capture
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🎥
# @raycast.packageName AI Visio
# @raycast.iconDark 🎥

# Documentation:
# @raycast.description Start the ai-visio+ native screen-capture agent in the background.
# @raycast.author ai-visio

# --- Edit these paths if yours differ ---------------------------------------
AGENT_DIR="$HOME/Code/ai-visio/agent"
PYTHON="$AGENT_DIR/.venv/bin/python"
CONFIG="$HOME/.config/ai-visio-agent/config.toml"
LOG="/tmp/aivisio-agent.log"
# ----------------------------------------------------------------------------

# Don't launch a duplicate if it's already running.
if pgrep -f "ai_visio_agent.py" >/dev/null 2>&1; then
  echo "ai-visio agent already running"
  exit 0
fi

if [ ! -x "$PYTHON" ]; then
  echo "Python venv not found at $PYTHON"
  exit 1
fi

cd "$AGENT_DIR" || exit 1

# Detach so the agent keeps running after Raycast returns.
nohup "$PYTHON" ai_visio_agent.py --config "$CONFIG" >"$LOG" 2>&1 &
disown

echo "ai-visio agent started (logs: $LOG)"
