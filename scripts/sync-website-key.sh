#!/usr/bin/env bash
# Write web/src/freenet/website-constants.ts from `fdev website list`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_NAME="${GITFORGE_WEBSITE_KEY:-gitforge}"
OUT="$ROOT/web/src/freenet/website-constants.ts"

KEY=""
if command -v fdev >/dev/null 2>&1; then
  # OLD CODE - KEEP UNTIL CONFIRMED WORKING
  # KEY="$(fdev website list 2>/dev/null | awk -v n="$KEY_NAME" '$1==n {print $2; exit}')"
  # NEW CODE - TESTING: awk early-exit SIGPIPEs fdev → pipefail 101 aborted publish
  KEY="$(
    fdev website list 2>/dev/null | awk -v n="$KEY_NAME" '$1==n {print $2; exit}' || true
  )"
fi
if [[ -z "$KEY" ]]; then
  echo "warn: could not resolve website key for ${KEY_NAME}; leaving constants unchanged" >&2
  exit 0
fi

cat > "$OUT" <<EOF
/**
 * Freenet website contract key for GitForge (\`fdev website\` name: ${KEY_NAME}).
 * Synced by scripts/sync-website-key.sh before publish.
 * Key bytes stay stable — only the display/fdev name may change.
 */
export const FORGE_WEBSITE_CONTRACT_KEY =
  "${KEY}";

/** Gateway path prefix for this website contract. */
export function forgeWebsiteBasename(): string {
  return \`/v1/contract/web/\${FORGE_WEBSITE_CONTRACT_KEY}\`;
}
EOF
echo "Wrote ${OUT} (key=${KEY})"
