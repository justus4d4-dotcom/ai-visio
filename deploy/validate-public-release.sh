#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for path in \
  firmware/src/wifi_secrets.h \
  firmware/arduino/ai_visio_display/wifi_secrets.h
do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "ERROR: local credential file is tracked: $path" >&2
    exit 1
  fi
done

if git ls-files | grep -Eq '(^|/)\.env$|(^|/)\.env\.local$|(^|/)\.pio/|(^|/)\.venv/|\.zip$'; then
  echo "ERROR: a private environment, build output, or archive is tracked." >&2
  exit 1
fi

if git grep -IEn \
  'pwc-de-adv-trf-is-cloud|@pwc\.com|schaefer-penzberg|github\.com/[^ /]+/ai-image-interpreter' \
  -- . \
  ':(exclude)deploy/validate-public-release.sh'
then
  echo "ERROR: private organization, email, hostname, or legacy repository reference found." >&2
  exit 1
fi

echo "Public-release validation passed."
