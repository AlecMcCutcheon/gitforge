# GitAtlas – Agent / Contributor Guide

[CONTRIBUTING.md](CONTRIBUTING.md) is the authoritative contribution policy.
In short:

- **Bug fixes** and **non-overreaching performance improvements** (no behavior
  change) — accepted without prior discussion.
- **Features, behavior changes, API / schema reshaping** — require an issue
  approved by a maintainer **before** writing the bulk of the code. Feature
  PRs without an approved issue may be closed.
- **One logical change per PR.**

When unsure which bucket a change is in, open an issue first.

## Project Layout

```
gitatlas/
├── web/                 # React SPA (primary product surface)
├── contracts/           # Hub WASM contracts (registry, vault, stars, …)
├── delegates/           # hub-identity, hub-pages
├── decode-wasm/         # browser RepoState / tip helpers
├── browse-tool/         # tip pack CLI helper
├── freenet-linguist/    # language detection for the sidebar
├── freenet-licensee/    # LICENSE / community-file helpers
├── scripts/             # publish website, owner tools, vault CLI
├── docs/                # architecture notes
└── attic/               # retired local API (do not revive without an issue)
```

## Behavioral Rules

### BEFORE modifying product behavior

1. Is this a **feature / behavior / API / schema** change?
   → Confirm there is an **approved issue** (see CONTRIBUTING.md).
2. Does it only work on a **custom freenet-core fork**?
   → Say so in the issue. Prefer designs that degrade cleanly on stock nodes.
3. Touching Hub contracts or vault envelopes?
   → Plan compatibility (dual-read / migration). Breaking silent schema churn
     burns users’ sealed state.

### BEFORE changing `web/`

- Prefer Freenet **website-native** paths (`VITE_BROWSER_NATIVE` / published
  site). Do not reintroduce a required local Express API (`attic/` is retired).
- Identity: freenet-git **bundle** is the credential; HubVault is a helper.
- Do not gate node storage / retention on app hub-identity alone. Node-operator
  consent belongs on the Freenet shell / node, not “anyone who minted an
  identity in the SPA.”
- Avoid committing generated `web/dist/`, `node_modules/`, or secrets.

### BEFORE changing contracts / delegates

- Rebuild and republish with the project scripts; keep SCHEMA notes in sync.
- Owner / registry tools: `npm run build:owner` and
  `scripts/publish-owner-tools.sh` when WASM changes.

### BEFORE committing

1. No secrets, identity bundles, vault API keys, or `.env` files.
2. Conventional commit subject (`feat:`, `fix:`, `docs:`, …).
3. PR body explains **why**; link the approved issue for features.
4. Note how you verified (publish + hard-refresh preferred).

### WHEN fixing a bug

Prefer a clear reproduction in the issue or PR (steps, expected, actual). If
you add automated coverage, keep it focused on the failure mode.

### WHEN using AI

Disclose assistance on the PR (`[AI-assisted - …]`). You still own the design
and must be able to defend it.

## Primary Verification

```sh
npm install
npm run publish:website   # needs a running Freenet node + fdev
```

Open the printed website URL and hard-refresh. See
[`docs/08-website-publish.md`](docs/08-website-publish.md).

## Related Docs

- [`docs/05-freenethub-content-architecture.md`](docs/05-freenethub-content-architecture.md)
- [`docs/06-hub-registry.md`](docs/06-hub-registry.md)
- [`docs/10-hub-vault-auth.md`](docs/10-hub-vault-auth.md)
- [`docs/11-hub-stars.md`](docs/11-hub-stars.md)
