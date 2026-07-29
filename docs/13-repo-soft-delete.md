# Soft-delete repositories (Freenet / GitAtlas)

Freenet cannot hard-erase published contracts. Packs are content-addressed;
peers may keep copies in LRU caches. Soft-delete means **owner-signed
abandonment**: a tombstone on the freenet-git repo contract, plus unregister
from HubRegistry Discover.

## Convention

| Signal | Where | Purpose |
|--------|--------|---------|
| Extension key **`deleted`** | `RepoState.extensions` | Machine-readable; value UTF-8 JSON `{"at":"<ISO-8601>"}` (optional `"reason"`) |
| Root file **`DELETED`** | Tip tree | Human-visible in clones and the GitAtlas file browser |
| Description prefix **`[deleted]`** | `RepoState.description` | Fallback for older UIs / tools that only show metadata |

**Detection order** (GitAtlas and tools):

1. Extension `deleted` present and non-empty  
2. Else tip root blob path `DELETED`  
3. Else description starts with `[deleted]` (case-insensitive)

## Owner flow (GitAtlas)

1. Confirm delete (type repository name).
2. Publish a RepoState delta: signed `deleted` extension + description starting with `[deleted]`.
3. Optionally push a tip that contains only `DELETED` (CLI / future pack push).
4. HubRegistry **remove** (dual-signed) so Discover / People stop listing the repo.
5. After tombstone + unregister succeed: hub-identity **RemoveRepoKey** for that prefix.
6. If HubVault was already **in_sync** with the delegate, auto-push the reduced key set; otherwise leave vault alone (Settings → Vault & sync).
7. Direct URL still opens; UI shows a deleted banner. Data may remain on Freenet until caches forget it.

## freenet-git

- `freenet-git delete <url>` — tombstones the repo contract (extension + description).
- Tip `DELETED` file: commit and `git push` after, or let GitAtlas rely on extension + description.

## HubRegistry

See `contracts/hub-registry/SCHEMA.md` — `{ "remove": … }` with domain
`freenethub.unregister.v1`. Tombstones keep peer merges from resurrecting a
listing until a higher-`seq` upsert re-registers.

## Related

- `docs/06-hub-registry.md`
- freenet-git `DELETED_EXTENSION_KEY` / `MIRROR_MODE_EXTENSION_KEY` patterns
