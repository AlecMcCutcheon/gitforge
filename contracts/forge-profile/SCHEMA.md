# GitForge profile contract (schema)

Public profile fields plus encrypted inbound inbox. Addressed by identity
fingerprint (not vault seed).

## Addressing

Parameters = UTF-8:

`gitforge-profile-v1:` + `freenet:id:<base58 verifying key>`

## State (schema_version = 3)

| Field | Type | Notes |
|--------|------|--------|
| `schema_version` | u32 | `3` |
| `identity_fingerprint` | string | must match params |
| `username` | string | 1..=128 |
| `public_email` | string | ≤256 (contact metadata) |
| `bio` | string | ≤512 |
| `url` | string | ≤512 |
| `avatar` | string | ≤48000 |
| `inbox_pk` | string | 64 hex X25519 public seal key (or empty) |
| `inbox_messages` | array | opaque sealed blobs (see below) |
| `public_meta` | object | `string → string` bag (SPA conventions; see below) |
| `seq` | u64 | monotonic on owner upsert |
| `updated_at` | string | ISO-8601 |
| `owner_sig` | string | hex ed25519 |

### `public_meta` (adaptive)

WASM stores and dual-checks the map as part of `owner_sig`; it does **not**
interpret keys. Values are UTF-8 strings (often JSON). Limits: ≤32 keys,
key ≤64 bytes, value ≤4096 bytes.

SPA conventions (non-exhaustive):

| Key | Value example | Purpose |
|-----|---------------|---------|
| `status` | `{"text":"…","emoji":"…","updated_at":"…"}` | Public status |
| `pinned` | `["prefix",…]` | Pinned repo prefixes (max enforced in SPA) |

### Inbox message entry

| Field | Notes |
|--------|--------|
| `id` | unique string ≤64 |
| `ciphertext_b64` | sealed blob ≤16KiB b64 |
| `created_at` | ISO-8601 |
| `sender_vk` | **required on append** — base58 ed25519 VK of sender GitForge identity |
| `sender_sig` | **required on append** — hex ed25519 over inbox-append payload |

Max **64** messages. No public message `kind` — type lives inside plaintext.

## Owner signing payload

`gitforge.profile.v3\0` + nul fields:

fingerprint, username, public_email, bio, url, avatar, inbox_pk,
**always `[]` for inbox_messages** (appends do not invalidate owner_sig),
**canonical JSON of `public_meta`** (BTreeMap key order, compact),
seq u64 LE, updated_at.

Empty `public_meta` signs as `{}`.

## Inbox append signing payload

`gitforge.profile.inbox-append.v1\0` + nul fields:

recipient `identity_fingerprint` (contract params), `id`, `ciphertext_b64`,
`created_at`, `sender_vk`.

Verified against `sender_vk`. Proves the sender holds a GitForge identity
seed — anonymous / unsigned appends are rejected.

## Updates

- Owner upsert: full state with valid `owner_sig`; `seq` must increase.
- Identity-signed append: `{ "append_inbox": { …, sender_vk, sender_sig } }` —
  rejects when unsigned, full, or duplicate id.
