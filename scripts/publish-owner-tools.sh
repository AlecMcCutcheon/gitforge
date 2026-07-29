#!/usr/bin/env bash
# Publish HubRegistry + HubStars + hub-identity delegate to the local Freenet node.
# HubVault is published per-email on first register (SPA Put).
# Requires: freenet running, fdev on PATH, npm run build:owner already done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PARAMS="$ROOT/build/hub-registry-params.bin"
STATE="$ROOT/build/hub-registry-empty.json"
STARS_PARAMS="$ROOT/build/hub-stars-params.bin"
STARS_STATE="$ROOT/build/hub-stars-empty.json"
mkdir -p "$ROOT/build"
printf 'gitatlas-registry-v1' > "$PARAMS"
printf '{"schema_version":1,"repos":{}}' > "$STATE"
printf 'gitatlas-stars-v1' > "$STARS_PARAMS"
printf '{"schema_version":1,"by_repo":{}}' > "$STARS_STATE"

REGISTRY_PKG="$ROOT/web/public/hub_registry.pkg"
STARS_PKG="$ROOT/web/public/hub_stars.pkg"
IDENTITY_PKG="$ROOT/web/public/hub_identity.pkg"
PAGES_PKG="$ROOT/web/public/hub_pages.pkg"
# Fall back to fdev build outputs
[[ -f "$REGISTRY_PKG" ]] || REGISTRY_PKG="$ROOT/contracts/hub-registry/build/freenet/freenet_hub_registry"
[[ -f "$STARS_PKG" ]] || STARS_PKG="$ROOT/contracts/hub-stars/build/freenet/freenet_hub_stars"
[[ -f "$IDENTITY_PKG" ]] || IDENTITY_PKG="$ROOT/delegates/hub-identity/build/freenet/freenet_hub_identity"
[[ -f "$PAGES_PKG" ]] || PAGES_PKG="$ROOT/delegates/hub-pages/build/freenet/freenet_hub_pages"

if [[ ! -f "$REGISTRY_PKG" || ! -f "$IDENTITY_PKG" ]]; then
  echo "error: missing packaged WASM — run: npm run build:owner" >&2
  exit 1
fi

echo "==> Publish HubRegistry contract"
# Network ack may time out even when the node installs locally — that is OK.
set +e
fdev publish --code "$REGISTRY_PKG" --parameters "$PARAMS" --timeout 90 contract --state "$STATE"
REG_RC=$?
set -e
if [[ $REG_RC -ne 0 ]]; then
  echo "warn: HubRegistry publish exited $REG_RC (check node logs for 'initial state installed')" >&2
fi

if [[ -f "$STARS_PKG" ]]; then
  echo "==> Publish HubStars contract"
  set +e
  fdev publish --code "$STARS_PKG" --parameters "$STARS_PARAMS" --timeout 90 contract --state "$STARS_STATE"
  STARS_RC=$?
  set -e
  if [[ $STARS_RC -ne 0 ]]; then
    echo "warn: HubStars publish exited $STARS_RC (SPA can Put on first star)" >&2
  fi
else
  echo "warn: hub_stars.pkg missing — skip HubStars publish" >&2
fi

echo "==> Publish hub-identity delegate"
set +e
fdev publish --code "$IDENTITY_PKG" --timeout 90 delegate
DEL_RC=$?
set -e
if [[ $DEL_RC -ne 0 ]]; then
  echo "warn: identity delegate publish exited $DEL_RC" >&2
  exit "$DEL_RC"
fi

if [[ -f "$PAGES_PKG" ]]; then
  echo "==> Publish hub-pages delegate"
  set +e
  fdev publish --code "$PAGES_PKG" --timeout 90 delegate
  PAGES_RC=$?
  set -e
  if [[ $PAGES_RC -ne 0 ]]; then
    echo "warn: pages delegate publish exited $PAGES_RC" >&2
    exit "$PAGES_RC"
  fi
else
  echo "warn: hub_pages.pkg missing — skip pages-delegate publish" >&2
fi

echo "Done. Fingerprints: build/owner-tools-info.md"
echo "Next: npm run publish:website"
