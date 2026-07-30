# ForgeRegistry

Discover = **always-visible official seeds** (`server/src/urls.ts` / embedded demos) **+** ForgeRegistry listings.

## Bridge (local Express)

- File: `~/.local/share/freenet-gitforge/forge-registry.json`
- Register: `POST /api/registry/register` — requires prefix in local `freenet-git whoami` registry
- Create from Hub (`POST /api/repos/create`) also registers after a successful `freenet-git create`
- List: `GET /api/registry`
- Lookup: `GET /api/registry/:prefix`
- People: `GET /api/people/:fingerprint` → UI `/people/:fingerprint`

Attestation: `local-bundle-v1` (prove ownership via identity bundle).

## Freenet contract (WASM)

Crate: `contracts/forge-registry/` — see `SCHEMA.md`.

- Parameters: UTF-8 `gitforge-registry-v1`
- State: JSON `{ schema_version, repos, removed? }` keyed by `repo_prefix`
- Updates: `{ "upsert": <entry> }`, `{ "remove": <op> }`, or
  `{ "add_contributor" | "remove_contributor": <grant> }` with
  `attestation: "dual-sig-v1"` (identity + repo owner ed25519)
- Soft-delete / unregister: see `docs/13-repo-soft-delete.md` and `SCHEMA.md`
- Contributors: see `SCHEMA.md` — accept invite dual-signs a grant onto
  `contributors[prefix][fingerprint]` using the imported site key
- Build: `bash scripts/build-forge-owner-tools.sh` (or `cargo build --release --target wasm32-unknown-unknown -p freenet-forge-registry`)
- Publish: `fdev publish --code web/public/hub_registry.wasm --parameters <params file> contract --state <empty json>`

SPA (website / `VITE_BROWSER_NATIVE=1`) reads Discover/People via Freenet WS GET (`web/src/freenet/forge-registry.ts`). Register / unregister use the forge-identity delegate then Update.

Client facade: `web/src/registry/client.ts`.
