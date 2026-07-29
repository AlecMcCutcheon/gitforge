# Publish GitAtlas as a Freenet website

Deploy the UI as a signed Freenet **website contract** via `fdev website`.

This is the **primary** test surface. There is no supported local Vite + Express
loop; tip-browse and owner tools use the Freenet node WebSocket.

## Prerequisites

- Freenet node running (`freenet` / `systemctl --user start freenet`)
- `fdev` on `PATH`

## Owner WASM (once per machine / after contract changes)

```sh
cd freenet-gitatlas
bash scripts/build-hub-owner-tools.sh
bash scripts/publish-owner-tools.sh
# → hub_registry, hub_stars, hub_identity, …
# HubVault is Put per-email on Account register
```

Constants land in `web/src/freenet/owner-constants.ts`. Assets under
`web/public/*.wasm` (gitignored — regenerate via `build:owner`).

## Build + publish website

```sh
cd freenet-gitatlas
npm run publish:website
```

Key name defaults to `freenethub` (override with `FREENET_HUB_WEBSITE_KEY`).

Open the **Website URL** from `fdev website list` (typically
`http://127.0.0.1:7509/v1/contract/web/<key>/`). Hard-refresh after each publish.

Account / stars docs: `docs/10-hub-vault-auth.md`, `docs/11-hub-stars.md`.
