# ForgeRepoMeta contract (schema)

Per-repository settings and message channels. One instance per `repo_prefix`.
Keeps heavy / appendable data off the global ForgeRegistry Discover singleton.

## Addressing

Parameters = UTF-8:

`gitforge-repo-v1:` + `repo_prefix`

## State (schema_version = 1)

| Field | Type | Notes |
|--------|------|--------|
| `schema_version` | u32 | `1` |
| `repo_prefix` | string | must match params (8..=24) |
| `repo_owner_vk` | string | base58 site key VK (SPA cross-checks registry) |
| `seal_pk` | string | 64 hex X25519 public key for private channel (or empty) |
| `public_settings` | object | `string → string` adaptive plaintext settings |
| `sealed_settings` | object? | optional AEAD cipher (`alg`, `nonce_b64`, `blob_b64`) — owner/site dual-sig covers it; SPA decrypts with site-derived key |
| `channels` | object | `{ "public": [...], "private": [...] }` |
| `identity_fingerprint` | string | listing owner `freenet:id:…` |
| `attestation` | string | `dual-sig-v1` on upsert |
| `identity_sig` / `repo_owner_sig` | hex | upsert dual-sig |
| `seq` | u64 | monotonic on owner upsert |
| `updated_at` | string | ISO-8601 |

### Channel message

| Field | Notes |
|--------|--------|
| `id` | unique ≤64 |
| `body_b64` | **public** channel: base64 UTF-8 JSON plaintext ≤16KiB b64 |
| `ciphertext_b64` | **private** channel: sealed to `seal_pk` ≤16KiB b64 |
| `created_at` | ISO-8601 |
| `sender_vk` | base58 ed25519 |
| `sender_sig` | hex over append payload |
| `thread_id` | optional string ≤64 |

Max **128** messages per channel. Message `kind` (`issue`, `security-report`,
`note`, …) lives inside SPA plaintext — WASM does not name channels “issues”.

### Settings bags

`public_settings`: SPA conventions only (WASM size-checks). Examples: UI
defaults visible to visitors, feature flags.

`sealed_settings`: private owner/contributor settings ciphertext.

## Owner upsert signing

`gitforge.repo-meta.upsert.v1\0` + nul fields:

`repo_prefix`, `repo_owner_vk`, `seal_pk`,
canonical JSON `public_settings`,
canonical JSON `sealed_settings` (or empty string if none),
`identity_fingerprint`,
seq u64 LE, `updated_at`.

Channel message bodies are **not** in the upsert payload (appends do not
invalidate owner dual-sig). Owner prune = upsert with truncated channel arrays
(messages cleared in state after sig verify of upsert core).

## Append public

Envelope: `{ "append_public": <ChannelMessage> }`

Domain: `gitforge.repo-meta.append-public.v1\0` + nul:
`repo_prefix`, `id`, `body_b64`, `created_at`, `sender_vk`,
`thread_id` (or `""`).

Requires live state with non-empty `repo_owner_vk`. Rejects when full / dup id.

## Append private

Envelope: `{ "append_private": <ChannelMessage> }`

Domain: `gitforge.repo-meta.append-private.v1\0` + nul:
`repo_prefix`, `id`, `ciphertext_b64`, `created_at`, `sender_vk`,
`thread_id` (or `""`).

Requires non-empty `seal_pk`. Rejects when full / dup id / missing ciphertext.

## Updates

- `{ "upsert": <state> }` — owner identity + site key; `seq` must increase.
- `{ "append_public": … }` / `{ "append_private": … }` — sender identity.
- Full-state merge for peer sync (validate upsert core when present).
