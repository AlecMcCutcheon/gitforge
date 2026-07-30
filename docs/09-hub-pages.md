# GitForge Pages (Freenet-native)

Deploy a Freenet **website contract** from a freenet-git tip branch. This is a
Hub product feature (like GitHub Pages), not part of git itself.

## Authority (gates)

Enable / Sync / Disable require **all** of:

1. Signed-in GitForge **identity** (forge-identity)
2. Repo **site key** present on that identity
3. Live **ForgeRegistry** listing for the prefix owned by that identity
   (`identity_fingerprint` match — same gate as Danger Zone unregister/delete)

Visitors can still **Open site** when Pages is enabled (public `pages` meta +
contract key). They cannot mutate.

**Unregister** and **soft-delete** always run Pages take-down first when
enabled (Disable + optional tombstone website update). You cannot leave
Discover while a GitForge Pages site is still live for that repo.

**Signing keys** live in **pages-delegate** (node secrets). They are sealed into
ForgeVault envelope `pages` (ciphertext public, DEK under `identity_dek_wrap`) so
they sync across nodes with Push/Pull — never cleartext on RepoState.
ExportKeys on the pages-delegate feeds vault push; ImportKey restores on pull.

## Product path (website mode)

GitForge manages Pages entirely in the browser:

1. Tip → site bytes (require `index.html` under optional `rootPath`)
2. **pages-delegate** holds per-repo website signing keys (`forge-pages-<prefix>`),
   tied to the enabling identity via RepoState `pages.identity_fingerprint`
3. SPA Puts / Updates the website container contract
4. **RepoState `pages` extension** stores public metadata so any visitor can
   Open site without ForgeRegistry

No Express Hub bridge and no `fdev website` for the product path.

| Action | Behavior |
|--------|----------|
| **Enable** | Registry owner only. Ensure pages key, extract tip, Put website, sign `pages` (includes contract key + identity fingerprint). |
| **Sync** | Registry owner only. If tip commit ≠ `last_commit`, Update website + refresh meta. |
| **autoSync** | Default on (local). Opening Code as registry owner triggers sync-if-stale. |
| **Disable** | Registry owner. Clears `enabled`; optional tombstone `index.html` site update. |
| **Unregister / Delete** | Runs Disable/take-down first if Pages was enabled. |

When enabled, UI always shows the **contract key** and a link to the site URL.

Site URL (local default): `http://127.0.0.1:7509/v1/contract/web/<contractKey>/`

## RepoState `pages` extension

UTF-8 JSON under extension key `pages`:

```json
{
  "enabled": true,
  "contract_key": "<base58 instance id>",
  "branch": "main",
  "root_path": "",
  "last_commit": "<40-hex>",
  "updated_at": "<ISO-8601>",
  "verifying_key_hex": "<64-hex ed25519 vk>",
  "identity_fingerprint": "<GitForge identity that enabled Pages>"
}
```

Optional: mirror Freenet site URL into ForgeRegistry About `website` on enable
for Discover.

## pages-delegate

Local WASM (`delegates/forge-pages`):

- `EnsureKey` — create/load signing key for `forge-pages-<prefix>`
- `CompressAndSign` — xz-compress ustar tar, sign `version || archive`, return
  CBOR metadata + compressed archive + verifying key

SPA builds the ustar from tip extract, then Puts `website_contract.wasm` with
params = verifying key bytes.

## Requirements

- Freenet node up; pages-delegate + forge-identity published
- Tip branch (optional subdirectory) contains **`index.html`**
- No Actions/CI — static tip tree only
- Owner has the repo key in forge-identity

## API (SPA)

Native (`isBrowserNativeMode()`):

- `api.pages(prefix, label, autoSync?)`
- `api.pagesEnable(prefix, label, { branch?, rootPath?, autoSync? })`
- `api.pagesSync(prefix, label)`
- `api.pagesDisable(prefix, label, { tombstone? })`

Bridge Express routes under `/api/r/.../pages*` remain for legacy hybrid
installs only — no new investment.

## UI

- Repo sidebar **Pages** (status, Open site, Enable / Sync / Disable)
- Settings → Pages tab (same controls)
- Your work per-repo Pages row

## Legacy bridge

[`server/src/forge-pages.ts`](../server/src/forge-pages.ts) + `fdev website` +
`forge-pages.json` is deprecated for website mode. See phased delivery B4 in the
Unregister + Pages plan.
