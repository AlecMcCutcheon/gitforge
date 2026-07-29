# GitAtlas

**GitAtlas** is a forge for git hosted on [Freenet](https://freenet.org) —
browse, publish, and collaborate without a central GitHub-style server.
Repositories live as Freenet contracts ([`freenet-git`](../freenet-git/));
GitAtlas is the UI and the Hub contracts that make that usable day to day.

Freenet forgets what is not kept hot (LRU hosting). GitAtlas leans into that:
identity stays a portable **freenet-git bundle**, while an optional **HubVault**
and **identity-delegate backup pins** keep tip packs, keys, and preferences
recoverable across reloads and nodes — without replacing the bundle as the
source of authentication.

## Why it exists

- **Decentralized forge UX** — Discover, profiles, stars, settings, and tip-pack
  Code browse against your local Freenet node.
- **Freenet-native durability** — Auto-updating tip backups and vault sync so
  “the network dropped my pack” is recoverable from *your* pins, not a company
  CDN.
- **Identity you own** — Create / restore / download a freenet-git identity
  bundle; vault and delegate layers are helpers, not a lock-in account.

## Working today

| Area | What works |
|------|------------|
| **Website SPA** | Published Freenet website contract (`npm run publish:website`) |
| **Discover** | Seed demos + HubRegistry listings |
| **Identity** | Create, recovery phrase, import bundle, sign-out |
| **HubVault** | Passwordless vault auto-provision; settings + key sync |
| **Repos** | New empty repo, register on Hub, tip-pack Code / Commits / Tags / Branches |
| **Stars** | HubStars contract; star / unstar; profile Stars tab |
| **People** | Profile overview, repositories, stars |
| **Backups** | Per-repo tip pins on the identity delegate; auto-update; separate “all my repos” / “all starred” toggles (one pin per prefix) |
| **Languages** | Linguist-style sidebar bar over tip blobs |
| **Repo health** | Pack / Hub reachability + rescue paths |
| **Inbox** | Profile inbox for system / invite-style messages |

## Freenet-shaped design choices

- **Identity bundle first** — Downloadable freenet-git CLI bundle is the main
  credential and offline backup.
- **HubVault + delegate** — Sealed settings (including backup prefs) and tip-pin
  metadata ride with the signed-in identity so a Freenet sandbox wipe does not
  erase your pin index. Sign-out clears the identity session (and those
  delegate pins); signing back in with auto-backup prefs on recreates them.
- **Tip-pack browse** — Code view streams tipped packs over the node WS
  (IndexedDB + wasm), not a full local clone.
- **Publish to test** — No local Express/Vite loop; the real surface is the
  Freenet website contract.

## Layout

```
freenet-gitatlas/
├── browse-tool/       # tip pack helper
├── decode-wasm/       # RepoState helpers for the browser
├── contracts/         # HubRegistry, HubVault, HubStars, HubRepo, …
├── delegates/         # hub-identity, hub-pages
├── docs/              # deeper architecture notes
├── freenet-linguist/  # language bar
├── freenet-licensee/  # LICENSE detection
├── scripts/           # publish / owner-tool helpers
├── web/               # React SPA
├── attic/             # retired local :8787 API
└── README.md
```

## Prerequisites

- Freenet node (network mode)
- `fdev` on `PATH`
- `freenet-git` / `git-remote-freenet` for CLI git ops
- Node.js 20+, Rust toolchain (WASM / tip helper)

## Setup

```sh
cd freenet-gitatlas
npm install
```

## Publish (primary test surface)

```sh
# Node already running (e.g. systemctl --user start freenet)

npm run build:owner
bash scripts/publish-owner-tools.sh   # after owner WASM changes

npm run publish:website
```

Open the URL from the publish output (typically
`http://127.0.0.1:7509/v1/contract/web/<key>/`) and hard-refresh.

See `docs/08-website-publish.md`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `FREENET_HUB_WEBSITE_KEY` | `freenethub` | `fdev website` key name |
| `FREENET_WS_URL` | `ws://127.0.0.1:7509/v1/contract/command` | Node WS |
| `FREENET_HUB_PAGES_BASE` | `http://127.0.0.1:7509/v1/contract/web` | Pages base URL |

## License

**LGPL-3.0-only** — same as [`freenet-git`](../freenet-git/). See [`LICENSE`](LICENSE).

## Docs

`docs/05-freenethub-content-architecture.md`, `docs/06-hub-registry.md`,
`docs/08-website-publish.md`, `docs/09-hub-pages.md`, `docs/10-hub-vault-auth.md`,
`docs/11-hub-stars.md`.
