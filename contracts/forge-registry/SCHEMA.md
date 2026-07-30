# ForgeRegistry contract (schema)

Public GitForge discovery listings.

**Bridge (Express):** `forge-registry.json` with `attestation: "local-bundle-v1"`.

**Network (WASM):** this contract — only `attestation: "dual-sig-v1"`.

## Invariants

- Open register (anyone with a GitForge identity delegate may list a repo they own).
- **One listing per `repo_prefix`** (Freenet git URL fingerprint).
- Ownership proof on-network:
  1. Identity key signs the listing payload.
  2. Repo owner key co-signs the same payload.
- Same identity may update metadata (`seq++`). Different identity cannot overwrite.

## State entry

| Field | Type | Notes |
|-------|------|--------|
| `schema_version` | u32 | `1` |
| `repo_prefix` | string | Base58 prefix of repo owner VK |
| `label` | string | URL label |
| `name` | string? | Display name |
| `description` | string? | Short blurb (mirrored from repo About; Discover) |
| `website` | string? | Project / homepage URL (About); default unset |
| `topics` | string[] | Custom tags (About / future search); default `[]` |
| `public_meta` | object | `string → string` adaptive bag (SPA flags; default `{}`) |
| `identity_fingerprint` | string | `freenet:id:<base58 identity VK>` — **owner id** |
| `identity_name` | string | **Unused for display** — always empty on new listings. Username comes from ForgeProfile for this fingerprint. Kept in signing payload for compatibility. |
| `identity_email` | string? | Unused for display (ForgeProfile `public_email`); empty on new listings |
| `repo_owner_vk` | string | Base58 of full 32-byte repo owner VK (**required** for dual-sig) |
| `attestation` | string | `dual-sig-v1` on WASM; bridge may use `local-bundle-v1` |
| `identity_sig` | hex string | ed25519 over canonical payload |
| `repo_owner_sig` | hex string | ed25519 over canonical payload |
| `seq` | u64 | Monotonic per prefix |
| `updated_at` | string | ISO-8601 |

## Signing payload

Domain-separated bytes (same in contract + delegate):

`gitforge.register.v2\0` + nul-terminated fields
`repo_prefix`, `label`, `name`, `description`, `website`, `topics`,
`identity_fingerprint`, `identity_name`, `identity_email`, `repo_owner_vk`,
**canonical JSON of `public_meta`** (BTreeMap key order, compact; empty `{}`),
then `seq` as u64 LE, then nul-terminated `updated_at`. Empty optionals are
empty strings. `topics` is lowercased, sorted, deduped, comma-joined.

### `public_meta` (listing)

Light Discover-card flags only — **not** message channels or large blobs.
WASM does not interpret keys. Limits: ≤32 keys, key ≤64, value ≤1024.

SPA conventions (examples): `archived`, `has_pages`, feature toggles.
Primary language cache (owner dual-sig only, after linguist on tip load):
`lang`, `lang_color`, `lang_tip`, `lang_at`.

Heavy / appendable / sealed repo data lives on **ForgeRepoMeta**
(`gitforge-repo-v1:<prefix>`), not here.

## Parameters

UTF-8 `gitforge-registry-v1` (singleton instance for a given WASM code hash).

## Updates

JSON envelopes:

- `{ "upsert": <entry> }` — list or refresh metadata (`seq` must increase).
- `{ "remove": <remove-op> }` — soft-unregister (Discover drop). See below.
- Or full `ForgeRegistryState` merge.

### Remove op

| Field | Type | Notes |
|-------|------|--------|
| `schema_version` | u32 | `1` |
| `repo_prefix` | string | Same as entry |
| `identity_fingerprint` | string | Must match listed owner |
| `repo_owner_vk` | string | Base58 repo owner VK |
| `attestation` | string | `dual-sig-v1` |
| `identity_sig` / `repo_owner_sig` | hex | Dual-sig over unregister payload |
| `seq` | u64 | Must be **greater** than the live entry’s `seq` |
| `updated_at` | string | ISO-8601 |

Unregister signing domain: `gitforge.unregister.v1\0` + nul-terminated
`repo_prefix`, `identity_fingerprint`, `repo_owner_vk`, then `seq` as u64 LE,
then nul-terminated `updated_at`.

State also keeps `removed[repo_prefix] = <remove-op>` tombstones so peer
merges do not resurrect a listing until a later upsert with higher `seq`.

## People

Filter registry by `identity_fingerprint` (SPA /People). Soft-removed prefixes
are absent from `repos` (only in `removed`).

## Contributors

Accepted collaborators (site-key holders who opted in on invite accept).

State map: `contributors[repo_prefix][identity_fingerprint] → grant`.

| Field | Type | Notes |
|-------|------|--------|
| `schema_version` | u32 | `1` |
| `repo_prefix` | string | Must match a live listing |
| `identity_fingerprint` | string | Contributor id (not the listing owner) |
| `repo_owner_vk` | string | Must match the listing’s repo owner VK |
| `attestation` | string | `dual-sig-v1` |
| `identity_sig` / `repo_owner_sig` | hex | Add: contributor + site key. Remove: listing owner or contributor + site key |
| `seq` | u64 | Monotonic per (prefix, fingerprint); lower/equal seq is idempotent on add |
| `updated_at` | string | ISO-8601 |

### Add op

Envelope: `{ "add_contributor": <grant> }`

Signing domain: `gitforge.contributor.add.v1\0` + nul-terminated
`repo_prefix`, `identity_fingerprint`, `repo_owner_vk`, then `seq` u64 LE,
then nul-terminated `updated_at`.

Requires a live listing; rejects when fingerprint equals the listing owner.

**Invite coupon (preferred):** Owner pre-signs `repo_owner_sig` over this
payload with the site key for a fixed `identity_fingerprint` (invitee) +
`seq` + `updated_at`. Invitee later adds `identity_sig` over the **same**
bytes and Puts `add_contributor` **before** importing the sealed site key.
Only the invitee’s identity seed can produce a matching `identity_sig`;
changing the fingerprint breaks the owner’s site-key signature.

**Legacy path:** Invitee who already holds the site key may dual-sign both
fields locally (`SignContributorAdd`).

### Remove op

Envelope: `{ "remove_contributor": <grant> }`

Signing domain: `gitforge.contributor.remove.v1\0` + same fields as add.
`identity_sig` must verify as either the listing owner or the contributor.

## Pending invites

Outstanding collaborator invitations (repo-level source of truth for invitation
totals). Distinct from ForgeProfile inbox messages (which are only the invitee’s
user-level notification carrying the sealed site key).

State map: `pending_invites[repo_prefix][invitee_fingerprint] → invite`.

| Field | Type | Notes |
|-------|------|--------|
| `schema_version` | u32 | `1` |
| `repo_prefix` | string | Must match a live listing |
| `identity_fingerprint` | string | Invitee id (not the listing owner) |
| `repo_owner_vk` | string | Must match the listing’s repo owner VK |
| `attestation` | string | Add/cancel: `dual-sig-v1`. Decline: `invitee-decline-v1` |
| `identity_sig` / `repo_owner_sig` | hex | See ops below |
| `seq` | u64 | Monotonic per (prefix, invitee); lower/equal seq is idempotent on add |
| `updated_at` | string | ISO-8601 |

### Add op

Envelope: `{ "add_pending_invite": <invite> }`

Signing domain: `gitforge.pending-invite.add.v1\0` + nul-terminated
`repo_prefix`, `identity_fingerprint`, `repo_owner_vk`, then `seq` u64 LE,
then nul-terminated `updated_at`.

Requires listing owner identity + site key. Rejects invitee == owner and
invitees who are already verified contributors.

Accepting a contributor grant (`add_contributor`) automatically clears the
matching pending invite row.

### Remove op

Envelope: `{ "remove_pending_invite": <invite> }`

Signing domain: `gitforge.pending-invite.remove.v1\0` + same fields as add.

- **Owner cancel:** listing owner identity + site key (`dual-sig-v1`).
- **Invitee decline:** invitee identity alone (`invitee-decline-v1`); no site
  key required (decline happens before import).

