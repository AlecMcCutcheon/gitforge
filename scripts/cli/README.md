# GitAtlas vault CLI

Push/pull freenet-git identity bundles ↔ **HubVault** (schema v4) using a scoped
API key. Signing uses the per-key **ops** key — not the identity seed — and does
not call `ImportIdentity` unless you pass `--import-local-delegate`.

## Prerequisites

1. Enable **Vault backup** in GitAtlas.
2. **Settings → API keys → Mint** (copy `gatk_…` and vault id).
3. Scope includes `repos` (default).

## Push (bundle → vault)

After `freenet-git create`:

```sh
cd freenet-gitatlas
npm run gitatlas-vault -- sync-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity-….bundle \
  --bundle-passphrase '…'
```

Own node (also update local delegate):

```sh
npm run gitatlas-vault -- sync-bundle … --import-local-delegate
```

## Pull (vault → bundle)

```sh
npm run gitatlas-vault -- pull-bundle \
  --api-key "$GATK" \
  --bundle ~/path/to/git-identity-….bundle \
  --bundle-passphrase '…' \
  [--out ~/path/to/updated.bundle]
```

Default `--out` overwrites `--bundle`. Vault repo keys are merged into the
bundle (vault wins on secret mismatch). Optional `--import-local-delegate`.

## Browser sync rules

- **Vault & sync → Repo keys: vault ↔ this node** — check drift; Push / Pull to
  resolve.
- **Vault & sync → Sync CLI repos** — merges bundle into the delegate. Auto-updates
  HubVault **only if** vault and this node were already **in sync** before the
  merge. If they were out of sync, the delegate still updates; resolve conflicts
  under Repo keys first.

## Security

- API key unlocks repos DEK + ops signer only.
- Opening a full `.bundle` still exposes the seed on the CLI machine.
- Revoke leaked keys in Settings. Password changes do not revoke API keys.

---

# GitAtlas repo CLI (`gitatlas-repo`)

Owner ops against **RepoState + HubRegistry** (and ensures **HubRepoMeta** where
needed). These need dual-sig / repo-owner signing, so the CLI opens your
identity **bundle** and imports into the local hub-identity delegate — vault
API keys alone cannot SignRegister / SignRepoDescription.

```sh
npm run gitatlas-repo -- about \
  --bundle ~/path/to/git-identity.bundle \
  --bundle-passphrase '…' \
  --prefix 7FMQGtHpkidg \
  --label gitatlas \
  --description 'Git forge for Freenet — tip-pack browse without a central server.' \
  --website 'http://127.0.0.1:7509/v1/contract/web/…/' \
  --topics freenet,git,freenet-git

npm run gitatlas-repo -- register --bundle … --prefix … --label …
npm run gitatlas-repo -- unregister --bundle … --prefix …
npm run gitatlas-repo -- rename --bundle … --prefix … --name NewName
npm run gitatlas-repo -- delete --bundle … --prefix …   # soft-delete + unregister
```

Omit `--website` / `--topics` on `about` to keep the live HubRegistry values.
