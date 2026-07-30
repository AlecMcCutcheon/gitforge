# ForgeStars contract (schema)

Public star index for GitForge repos. Anyone may read; only the starring
identity may add or remove its own entry under a `repo_prefix`.

## Parameters

UTF-8 `gitforge-stars-v1` (singleton for a given WASM code hash).

## State

```json
{
  "schema_version": 1,
  "by_repo": {
    "<repo_prefix>": {
      "<fingerprint>": {
        "starred_at": "ISO-8601",
        "label": "optional-label",
        "sig": "<hex ed25519>"
      }
    }
  }
}
```

Star **count** for a repo = number of keys under `by_repo[prefix]`.

## Signing

**Star:** domain `gitforge.star.v1\0` + nul fields `repo_prefix`, `fingerprint`,
`label` (empty if absent), `starred_at`.

**Unstar:** domain `gitforge.unstar.v1\0` + nul fields `repo_prefix`,
`fingerprint`, `starred_at` (client timestamp of unstar request).

VK = base58 after `freenet:id:` in fingerprint.

## Updates

JSON envelopes:

- `{ "star": { "repo_prefix", "fingerprint", "starred_at", "sig", "label"? } }`
- `{ "unstar": { "repo_prefix", "fingerprint", "starred_at", "sig" } }`

Contract verifies signature and that fingerprint matches the map key being written/removed.
