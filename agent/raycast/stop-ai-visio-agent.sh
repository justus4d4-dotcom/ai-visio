#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Stop screen capture
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🛑
# @raycast.packageName AI Visio
# @raycast.iconDark 🛑

# Documentation:
# @raycast.description Stop the ai-visio+ native screen-capture agent.
# @raycast.author ai-visio

if pkill -f "ai_visio_agent.py"; then
  echo "ai-visio agent stopped"
else
  echo "ai-visio agent was not running"
fi
