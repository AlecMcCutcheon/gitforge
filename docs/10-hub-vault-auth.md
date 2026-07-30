# GitForge identity & vault auth

Identity-first account model: you create or restore an identity on a Freenet
node. Profile and vault contracts are ensured as part of that account — there
is no separate “unlock vault with password + TOTP” login.

## Ways onto a node

| Path | What happens |
|------|----------------|
| **Create identity** | Seed → local identity delegate; put profile (with inbox) + empty vault if missing. **No** auto vault→delegate pull. Download freenet-git identity bundle before leaving create. |
| **Import identity bundle** | Same ensure; leave existing vault alone; **no** auto pull (use Settings → Sync). |
| **Recovery phrase (24 words)** | Same ensure; if vault exists, **auto pull** repos into the local delegate. |
| **Already signed in** | Soft-ensure profile/vault; Sync for manual push/pull. |

There is no ForgeIdentity Freenet contract. Public display = profile contract.
Secrets = local delegate (+ vault ciphertext on Freenet).

## Contracts

### Profile (`gitforge-profile-v1:` + fingerprint)

Public bio/username/avatar plus encrypted inbox:

- `inbox_pk` — X25519 seal public key (deterministic from identity seed)
- `inbox_messages` — opaque sealed blobs (anyone may append; owner prunes)

Owner signature covers bio + `inbox_pk` with messages always signed as `[]`, so
anonymous appends do not invalidate the owner sig.

### Vault (`gitforge-vault-v1:` + blake3 vault id)

Passwordless schema v4. Envelope DEKs are sealed in `identity_dek_wrap` under a
key derived from the identity SK. Optional API-key wraps for CLI automation.

Envelopes:

- **`repos`** — freenet-git site keys (prefix → secret)
- **`pages`** — GitForge Pages website signing seeds (prefix → secret); synced
  with pages-delegate via the same Push/Pull as repos

Address:

`gitforge-vault-v1:` + hex(`blake3("gitforge-vault-v1" ‖ seed)`)

See `contracts/forge-vault/SCHEMA.md` and `contracts/forge-profile/SCHEMA.md`.

## Sync (Settings → Sync)

| Action | Effect |
|--------|--------|
| Push | Delegate repo keys + Pages website keys → vault (owner-signed) |
| Pull | Vault repos → forge-identity; vault pages → pages-delegate |
| Status | Compare both envelopes (overall kind = worst of repos vs pages) |

Create / bundle import do not auto-pull. Phrase restore does.

## API keys

Mint and revoke while signed in with identity only (no vault password / TOTP).
Keys unwrap scoped envelope DEKs + a per-key ops signing key — never the
identity seed. Use with `scripts/cli/gitforge-vault.ts`.

## Recovery

- **Primary:** freenet-git identity bundle (+ passphrase)
- **Secondary:** 24-word BIP-39 recovery phrase (same seed)

There is no password-only vault recovery. Emphasize bundle download on create.

## Domain rename (intentional wipe)

`freenethub-*` / `gitatlas-*` param domains are replaced by `gitforge-*`. Old
ForgeVault / ForgeProfile / registry addresses do not resolve on this network.
