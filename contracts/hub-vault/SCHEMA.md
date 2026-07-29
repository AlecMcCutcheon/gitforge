# GitAtlas vault contract (schema)

Passwordless Freenet account vault. Ciphertext is public; only the identity SK
(or scoped API-key holders) can decrypt off-chain (SPA + CLI).

## Addressing

Parameters = UTF-8:

`gitatlas-vault-v1:` + lowercase hex of `blake3("gitatlas-vault-v1" ‖ seed)`

where `seed` is the 32-byte vault master secret (BIP39 entropy / identity SK seed).

## State (public, schema_version = 4)

| Field | Type | Notes |
|--------|------|--------|
| `schema_version` | u32 | `4` (stable — new envelopes are additive; WASM bump would change instance ids) |
| `vault_id` | string | hex blake3; must match params |
| `envelopes` | object | map of envelope id → cipher: `repos`, `pages`, … |
| `identity_dek_wrap` | object | AEAD of `{ deks }` under identity-SK-derived key |
| `api_key_wraps` | array? | wraps of `{ deks, ops_sk_hex }` under each API key |
| `authorized_ops` | array? | per-key ops VKs + scopes |
| `identity_fingerprint` | string | `freenet:id:<base58 VK>` |
| `username` | string | Display name |
| `seq` | u64 | Monotonic |
| `updated_at` | string | ISO-8601 |
| `sig_kind` | string | `owner` \| `ops` |
| `sig` | string | hex ed25519 over signing payload |

### Envelope plaintext

**`repos`:** `{ "repos": { "<prefix>": { "secret_hex", "label" } } }` — freenet-git site keys.

**`pages`:** `{ "pages": { "<prefix>": { "secret_hex", "label" } } }` — Freenet website
signing seeds for GitAtlas Pages (`hub-pages-<prefix>`). Ciphertext is public;
only identity SK (or scoped API keys with `pages` DEK) can decrypt.

**`settings`:** `{ "v": 1, … }` — private user preference KV (SPA-defined keys).
Additive: new preference keys require **no** vault WASM bump. Never put
Discover / public profile data here.

Reserved envelope ids (SPA): `repos`, `pages`, `settings`. Future additive
ids without rebuild: `drafts`, `ui`, `device_index`, `repo_seals`, …

## Signing payload

`gitatlas.vault.v4\0` + nul fields:

`vault_id`, `username`, `identity_fingerprint`,
compact `envelopes` JSON (BTreeMap key order),
compact `identity_dek_wrap` JSON,
compact `api_key_wraps` JSON (always, use `[]` if none),
compact `authorized_ops` JSON (always, use `[]` if none),
then `seq` u64 LE, then nul `updated_at`, then nul `sig_kind`.

## Identity DEK wrap

- Wrap key = `blake3("gitatlas.vault.identity-dek-wrap-v1\0" ‖ identity_sk)`.
- Ciphertext payload: `{ "deks": { "repos": "<hex>", "pages": "<hex>", "settings": "<hex>" } }`.
- Lets a signed-in identity (same SK) read/write envelopes without a vault password.
