# Hub stars

Public, signed stars for GitForge repositories. Counts are durable on Freenet
via the singleton **ForgeStars** contract (not ForgeRegistry).

## Contract

- Params (UTF-8): `gitforge-stars-v1`
- State: `by_repo[repo_prefix][fingerprint] = { starred_at, label?, sig }`
- **Count** for a repo = number of fingerprint keys under that prefix.

## Signing

Identity delegate ops:

- `SignStar` — domain `gitforge.star.v1\0` + `repo_prefix`, `fingerprint`,
  `label` (empty if absent), `starred_at`
- `SignUnstar` — domain `gitforge.unstar.v1\0` + `repo_prefix`,
  `fingerprint`, `starred_at`

Only the fingerprint whose verifying key matches the signature may add or remove
its own entry. Updates are JSON envelopes `{ "star": … }` / `{ "unstar": … }`.

## SPA

- Repo header **Star** button (website mode) — requires vault login / unlocked
  identity on the node.
- Discover cards show ★ count when > 0.
- People page **Stars** tab lists repos starred by that fingerprint (scan of
  `by_repo`, or reverse index if added later).

Stars are public; private encrypted star lists are out of scope for this phase.

## Build

Included in `npm run build:owner` (`hub_stars.wasm` / `.pkg`). Republish the
website after regenerating `owner-constants.ts`.

See `contracts/forge-stars/SCHEMA.md`.
