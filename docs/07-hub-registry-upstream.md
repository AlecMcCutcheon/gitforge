# Upstream adapter notes (freenet-git Phase 4+)

When freenet-git ships network discovery and release artifact contracts, keep GitForge routes stable and swap data sources.

## Discovery

| Today | Upstream |
|-------|----------|
| Seeds + bridge ForgeRegistry | ForgeRegistry WASM (`contracts/forge-registry`) + freenet-git discovery later |
| Register via whoami attestation | Dual-sig register via forge-identity delegate (website) / bridge local-bundle |

Adapter hook: `web/src/registry/client.ts` — website mode uses contract WS; bridge keeps HTTP. Shared `ForgeRegistration` fields (+ `repo_owner_vk` for dual-sig).

## Releases

| Today | Upstream |
|-------|----------|
| `/:prefix/:label/tags` + `/releases` from `refs/tags/*` | Signed tag refs + artifact contracts (assets, signatures) |
| About sidebar **Releases** block + title/description from annotated tags; Assets lists tip-tree ZIP | Same UX; load real artifacts from release contract |

Keep routes:

- `/:prefix/:label/tags`
- `/:prefix/:label/releases`
- `/:prefix/:label/releases/:tag`

Tags page remains the raw git ref list. Releases page shows title, description, and Assets (ZIP today; signed artifacts later).

## Encrypted packs

Do not add Hub private-repo UI until freenet-git encrypted packs ship. Public-only remains the product.
