#!/usr/bin/env bash
#
# release.sh — Cut a GitHub Release WITHOUT GitHub Actions (Actions are disabled
# org-wide). Computes the next semver tag, then creates a Release via the GitHub REST
# API with auto-generated notes. Creating the release also creates the tag on the
# target branch, so the in-app updater (which tracks the newest release) picks it up.
#
# Usage (run from your dev machine, on the branch you want to release):
#   deploy/release.sh            # patch bump (default): v0.1.0 -> v0.1.1
#   deploy/release.sh minor      # v0.1.1 -> v0.2.0
#   deploy/release.sh major      # v0.2.0 -> v1.0.0
#   deploy/release.sh v1.2.3     # explicit version
#
# Requires GITHUB_TOKEN (fine-grained PAT with Contents: write, SSO-authorized) in the
# environment or in backend/.env. The token is read from .env silently, never printed.
set -euo pipefail

REPO="${REPO:-justus4d4-dotcom/ai-visio}"
BRANCH="${BRANCH:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Token: env first, else fall back to backend/.env (same as update.sh).
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [[ -z "$GITHUB_TOKEN" && -f "$ROOT/backend/.env" ]]; then
  GITHUB_TOKEN="$(sed -n 's/^[[:space:]]*GITHUB_TOKEN[[:space:]]*=[[:space:]]*//p' "$ROOT/backend/.env" | tail -n1 | tr -d '"'"'"'\r')"
fi
[[ -n "$GITHUB_TOKEN" ]] || { echo "ERROR: GITHUB_TOKEN not set (env or backend/.env)." >&2; exit 1; }

arg="${1:-patch}"

# Sync tags so the version math reflects what's actually published.
git -C "$ROOT" fetch --tags --quiet origin "$BRANCH" 2>/dev/null || true

if [[ "$arg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next="$arg"
else
  latest="$(git -C "$ROOT" tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n1)"
  if [[ -z "$latest" ]]; then
    next="v0.1.0"
  else
    ver="${latest#v}"; major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"; patch="${rest#*.}"
    case "$arg" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "ERROR: unknown bump '$arg' (use patch|minor|major or vX.Y.Z)." >&2; exit 1 ;;
    esac
    next="v${major}.${minor}.${patch}"
  fi
fi

echo "Creating release ${next} on ${BRANCH} (previous: ${latest:-none})…"

payload="$(python3 -c 'import json,sys; print(json.dumps({"tag_name":sys.argv[1],"target_commitish":sys.argv[2],"name":sys.argv[1],"generate_release_notes":True}))' "$next" "$BRANCH")"

resp="$(curl -sS -w $'\n%{http_code}' -X POST \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${REPO}/releases" \
  -d "$payload")"

code="$(printf '%s' "$resp" | tail -n1)"
body="$(printf '%s' "$resp" | sed '$d')"

if [[ "$code" == "201" ]]; then
  url="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("html_url",""))')"
  echo "✓ Released ${next}: ${url}"

  # Attach the ESP32 firmware image so the in-app "latest firmware from GitHub" OTA can
  # fetch it. Best-effort: needs PlatformIO on PATH; a missing/broken build never fails
  # the release (the firmware can be built + attached later, or uploaded manually).
  upload_url="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("upload_url","").split("{")[0])')"
  fw_bin="$ROOT/firmware/.pio/build/waveshare-s3-round/firmware.bin"
  if command -v pio >/dev/null 2>&1; then
    echo "Building ESP32 firmware to attach…"
    if pio run -d "$ROOT/firmware" >/tmp/ai-visio-fw-build.log 2>&1; then
      if [[ -f "$fw_bin" && -n "$upload_url" ]]; then
        acode="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
          -H "Authorization: Bearer ${GITHUB_TOKEN}" \
          -H "Content-Type: application/octet-stream" \
          "${upload_url}?name=ai-visio-display-${next}.bin" --data-binary @"$fw_bin")"
        if [[ "$acode" == "201" ]]; then
          echo "✓ Attached firmware asset ai-visio-display-${next}.bin"
        else
          echo "! Firmware asset upload failed (HTTP ${acode}); attach it manually if needed." >&2
        fi
      fi
    else
      echo "! Firmware build failed (see /tmp/ai-visio-fw-build.log); released without a firmware asset." >&2
    fi
  else
    echo "! PlatformIO (pio) not found — released without a firmware asset. Build firmware/ and attach ai-visio-display-${next}.bin to enable GitHub OTA." >&2
  fi
else
  echo "✗ GitHub API error (HTTP ${code}):" >&2
  printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("message","")); [print(" -", e.get("code"), e.get("field")) for e in d.get("errors",[])]' >&2 || printf '%s\n' "$body" >&2
  exit 1
fi
