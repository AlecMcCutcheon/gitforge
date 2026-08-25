#!/usr/bin/env bash
# Publish GitForge SPA as a Freenet website contract.
# Prerequisites: freenet node running, fdev on PATH, web/dist built
#   (npm run build:website).
# fdev key name defaults to `gitforge` (override with GITFORGE_WEBSITE_KEY).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${ROOT}/web/dist"
KEY_NAME="${GITFORGE_WEBSITE_KEY:-gitforge}"

if ! command -v fdev >/dev/null 2>&1; then
  echo "error: fdev not found on PATH" >&2
  exit 1
fi

if [[ ! -f "${DIST}/index.html" ]]; then
  echo "error: missing ${DIST}/index.html — run: npm run build:website" >&2
  exit 1
fi

if ! websites="$(fdev website list 2>/dev/null)" || ! grep -qE "(^|[[:space:]])${KEY_NAME}([[:space:]]|$)" <<<"$websites"; then
  echo "Initializing website key '${KEY_NAME}'…"
  fdev website init "${KEY_NAME}"
fi

# Prefer update when already published; fall back to publish.
if fdev website update "${DIST}" --key "${KEY_NAME}"; then
  echo "Updated GitForge website (${KEY_NAME})."
else
  echo "Update failed or first deploy — trying publish…"
  fdev website publish "${DIST}" --key "${KEY_NAME}"
  echo "Published GitForge website (${KEY_NAME})."
fi

echo
echo "Keys:"
fdev website list
echo
echo "Open the Website URL from the list above (typically"
echo "http://127.0.0.1:7509/v1/contract/web/<key>/)."
echo "Hard-refresh the browser after publish."
