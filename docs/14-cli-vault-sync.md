# CLI create → HubVault sync → GAR register

## Why sync is needed

Each `freenet-git create` mints a **new per-repo owner key** and appends it to
the **local** CLI identity bundle. GitAtlas’s browser identity (hub-identity
delegate) and HubVault on Freenet do **not** auto-update.

Your Freenet identity (`freenet:id:…`) stays the same; only the repo-key set
grows.

## Workflows

### A. Browser only (same machine / same signed-in identity)

1. `freenet-git create --name hello`
2. GitAtlas → **Settings → Vault & sync → Sync CLI repos**
3. Upload the updated `.bundle` + passphrase
4. If HubVault is enabled and was already in sync, the vault auto-updates
   (signed-in identity — no vault password)
5. Open the repo → **Import** → Verify → Register on GAR

Mismatch fingerprint ⇒ sign out and use Restore (different account).

Resolve vault↔node drift under **Vault & sync → Repo keys: vault ↔ this node**
(auto-checked when you open that settings section; no password).

### B. Any Freenet node via API key (vault push)

1. Enable **HubVault** in GitAtlas (schema v3)
2. **Settings → API keys → Mint** (copy `gatk_…` **and vault id** once)
3. After CLI creates repos:

```sh
cd freenet-gitatlas
npm run gitatlas-vault -- sync-bundle \
  --api-key "$GATK" \
  --bundle ~/Downloads/git-identity-….bundle \
  --bundle-passphrase '…'
```

### C. Pull vault → local bundle

```sh
npm run gitatlas-vault -- pull-bundle \
  --api-key "$GATK" \
  --bundle ~/Downloads/git-identity-….bundle \
  --bundle-passphrase '…'
```

### D. Own node — vault + local delegate

Add `--import-local-delegate` to push or pull.

### Browser auto-update rule

**Vault & sync → Sync CLI repos** with vault password: HubVault is auto-updated
**only if** vault ↔ this node were already **in sync** before the merge. If
there was drift, the delegate still receives new keys; resolve under
**Settings → Vault & sync → Repo keys: vault ↔ this node**.

## Threat model

- HubVault ciphertext is public; secrecy is password / API key / seed.
- API keys are **cryptographically scoped** to envelopes (v2: `repos`). They do
  not unlock identity/TOTP from the vault.
- Contract enforces ops updates cannot rewrite identity or mint/revoke keys.
- **Revoke** is the lifetime control (no time-based expiry on Freenet).
- Password change does **not** invalidate API keys.
- Opening a full freenet-git `.bundle` still exposes the seed on the CLI host.
- Do not run sync on a machine you do not trust for memory/swap forensics.

See [`10-hub-vault-auth.md`](10-hub-vault-auth.md) and
[`scripts/cli/README.md`](../scripts/cli/README.md).

## Repo owner CLI (`gitatlas-repo`)

Vault API keys cannot dual-sign HubRegistry / RepoState. For **about**
(description + website + topics), **register**, **unregister**, **rename**, and
**soft-delete**, use the identity bundle against the local Freenet node:

```sh
npm run gitatlas-repo -- about \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…' \
  --prefix <prefix> --label <label> \
  --description '…' [--website '…'] [--topics a,b]
```

The tool ImportIdentity + ImportRepoKey into hub-identity, then runs the same
owner-api paths as the SPA (including HubRepoMeta ensure on register/about).

