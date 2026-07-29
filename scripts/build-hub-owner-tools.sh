#!/usr/bin/env bash
# Build + package HubRegistry + HubVault + HubStars + HubProfile + hub-identity;
# copy into web/public; regenerate owner-constants.ts + build/owner-tools-info.md.
#
# fdev must see CARGO_TARGET_DIR or it panics ("Could not find workspace root")
# when the installed fdev binary has no parent Cargo workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CARGO_TARGET_DIR="$ROOT/target"

echo "==> Package HubRegistry contract (fdev)"
(cd contracts/hub-registry && fdev build --package-type contract)

echo "==> Package HubVault contract (fdev)"
(cd contracts/hub-vault && fdev build --package-type contract)

echo "==> Package HubStars contract (fdev)"
(cd contracts/hub-stars && fdev build --package-type contract)

echo "==> Package HubProfile contract (fdev)"
(cd contracts/hub-profile && fdev build --package-type contract)

echo "==> Package HubRepoMeta contract (fdev)"
(cd contracts/hub-repo && fdev build --package-type contract)

echo "==> Package hub-identity delegate (fdev)"
(cd delegates/hub-identity && fdev build --package-type delegate)

echo "==> Package hub-pages delegate (fdev)"
(cd delegates/hub-pages && fdev build --package-type delegate)

REGISTRY_PKG="$ROOT/contracts/hub-registry/build/freenet/freenet_hub_registry"
VAULT_PKG="$ROOT/contracts/hub-vault/build/freenet/freenet_hub_vault"
STARS_PKG="$ROOT/contracts/hub-stars/build/freenet/freenet_hub_stars"
PROFILE_PKG="$ROOT/contracts/hub-profile/build/freenet/freenet_hub_profile"
REPO_PKG="$ROOT/contracts/hub-repo/build/freenet/freenet_hub_repo"
IDENTITY_PKG="$ROOT/delegates/hub-identity/build/freenet/freenet_hub_identity"
PAGES_PKG="$ROOT/delegates/hub-pages/build/freenet/freenet_hub_pages"
REGISTRY_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_registry.wasm"
VAULT_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_vault.wasm"
STARS_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_stars.wasm"
PROFILE_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_profile.wasm"
REPO_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_repo.wasm"
IDENTITY_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_identity.wasm"
PAGES_RAW="$ROOT/target/wasm32-unknown-unknown/release/freenet_hub_pages.wasm"

if [[ ! -f "$REGISTRY_PKG" || ! -f "$VAULT_PKG" || ! -f "$STARS_PKG" || ! -f "$PROFILE_PKG" || ! -f "$REPO_PKG" || ! -f "$IDENTITY_PKG" || ! -f "$PAGES_PKG" ]]; then
  echo "error: missing fdev package outputs" >&2
  exit 1
fi

mkdir -p web/public build
# SPA Put uses raw WASM bytes (node re-hashes); publish uses packaged files.
cp -f "$REGISTRY_RAW" web/public/hub_registry.wasm
cp -f "$VAULT_RAW" web/public/hub_vault.wasm
cp -f "$STARS_RAW" web/public/hub_stars.wasm
cp -f "$PROFILE_RAW" web/public/hub_profile.wasm
cp -f "$REPO_RAW" web/public/hub_repo.wasm
cp -f "$IDENTITY_RAW" web/public/hub_identity.wasm
cp -f "$PAGES_RAW" web/public/hub_pages.wasm
cp -f "$REGISTRY_PKG" web/public/hub_registry.pkg
cp -f "$VAULT_PKG" web/public/hub_vault.pkg
cp -f "$STARS_PKG" web/public/hub_stars.pkg
cp -f "$PROFILE_PKG" web/public/hub_profile.pkg
cp -f "$REPO_PKG" web/public/hub_repo.pkg
cp -f "$IDENTITY_PKG" web/public/hub_identity.pkg
cp -f "$PAGES_PKG" web/public/hub_pages.pkg

WEBSITE_SRC="$ROOT/../freenet-core/crates/fdev/resources/website_contract.wasm"
if [[ -f "$WEBSITE_SRC" ]]; then
  cp -f "$WEBSITE_SRC" web/public/website_contract.wasm
  echo "copied website_contract.wasm"
else
  echo "warn: website_contract.wasm not found at $WEBSITE_SRC" >&2
fi

REPO_SRC=""
for c in \
  "$ROOT/../freenet-git/crates/freenet-git/contracts/repo-contract.wasm" \
  "${HOME}/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/freenet-git-0.1.24/contracts/repo-contract.wasm"
do
  if [[ -f "$c" ]]; then REPO_SRC="$c"; break; fi
done
  if [[ -n "$REPO_SRC" ]]; then
  cp -f "$REPO_SRC" web/public/repo-contract.wasm
  echo "copied repo-contract.wasm from $REPO_SRC"
else
  echo "warn: repo-contract.wasm not found" >&2
fi

PACK_SRC=""
for c in \
  "$ROOT/../freenet-git/crates/freenet-git/contracts/pack-contract.wasm" \
  "${HOME}/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/freenet-git-0.1.24/contracts/pack-contract.wasm"
do
  if [[ -f "$c" ]]; then PACK_SRC="$c"; break; fi
done
if [[ -n "$PACK_SRC" ]]; then
  cp -f "$PACK_SRC" web/public/pack-contract.wasm
  echo "copied pack-contract.wasm from $PACK_SRC"
else
  echo "warn: pack-contract.wasm not found" >&2
fi

# Registry code hash = blake3(raw wasm). Delegate key uses fdev-inspect code hash
# of the *packaged* delegate (what the node registers).
IDENTITY_CODE_B58="$(fdev inspect "$IDENTITY_PKG" delegate | grep 'code hash:' | awk '{print $3}')"
if [[ -z "$IDENTITY_CODE_B58" ]]; then
  echo "error: could not read identity code hash from fdev inspect" >&2
  exit 1
fi
PAGES_CODE_B58="$(fdev inspect "$PAGES_PKG" delegate | grep 'code hash:' | awk '{print $3}')"
if [[ -z "$PAGES_CODE_B58" ]]; then
  echo "error: could not read pages code hash from fdev inspect" >&2
  exit 1
fi

node "$ROOT/scripts/gen-hub-owner-constants.mjs" \
  "$REGISTRY_RAW" "$IDENTITY_RAW" \
  --identity-code-b58 "$IDENTITY_CODE_B58" \
  --vault "$VAULT_RAW" \
  --stars "$STARS_RAW" \
  --profile "$PROFILE_RAW" \
  --repo "$REPO_RAW" \
  --pages "$PAGES_RAW" \
  --pages-code-b58 "$PAGES_CODE_B58"

CONTRACT_ID="$(fdev get-contract-id --code "$REGISTRY_RAW" --parameters <(printf 'gitatlas-registry-v1') 2>/dev/null || true)"
printf 'gitatlas-registry-v1' > "$ROOT/build/hub-registry-params.bin"
printf '{"schema_version":1,"repos":{}}' > "$ROOT/build/hub-registry-empty.json"
printf 'gitatlas-stars-v1' > "$ROOT/build/hub-stars-params.bin"
printf '{"schema_version":1,"by_repo":{}}' > "$ROOT/build/hub-stars-empty.json"

node -e "
const fs = require('fs');
const { blake3 } = require('@noble/hashes/blake3');
const bs58 = require('bs58');
const enc = bs58.default ?? bs58;
const reg = fs.readFileSync(process.argv[1]);
const vault = fs.readFileSync(process.argv[2]);
const stars = fs.readFileSync(process.argv[3]);
const profile = fs.readFileSync(process.argv[4]);
const repo = fs.readFileSync(process.argv[5]);
const regB58 = enc.encode(blake3(reg));
const vaultB58 = enc.encode(blake3(vault));
const starsB58 = enc.encode(blake3(stars));
const profileB58 = enc.encode(blake3(profile));
const repoB58 = enc.encode(blake3(repo));
const idCodeB58 = process.argv[6];
const idCodeBytes = enc.decode(idCodeB58);
const key = blake3(idCodeBytes);
const contractId = process.argv[7] || '(run fdev get-contract-id)';
const body = \`# GitAtlas owner-tools build fingerprint

Generated by \\\`npm run build:owner\\\`.

| Artifact | Value |
|----------|-------|
| HubRegistry WASM BLAKE3 (base58) | \\\`\${regB58}\\\` |
| HubRegistry params (UTF-8) | \\\`gitatlas-registry-v1\\\` |
| HubRegistry contract id | \\\`\${contractId}\\\` |
| HubVault WASM BLAKE3 (base58) | \\\`\${vaultB58}\\\` |
| HubVault params | \\\`gitatlas-vault-v1:<vault_id_hex>\\\` |
| HubStars WASM BLAKE3 (base58) | \\\`\${starsB58}\\\` |
| HubStars params (UTF-8) | \\\`gitatlas-stars-v1\\\` |
| HubProfile WASM BLAKE3 (base58) | \\\`\${profileB58}\\\` |
| HubProfile params | \\\`gitatlas-profile-v1:<fingerprint>\\\` |
| HubRepoMeta WASM BLAKE3 (base58) | \\\`\${repoB58}\\\` |
| HubRepoMeta params | \\\`gitatlas-repo-v1:<repo_prefix>\\\` |
| Identity delegate code hash (base58, packaged) | \\\`\${idCodeB58}\\\` |
| Identity delegate key = blake3(code_hash) (hex) | \\\`\${Buffer.from(key).toString('hex')}\\\` |
| Packaged publish files | \\\`web/public/hub_*.pkg\\\`, \\\`hub_identity.pkg\\\` |
| SPA Put WASM | \\\`web/public/*.wasm\\\` |

## Next steps

\\\`\\\`\\\`sh
bash scripts/publish-owner-tools.sh
npm run publish:website
\\\`\\\`\\\`
\`;
fs.writeFileSync('build/owner-tools-info.md', body);
console.log('Wrote build/owner-tools-info.md');
" "$REGISTRY_RAW" "$VAULT_RAW" "$STARS_RAW" "$PROFILE_RAW" "$REPO_RAW" "$IDENTITY_CODE_B58" "${CONTRACT_ID:-}"

echo "Done. Next (Freenet up):"
echo "  bash scripts/publish-owner-tools.sh"
echo "  npm run publish:website"
