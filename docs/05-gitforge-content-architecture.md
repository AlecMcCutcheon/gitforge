# GitForge content architecture

## Modes

| Mode | When | Content path |
|------|------|----------------|
| **Bridge** | Retired (`attic/local-api-server`) | Website SPA + Freenet WS only; ForgeRegistry is a Freenet contract |
| **Website** | Published SPA (`fdev website` / Freenet website contract) | Browser tip-browse (`VITE_BROWSER_NATIVE=1` or `/v1/contract/web/…`); registry via ForgeRegistry Freenet contract when live |

## Tip browse

Code tab always prefers **tip packs** (not full clone). Bridge uses `freenet-forge-tip`; browser mode uses IndexedDB + `freenet-forge-decode` wasm.

## Public only

freenet-git Phase 1 is public-only. GitForge does not invent private Hub modes.
