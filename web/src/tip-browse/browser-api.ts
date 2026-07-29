/**
 * Browser tip-browse: IndexedDB pack cache + wasm RepoState decode + JS pack walk.
 *
 * Freenet contract GET uses the local node WebSocket when `VITE_FREENET_WS_URL`
 * is set (default ws://127.0.0.1:7509/...). Until a full stdlib GET client is
 * wired for pack contracts, callers can also inject pack bytes via
 * `seedTipPack` (useful for tests / offline demos).
 *
 * History tip packs are incremental: the tip pack has the tip commit + new
 * objects; older trees/blobs live in older tipped packs along the first-parent
 * chain (same strategy as browse-tool).
 */

import {
  clearMemoryPacksForPrefix,
  clearAllMemoryPacks,
  idbClearPacksForPrefix,
  idbDeletePack,
  idbGetPack,
  idbPutPack,
} from "./idb-cache";
import {
  tipCacheEpoch,
  tipCacheEpochValid,
} from "../freenet/tip-cache-lifecycle";
import {
  decodeChunkedManifest,
  pickTipBundle,
  summarizeRepoState,
  type TipBundle,
  wasmAvailable,
} from "./decode-wasm";
import {
  listTreePath,
  listAllBlobPaths,
  parseCommitFirstParent,
  peelToCommit,
  enrichTreeWithLastCommits,
  readBlobPath,
  unpackPack,
  type GitObject,
} from "./pack-decode";

const TEXT_INLINE_MAX = 512 * 1024;
const IMAGE_INLINE_MAX = 5 * 1024 * 1024;

const objectCache = new Map<string, Map<string, GitObject>>();

interface MergedTipCache {
  objects: Map<string, GitObject>;
  tipPackSize: number;
  packCount: number;
  bundleId: string;
  /** Best-effort fill of tipped packs beyond the first-parent chain. */
  softFill: Promise<void>;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const mergedTipCache = new Map<string, MergedTipCache>();

/**
 * Drop decoded objects + merged tip chains (+ pack bytes) for a repo.
 * Call when leaving a repo route so the next visit pays real Freenet cost.
 */
export function clearBrowserTipCaches(prefix?: string): void {
  if (!prefix) {
    objectCache.clear();
    mergedTipCache.clear();
    clearAllMemoryPacks();
    return;
  }
  for (const key of [...mergedTipCache.keys()]) {
    if (key.startsWith(`${prefix}:`)) mergedTipCache.delete(key);
  }
  const removed = clearMemoryPacksForPrefix(prefix);
  for (const id of removed) objectCache.delete(id);
  void idbClearPacksForPrefix(prefix);
}

interface RepoTipSummary {
  tipped_bundles: TipBundle[];
  refs?: Array<{ name: string; target: string }>;
  default_branch?: string | null;
}

function resolveRefTarget(summary: RepoTipSummary, gitRef: string): string {
  const normalized = gitRef.trim();
  if (normalized.toUpperCase() === "HEAD") {
    const branch =
      summary.default_branch?.trim() || "refs/heads/main";
    const hit = summary.refs?.find((r) => r.name === branch);
    if (hit) return hit.target.toLowerCase();
    const anyHead = summary.refs?.find((r) => r.name.startsWith("refs/heads/"));
    if (anyHead) return anyHead.target.toLowerCase();
    throw new Error(`HEAD default branch ${branch} missing`);
  }
  for (const c of [
    normalized,
    `refs/heads/${normalized}`,
    `refs/tags/${normalized}`,
  ]) {
    const hit = summary.refs?.find((r) => r.name === c);
    if (hit) return hit.target.toLowerCase();
  }
  if (/^[0-9a-f]{40}$/i.test(normalized)) return normalized.toLowerCase();
  throw new Error(`ref ${JSON.stringify(normalized)} not found`);
}

export function isBrowserNativeMode(): boolean {
  if (import.meta.env.VITE_BROWSER_NATIVE === "1") return true;
  return window.location.pathname.includes("/v1/contract/web/");
}

function bytesToBase64(buf: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function seedTipPack(
  prefix: string,
  bundleId: string,
  commit: string,
  bytes: Uint8Array,
): Promise<void> {
  await idbPutPack({
    bundleId,
    prefix,
    commit,
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    storedAt: Date.now(),
  });
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // tip-pack backup dual-write (replaced by Protect scopes)
  // try {
  //   const { backupGetPin, backupPutBlob } = await import(
  //     "../freenet/repo-backup-store"
  //   );
  //   ...
  // } catch { /* backup dual-write is best-effort */ }
  objectCache.delete(bundleId);
  // Invalidate any merged tip-chain cache for this prefix.
  for (const key of [...mergedTipCache.keys()]) {
    if (key.startsWith(`${prefix}:`)) mergedTipCache.delete(key);
  }
}

async function objectsForPack(bundleId: string, bytes: Uint8Array) {
  let objs = objectCache.get(bundleId);
  if (!objs) {
    const t0 = performance.now();
    objs = await unpackPack(bytes);
    console.info(
      `[freenet-hub] unpackPack ${bundleId.slice(0, 12)}… ${(performance.now() - t0).toFixed(1)}ms (${bytes.length} bytes, ${objs.size} objects)`,
    );
    objectCache.set(bundleId, objs);
  }
  return objs;
}

function isTipLoadCancelled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /contract GET cancelled|tip load cancelled|left repo/i.test(msg);
}

async function fetchWithRetries(
  fetchPackByHash: (
    hashHex: string,
    opts?: { soft?: boolean },
  ) => Promise<Uint8Array>,
  hash: string,
  retries: number,
  soft = false,
): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 1; i <= retries; i++) {
    try {
      return await fetchPackByHash(hash, soft ? { soft: true } : undefined);
    } catch (err) {
      last = err;
      // Don't burn retries after leave-page abort — free the WS queue.
      if (isTipLoadCancelled(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // retried Contract not found 3× → looked like an endless tip-wait loop
      // NEW CODE - TESTING: terminal miss — fail once (Freenet NotFound)
      const { isContractNotFoundError } = await import(
        "../freenet/contract-fetch-status"
      );
      if (isContractNotFoundError(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn(`tip-browse pack fetch attempt ${i}/${retries} failed`, err);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function fetchChunkedPack(
  fetchPackByHash: (
    hashHex: string,
    opts?: { soft?: boolean },
  ) => Promise<Uint8Array>,
  manifestHash: string,
  expectedChunks: number,
  opts?: { retries?: number; soft?: boolean },
): Promise<Uint8Array> {
  const retries = opts?.retries ?? 3;
  const soft = opts?.soft === true;
  const manifestBytes = await fetchWithRetries(
    fetchPackByHash,
    manifestHash,
    retries,
    soft,
  );
  const manifest = await decodeChunkedManifest(manifestBytes);
  if (expectedChunks && manifest.chunk_count !== expectedChunks) {
    throw new Error(
      `chunk_count mismatch: bundle=${expectedChunks} manifest=${manifest.chunk_count}`,
    );
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const CHUNK_CONCURRENCY = 4;
  // Parallel enqueue filled the FIFO pump; when WS died, 4×(12s×3) retries
  // bricked every other repo until the queue drained.
  // const CHUNK_CONCURRENCY = 1;
  // NEW CODE - TESTING: dedicated chunk WS pool (docs/15-freenet-git-ws-hygiene.md)
  const {
    getContractStateOnPool,
    preferredChunkConcurrency,
  } = await import("../freenet/chunk-ws-pool");
  const { packContractKey } = await import("../freenet/keys");
  const CHUNK_CONCURRENCY = await preferredChunkConcurrency();

  const hashes = manifest.chunk_hashes;
  const parts: Uint8Array[] = new Array(hashes.length);
  let next = 0;
  let shellFallbacks = 0;

  async function fetchOneChunk(hash: string): Promise<Uint8Array> {
    const want = hash.trim().toLowerCase();
    try {
      const bytes = await getContractStateOnPool(packContractKey(hash));
      const { blake3 } = await import("@noble/hashes/blake3");
      const { bytesToHex } = await import("../freenet/keys");
      const got = bytesToHex(blake3(bytes));
      if (got !== want) {
        throw new Error(
          `pack BLAKE3 mismatch: got ${got}, expected ${want}`,
        );
      }
      return bytes;
    } catch (err) {
      shellFallbacks += 1;
      console.warn(
        "[tip-browse] chunk pool GET failed, shell fallback:",
        err instanceof Error ? err.message : err,
      );
      return fetchWithRetries(fetchPackByHash, hash, retries, soft);
    }
  }

  const t0 = performance.now();
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= hashes.length) return;
      console.info(`tip-browse: chunk ${i + 1}/${hashes.length}`);
      parts[i] = await fetchOneChunk(hashes[i]!);
    }
  }
  const workers = Array.from(
    { length: Math.min(CHUNK_CONCURRENCY, hashes.length) },
    () => worker(),
  );
  try {
    await Promise.all(workers);
  } catch (err) {
    try {
      const { recordChunkPoolSample } = await import(
        "../freenet/chunk-pool-calib"
      );
      recordChunkPoolSample({
        n: CHUNK_CONCURRENCY,
        wallMs: performance.now() - t0,
        chunks: hashes.length,
        aborted: true,
      });
    } catch {
      /* ignore */
    }
    throw err;
  }
  const wallMs = performance.now() - t0;
  try {
    const { recordChunkPoolSample } = await import(
      "../freenet/chunk-pool-calib"
    );
    recordChunkPoolSample({
      n: CHUNK_CONCURRENCY,
      wallMs,
      chunks: hashes.length,
      shellHeavy: shellFallbacks > hashes.length / 2,
    });
  } catch {
    /* ignore */
  }

  let total = 0;
  for (const p of parts) total += p!.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  if (out.length !== manifest.total_size) {
    throw new Error(
      `reassembled size ${out.length} != manifest.total_size ${manifest.total_size}`,
    );
  }
  return out;
}

async function loadBundlePackBytes(
  prefix: string,
  bundle: TipBundle,
  tipCommit: string,
  fetchPackByHash?: (
    hashHex: string,
    opts?: { soft?: boolean },
  ) => Promise<Uint8Array>,
  opts?: { retries?: number },
): Promise<Uint8Array> {
  const cached = await idbGetPack(bundle.bundle_id);
  if (cached) {
    try {
      const bytes = new Uint8Array(cached.bytes);
      // Validate decode before trusting cache.
      await objectsForPack(bundle.bundle_id, bytes);
      return bytes;
    } catch (err) {
      console.warn(
        "[freenet-hub] cached tip pack failed to decode — refetching",
        bundle.bundle_id,
        err,
      );
      objectCache.delete(bundle.bundle_id);
      await idbDeletePack(bundle.bundle_id);
    }
  }

  if (!fetchPackByHash) {
    throw new Error(
      `Tip pack ${bundle.bundle_id} not in IndexedDB and no fetchPackByHash provided.`,
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always 3 outer retries × getContractState 3 attempts → soft-fill hung on cold misses
  // NEW CODE - TESTING: required tip 2 retries (NotFound fails immediately); soft-fill 1
  const retries = opts?.retries ?? 2;
  const soft = retries <= 1;

  let packBytes: Uint8Array;
  if (bundle.kind === "single" && bundle.pack_hash) {
    packBytes = await fetchWithRetries(
      fetchPackByHash,
      bundle.pack_hash,
      retries,
      soft,
    );
  } else if (bundle.kind === "chunked" && bundle.manifest_hash) {
    packBytes = await fetchChunkedPack(
      fetchPackByHash,
      bundle.manifest_hash,
      Number(bundle.chunk_count ?? 0),
      { retries, soft },
    );
  } else {
    throw new Error("unknown tip bundle kind");
  }

  await seedTipPack(prefix, bundle.bundle_id, tipCommit, packBytes);
  return packBytes;
}

function mergeObjectMaps(
  into: Map<string, GitObject>,
  from: Map<string, GitObject>,
): void {
  for (const [hash, obj] of from) {
    if (!into.has(hash)) into.set(hash, obj);
  }
}

/**
 * Resolve tip pack bytes for a prefix/ref, then merge older tipped packs along
 * the first-parent chain (and remaining tipped packs best-effort).
 */
export async function ensureBrowserTip(options: {
  prefix: string;
  gitRef: string;
  /** Raw RepoState bytes from Freenet GET */
  repoStateBytes?: Uint8Array;
  /** Fetch pack or chunk contract state by content hash (hex) */
  fetchPackByHash?: (
    hashHex: string,
    opts?: { soft?: boolean },
  ) => Promise<Uint8Array>;
  /** When set, skip writing caches if clearRepoTipCaches bumped the epoch. */
  cacheEpoch?: number;
}): Promise<{
  commit: string;
  bundleId: string;
  tipPackSize: number;
  packCount: number;
  objects: Map<string, GitObject>;
  /** Resolves when remaining tipped packs finish soft-filling into `objects`. */
  softFill: Promise<void>;
}> {
  const epoch = options.cacheEpoch ?? tipCacheEpoch(options.prefix);
  const stillValid = () => tipCacheEpochValid(options.prefix, epoch);
  if (!(await wasmAvailable()) && options.repoStateBytes) {
    throw new Error(
      "freenet-hub-decode wasm not built. Run: npm run build:wasm -w @freenet-hub/web",
    );
  }

  if (!options.repoStateBytes) {
    throw new Error(
      "Browser tip-browse needs RepoState bytes (Freenet GET) or a seeded tip pack.",
    );
  }

  const summary = (await summarizeRepoState(
    options.repoStateBytes,
  )) as RepoTipSummary;
  const tipped = summary.tipped_bundles ?? [];
  const byTipCommit = new Map(tipped.map((b) => [b.tip_commit, b]));
  const targetOid = resolveRefTarget(summary, options.gitRef);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const picked = await pickTipBundle(options.repoStateBytes, options.gitRef);
  // const commit = picked.commit;
  // const headBundle = picked.bundle;

  // NEW CODE - TESTING
  // Prefer a pack tipped exactly at the ref target; otherwise load HEAD tip
  // chain so historical tags/commits that live only in older tipped packs work.
  let headBundle: TipBundle;
  let walkStart: string;
  const exactTip = byTipCommit.get(targetOid);
  if (exactTip) {
    headBundle = exactTip;
    walkStart = targetOid;
  } else {
    let picked;
    try {
      picked = await pickTipBundle(options.repoStateBytes, "HEAD");
    } catch (err) {
      if (tipped.length === 0) throw err;
      picked = {
        commit: tipped[0].tip_commit,
        bundle: tipped[0],
      };
    }
    headBundle = picked.bundle;
    walkStart = picked.commit;
  }

  const mergedKey = `${options.prefix}:${options.gitRef}:${targetOid}:merged:v2`;
  const cachedMerged = mergedTipCache.get(mergedKey);
  if (cachedMerged) {
    try {
      const peeled = peelToCommit(cachedMerged.objects, targetOid);
      return {
        commit: peeled,
        bundleId: cachedMerged.bundleId,
        tipPackSize: cachedMerged.tipPackSize,
        packCount: cachedMerged.packCount,
        objects: cachedMerged.objects,
        softFill: cachedMerged.softFill,
      };
    } catch {
      mergedTipCache.delete(mergedKey);
    }
  }

  const merged = new Map<string, GitObject>();
  let totalPackBytes = 0;
  let packCount = 0;
  const loadedBundleIds = new Set<string>();

  const tryLoadBundle = async (
    bundle: TipBundle,
    tipCommit: string,
    required: boolean,
    retries?: number,
  ): Promise<void> => {
    if (!stillValid()) {
      throw new Error("tip load cancelled (left repo)");
    }
    if (loadedBundleIds.has(bundle.bundle_id)) return;
    const t0 = performance.now();
    try {
      const bytes = await loadBundlePackBytes(
        options.prefix,
        bundle,
        tipCommit,
        options.fetchPackByHash,
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // { retries: required ? 3 : 1 },
        // NEW CODE - TESTING: first-parent/peel keep 2; background soft-fill fail-fast 1
        { retries: retries ?? (required ? 3 : 1) },
      );
      if (!stillValid()) {
        throw new Error("tip load cancelled (left repo)");
      }
      const fetchMs = performance.now() - t0;
      const t1 = performance.now();
      const objs = await objectsForPack(bundle.bundle_id, bytes);
      const decodeMs = performance.now() - t1;
      console.info(
        `[freenet-hub] tip pack ${bundle.bundle_id.slice(0, 12)}… fetch ${fetchMs.toFixed(0)}ms decode ${decodeMs.toFixed(0)}ms (${bytes.length} bytes)`,
      );
      mergeObjectMaps(merged, objs);
      loadedBundleIds.add(bundle.bundle_id);
      totalPackBytes += bytes.length;
      packCount += 1;
    } catch (err) {
      if (isTipLoadCancelled(err)) {
        throw err instanceof Error
          ? err
          : new Error("tip load cancelled (left repo)");
      }
      if (required) throw err;
      console.warn(
        `[freenet-hub] soft-fail tipped pack ${bundle.bundle_id.slice(0, 12)}…`,
        err,
      );
    }
  };

  // 1) Tip pack (required)
  await tryLoadBundle(headBundle, walkStart, true);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // // 2) Walk first-parent tip chain — loaded EVERY tip pack on the chain
  // // before peel. Repos with many ~3MB tipped snapshots (even a tiny tree)
  // // stampeded Freenet (chunk-pool timeouts, ws 1006) and locked other pages.
  // const walkedCommits = new Set<string>();
  // let current: string | null = walkStart;
  // while (current && !walkedCommits.has(current)) {
  //   walkedCommits.add(current);
  //   const tipBundle = byTipCommit.get(current);
  //   if (tipBundle) {
  //     await tryLoadBundle(tipBundle, current, …);
  //   }
  //   …
  // }
  // let commit = peel… / load all tipped until peel
  // softFill remaining with CONC=3 unbounded
  //
  // NEW CODE - TESTING: peel ASAP from HEAD; only block-load parent tip packs
  // until the ref peels; soft-fill ancestors with conc=1 + pack/byte caps.

  let commit: string | null = null;
  try {
    commit = peelToCommit(merged, targetOid);
  } catch {
    commit = null;
  }

  /** First-parent tip packs deferred to soft-fill (HEAD already loaded). */
  const softFillPreferred: TipBundle[] = [];
  const walkedCommits = new Set<string>();
  let current: string | null = walkStart;
  while (current && !walkedCommits.has(current)) {
    walkedCommits.add(current);
    const tipBundle = byTipCommit.get(current);
    if (tipBundle && tipBundle.bundle_id !== headBundle.bundle_id) {
      if (!commit) {
        await tryLoadBundle(tipBundle, current, false, 2);
        try {
          commit = peelToCommit(merged, targetOid);
        } catch {
          commit = null;
        }
      } else if (!loadedBundleIds.has(tipBundle.bundle_id)) {
        softFillPreferred.push(tipBundle);
      }
    }
    const cObj = merged.get(current);
    if (!cObj || cObj.type !== "commit") break;
    current = parseCommitFirstParent(cObj.data);
  }

  if (!commit) {
    for (const tipBundle of tipped) {
      if (loadedBundleIds.has(tipBundle.bundle_id)) continue;
      await tryLoadBundle(tipBundle, tipBundle.tip_commit, false, 2);
      try {
        commit = peelToCommit(merged, targetOid);
        break;
      } catch {
        /* keep loading until peel works or packs exhausted */
      }
    }
  }
  if (!commit) {
    commit = peelToCommit(merged, targetOid);
  }

  // Peel annotated tags → commit; historical tags need objects from step 2/3.
  const commitObj = merged.get(commit);
  if (!commitObj || commitObj.type !== "commit") {
    throw new Error(
      `after indexing ${packCount} tipped packs, commit ${commit} is still missing`,
    );
  }

  if (!stillValid()) {
    clearBrowserTipCaches(options.prefix);
    throw new Error("tip load cancelled (left repo)");
  }

  const softFill = (async () => {
    const preferredIds = new Set(softFillPreferred.map((b) => b.bundle_id));
    const rest = tipped.filter(
      (b) =>
        !loadedBundleIds.has(b.bundle_id) && !preferredIds.has(b.bundle_id),
    );
    const remaining = [
      ...softFillPreferred.filter((b) => !loadedBundleIds.has(b.bundle_id)),
      ...rest,
    ];
    if (remaining.length === 0) return;

    // Cap background fill so one fat tip history cannot monopolize Freenet.
    const MAX_SOFT_FILL_PACKS = 4;
    const MAX_SOFT_FILL_BYTES = 12 * 1024 * 1024;
    const SOFT_FILL_CONC = 1;
    const capped = remaining.slice(0, MAX_SOFT_FILL_PACKS);
    let next = 0;
    let filled = 0;
    let filledBytes = 0;

    async function softFillWorker(): Promise<void> {
      for (;;) {
        if (!stillValid()) return;
        if (filledBytes >= MAX_SOFT_FILL_BYTES) return;
        const i = next++;
        if (i >= capped.length) return;
        const tipBundle = capped[i]!;
        if (loadedBundleIds.has(tipBundle.bundle_id)) continue;
        const before = totalPackBytes;
        await tryLoadBundle(tipBundle, tipBundle.tip_commit, false, 1);
        filled += 1;
        filledBytes += Math.max(0, totalPackBytes - before);
        const cached = mergedTipCache.get(mergedKey);
        if (cached) {
          cached.tipPackSize = totalPackBytes;
          cached.packCount = packCount;
        }
        await yieldToMain();
      }
    }

    await Promise.all(
      Array.from(
        {
          length: Math.min(SOFT_FILL_CONC, Math.max(1, capped.length)),
        },
        () => softFillWorker(),
      ),
    );
    if (filled > 0 || remaining.length > capped.length) {
      console.info(
        `[freenet-hub] soft-fill tipped packs done (+${filled}/${remaining.length}, ${packCount} packs, ${totalPackBytes} bytes` +
          (remaining.length > capped.length ||
          filledBytes >= MAX_SOFT_FILL_BYTES
            ? `, capped at ${MAX_SOFT_FILL_PACKS} packs / ${MAX_SOFT_FILL_BYTES} bytes`
            : "") +
          `)`,
      );
    }
  })();

  mergedTipCache.set(mergedKey, {
    objects: merged,
    tipPackSize: totalPackBytes,
    packCount,
    bundleId: headBundle.bundle_id,
    softFill,
  });
  return {
    commit,
    bundleId: headBundle.bundle_id,
    tipPackSize: totalPackBytes,
    packCount,
    objects: merged,
    softFill,
  };
}

export async function browserListTree(
  tip: Awaited<ReturnType<typeof ensureBrowserTip>>,
  path = "",
): Promise<{
  entries: ReturnType<typeof enrichTreeWithLastCommits>;
  commit: string;
  tipPackSize: number;
  progress: string;
}> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const entries = await listTreePath(tip.objects, tip.commit, path);

  // NEW CODE - TESTING
  const base = await listTreePath(tip.objects, tip.commit, path);
  const entries = enrichTreeWithLastCommits(
    tip.objects,
    tip.commit,
    path,
    base,
  );
  const packs =
    tip.packCount > 1
      ? `${tip.packCount} tipped packs`
      : "tip pack";
  return {
    entries,
    commit: tip.commit,
    tipPackSize: tip.tipPackSize,
    progress: `Loaded file tree from ${packs} (${tip.tipPackSize} bytes, IndexedDB/wasm)`,
  };
}

export async function browserListPaths(
  tip: Awaited<ReturnType<typeof ensureBrowserTip>>,
): Promise<{ commit: string; paths: string[] }> {
  const paths = await listAllBlobPaths(tip.objects, tip.commit);
  return { commit: tip.commit, paths };
}

/** Root + `.github` + `docs` blob names for community-file discovery (no full walk). */
export async function browserListCommunityPaths(
  tip: Awaited<ReturnType<typeof ensureBrowserTip>>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of ["", ".github", "docs"] as const) {
    try {
      const entries = await listTreePath(tip.objects, tip.commit, dir);
      for (const e of entries) {
        if (e.type !== "blob") continue;
        paths.push(dir ? `${dir}/${e.name}` : e.name);
      }
    } catch {
      /* dir missing on this tip */
    }
  }
  return paths;
}

export async function browserShowBlob(
  tip: Awaited<ReturnType<typeof ensureBrowserTip>>,
  filePath: string,
): Promise<{
  path: string;
  size: number;
  mediaType: string;
  binary: boolean;
  tooLarge: boolean;
  text: string | null;
  contentBase64: string | null;
  commit: string;
}> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const buf = await readBlobPath(tip.objects, tip.commit, filePath);
  // …then only retried softFill on /missing blob/i
  //
  // NEW CODE - TESTING: tip packs are incremental — README may peel from HEAD
  // while docs/ trees + image blobs still live in soft-filled parent packs.
  // "missing tree" (and path/file not found while trees are absent) must wait
  // for softFill the same way "missing blob" does, or markdown preview shows
  // only alt text for relative images like docs/images/*.png.
  let buf: Uint8Array;
  try {
    buf = await readBlobPath(tip.objects, tip.commit, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      tip.softFill &&
      /missing (blob|tree)|path not found|file not found|not in tip pack/i.test(
        msg,
      )
    ) {
      await tip.softFill;
      buf = await readBlobPath(tip.objects, tip.commit, filePath);
    } else {
      throw err;
    }
  }
  const lower = filePath.toLowerCase();
  const imageExt: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  let mediaType = "application/octet-stream";
  let image = false;
  let textLike = false;
  for (const [ext, type] of Object.entries(imageExt)) {
    if (lower.endsWith(ext)) {
      mediaType = type;
      image = true;
      break;
    }
  }
  if (!image && !buf.includes(0)) {
    mediaType = "text/plain";
    textLike = true;
  }
  const size = buf.length;
  let tooLarge = false;
  let text: string | null = null;
  let contentBase64: string | null = null;
  if (image) {
    if (size <= IMAGE_INLINE_MAX) {
      contentBase64 = bytesToBase64(buf);
    } else tooLarge = true;
  } else if (textLike) {
    if (size <= TEXT_INLINE_MAX) text = new TextDecoder().decode(buf);
    else tooLarge = true;
  } else {
    tooLarge = true;
  }
  return {
    path: filePath,
    size,
    mediaType,
    binary: !textLike,
    tooLarge,
    text,
    contentBase64,
    commit: tip.commit,
  };
}
