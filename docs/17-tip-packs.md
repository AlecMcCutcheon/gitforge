# Tip packs on Freenet (how they work, how they break, how to fix)

This is the operator guide for **“commit … not in tip pack”**, **“missing tree …”**,
and related GitForge browse failures. In-app copy lives under **Docs → Tip packs**.

## Mental model

A Freenet git repo is **not** a full clone on every node.

| Piece | What it is |
|-------|------------|
| **Repo contract** | Signed `RepoState`: refs (`main` → commit hex), tipped-bundle index, mirror mode, metadata |
| **Tip pack** | A content-addressed pack contract (single or chunked) that holds git objects for **one tip commit** (and whatever objects that push included) |
| **Tipped bundles** | Entries on `RepoState` pointing at pack/manifest hashes + `tip_commit` |
| **Soft-fill** | GitForge browser loads the HEAD tip pack first, then merges older tipped packs so nested trees / history become available |

GitForge **never full-clones** for browse. It:

1. GETs `RepoState`
2. Resolves the branch/tag to a commit
3. Loads the tip pack(s) for that tip (plus soft-fill of other tipped bundles)
4. Decodes objects in-process (wasm) and walks trees/blobs

If the **ref** points at commit `C` but no tipped pack actually contains `C` (or its
root tree), browse fails with:

- `commit <hex> not in tip pack`
- `missing tree <hex>`

**Rescue does not invent missing objects.** It only re-PUTs packs that already
exist in a tipped-bundle list / local cache / `--from` reconstruction of *known*
bundle IDs.

## Mirror modes

Controlled by `FREENET_GIT_MIRROR_MODE` on push (`git-remote-freenet` / freenet-git):

| Mode | Pack contents | Soft-fill / pin implication |
|------|---------------|-----------------------------|
| **`history`** (typical) | Incremental / thin-ish tips: new tip may assume older tip packs still hold ancestor objects | “Current tip packs” ≈ **whole tipped soft-fill set** — chronologically older packs can still be live |
| **`snapshot`** | Self-contained pack for the tip (full tree closure) | Browse works from **one** tip pack; older tipped bundles are often dead weight |

A **history** tip that is only a few hundred bytes after an empty commit usually
means “delta only” — the tree never landed. That is how empty-tip republishes
fail.

## Why Rescue / Repo health “succeeds” but browse still breaks

| Action | What it does | What it cannot do |
|--------|--------------|-------------------|
| GitForge **Rescue** / auto-rescue | Re-PUT tipped packs from IDB, backup, or network soft-GET | Create a pack that was never published |
| `freenet-git rescue` | Re-PUT every bundle `RepoState` still lists | Same — only known bundle IDs |
| `freenet-git rescue --from .` | Rebuild bytes for **listed** bundles from a local clone | Fix a ref whose tip objects were never in any listed bundle |
| Soft-fill | Merge other tipped packs into memory | Find objects that were never pushed |

Classic failure:

1. Freenet `refs/heads/main` → `b676cee…`
2. Local / GitHub already moved on (or the tip pack for `b676cee` was thin / cold / never complete)
3. Rescue reports `rescued N bundle(s)` / Packs reachable `N/N`
4. Browse still throws `commit b676cee… not in tip pack` because **reachability ≠ object closure**

## Fix playbook (owner machine)

Prereqs: Freenet node up, `FREENET_GIT_IDENTITY` + passphrase, repo checkout with
the missing objects (`git cat-file -t <oid>`).

### 1. Confirm the mismatch

```bash
git ls-remote freenet HEAD
git rev-parse HEAD
git cat-file -t <missing-oid>   # must succeed locally
```

If Freenet HEAD is an oid that local has but browse fails, tip **content** is
stale even when the ref looks “correct.”

### 2. Prefer a snapshot republish (reliable browse restore)

Publish a **self-contained** tip with the **current tree** (same tree as local
`HEAD` is fine — does not rewrite GitHub history):

```bash
export FREENET_GIT_IDENTITY=…   # identity bundle path
export FREENET_GIT_PASSPHRASE=…  # quote if it has spaces
export FREENET_GIT_MIRROR_MODE=snapshot

TREE=$(git rev-parse 'HEAD^{tree}')
ORPHAN=$(git commit-tree "$TREE" -m "chore: snapshot republish tip onto Freenet")

git push --force freenet "$ORPHAN:refs/heads/main"
freenet-git rescue --only-current-tips --from . 'freenet::<prefix>/<label>'
```

Notes:

- Local `main` / GitHub stay on the real history commit; only the Freenet tip is
  the orphan snapshot (same tree → same files).
- Expect a **large** pack (hundreds of KiB to multi-MiB), not a ~200 B tip.
- Hard-refresh GitForge after rescue.

### 3. What *not* to rely on alone

```bash
# Re-PUTs existing tipped bundles only — often a no-op for “not in tip pack”
freenet-git rescue --rescue-all 'freenet::<prefix>/<label>'

# Empty commit + history push often publishes a thin tip without the tree
git commit --allow-empty -m "republish"
git push freenet main
```

### 4. After browse works: history mode again (optional)

Once snapshot restored the tip, later pushes with
`FREENET_GIT_MIRROR_MODE=history` can grow a tipped soft-fill chain again.
Pin retention **Current tip packs** then keeps the **live tip closure**, not
“newest by age only.”

CLI `git push freenet` does **not** auto-pin; open the repo in GitForge
(ProtectWorker) or hit **Sync** after CLI pushes.

## GitForge UI signals

| Signal | Meaning |
|--------|---------|
| Repo health · Packs reachable `N/N` | Soft-GET / local cache can fetch tipped pack contracts |
| `commit … not in tip pack` | Object graph for the tip is incomplete even if packs “reachable” |
| Languages missing until Settings→back | Soft-fill race (fixed: language stats await soft-fill) |
| Pin · Current tip packs | Live tip-graph keys, not “last pack by timestamp” |

## Related docs

- [15-freenet-git-ws-hygiene.md](./15-freenet-git-ws-hygiene.md) — WS / chunked pack transport
- [05-gitforge-content-architecture.md](./05-gitforge-content-architecture.md) — browse vs bridge
- Upstream freenet-git large-repo notes (sibling checkout): `freenet-git/docs/`
