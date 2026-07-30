#!/usr/bin/env bash
# Publish ForgeRegistry + ForgeStars + forge-identity delegate to the local Freenet node.
# ForgeVault is published per-email on first register (SPA Put).
# Requires: freenet running, fdev on PATH, npm run build:owner already done.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PARAMS="$ROOT/build/forge-registry-params.bin"
STATE="$ROOT/build/forge-registry-empty.json"
STARS_PARAMS="$ROOT/build/forge-stars-params.bin"
STARS_STATE="$ROOT/build/forge-stars-empty.json"
mkdir -p "$ROOT/build"
printf 'gitforge-registry-v1' > "$PARAMS"
printf '{"schema_version":1,"repos":{}}' > "$STATE"
printf 'gitforge-stars-v1' > "$STARS_PARAMS"
printf '{"schema_version":1,"by_repo":{}}' > "$STARS_STATE"

REGISTRY_PKG="$ROOT/web/public/hub_registry.pkg"
STARS_PKG="$ROOT/web/public/hub_stars.pkg"
IDENTITY_PKG="$ROOT/web/public/hub_identity.pkg"
PAGES_PKG="$ROOT/web/public/hub_pages.pkg"
# Fall back to fdev build outputs
[[ -f "$REGISTRY_PKG" ]] || REGISTRY_PKG="$ROOT/contracts/forge-registry/build/freenet/freenet_forge_registry"
[[ -f "$STARS_PKG" ]] || STARS_PKG="$ROOT/contracts/forge-stars/build/freenet/freenet_forge_stars"
[[ -f "$IDENTITY_PKG" ]] || IDENTITY_PKG="$ROOT/delegates/forge-identity/build/freenet/freenet_forge_identity"
[[ -f "$PAGES_PKG" ]] || PAGES_PKG="$ROOT/delegates/forge-pages/build/freenet/freenet_forge_pages"

if [[ ! -f "$REGISTRY_PKG" || ! -f "$IDENTITY_PKG" ]]; then
  echo "error: missing packaged WASM — run: npm run build:owner" >&2
  exit 1
fi

echo "==> Publish ForgeRegistry contract"
# Network ack may time out even when the node installs locally — that is OK.
set +e
fdev publish --code "$REGISTRY_PKG" --parameters "$PARAMS" --timeout 90 contract --state "$STATE"
REG_RC=$?
set -e
if [[ $REG_RC -ne 0 ]]; then
  echo "warn: ForgeRegistry publish exited $REG_RC (check node logs for 'initial state installed')" >&2
fi

if [[ -f "$STARS_PKG" ]]; then
  echo "==> Publish ForgeStars contract"
  set +e
  fdev publish --code "$STARS_PKG" --parameters "$STARS_PARAMS" --timeout 90 contract --state "$STARS_STATE"
  STARS_RC=$?
  set -e
  if [[ $STARS_RC -ne 0 ]]; then
    echo "warn: ForgeStars publish exited $STARS_RC (SPA can Put on first star)" >&2
  fi
else
  echo "warn: hub_stars.pkg missing — skip ForgeStars publish" >&2
fi

echo "==> Publish forge-identity delegate"
set +e
fdev publish --code "$IDENTITY_PKG" --timeout 90 delegate
DEL_RC=$?
set -e
if [[ $DEL_RC -ne 0 ]]; then
  echo "warn: identity delegate publish exited $DEL_RC" >&2
  exit "$DEL_RC"
fi

if [[ -f "$PAGES_PKG" ]]; then
  echo "==> Publish forge-pages delegate"
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
