/**
 * Tip pack availability probe + cache/network rescue (re-PUT).
 * Anyone can rescue — packs are content-addressed; no owner keys.
 */
import type { TipBundle } from "../tip-browse/decode-wasm";
import { packContractKey } from "./keys";
import { tryGetContractState } from "./ws";
import {
  DEFAULT_CHUNK_SIZE,
  rescueRepublishChunkedPack,
  rescuePutBytes,
} from "./chunked-pack";

export type PackHealthGrade = "healthy" | "degraded" | "critical" | "unknown";

/** How useful Rescue is likely to be / how close packs look to going cold. */
export type RescueNeed = "low" | "medium" | "high" | "urgent" | "unknown";

export interface PackHealthPassive {
  tippedBundles: TipBundle[];
  singleCount: number;
  chunkedCount: number;
  totalChunks: number;
  totalBytes: number;
  tipPackSize: number | null;
}

export interface ProbeTarget {
  kind: "pack" | "manifest" | "chunk";
  hashHex: string;
  bundleId: string;
  ok: boolean;
  /** Soft-GET wall time ms (only when measured). */
  ms?: number;
}

export interface PackHealthProbeResult {
  grade: PackHealthGrade;
  rescueNeed: RescueNeed;
  reachable: number;
  total: number;
  /** Median soft-GET ms over successful targets (null if none timed). */
  medianMs: number | null;
  targets: ProbeTarget[];
  checkedAt: number;
  message: string;
}

export interface RescueResult {
  putCount: number;
  message: string;
  probe: PackHealthProbeResult;
}

export function passiveFromSummary(
  tippedBundles: TipBundle[],
  tipPackSize: number | null,
): PackHealthPassive {
  let singleCount = 0;
  let chunkedCount = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  for (const b of tippedBundles) {
    if (b.kind === "chunked") {
      chunkedCount += 1;
      totalChunks += Number(b.chunk_count ?? 0);
      totalBytes += Number(b.total_size ?? 0);
    } else {
      singleCount += 1;
      totalChunks += 1;
      totalBytes += Number(b.size_bytes ?? 0);
    }
  }
  return {
    tippedBundles,
    singleCount,
    chunkedCount,
    totalChunks,
    totalBytes: tipPackSize ?? totalBytes,
    tipPackSize,
  };
}

function gradeFromCounts(reachable: number, total: number): PackHealthGrade {
  if (total === 0) return "unknown";
  if (reachable === total) return "healthy";
  if (reachable === 0 || reachable < total / 2) return "critical";
  return "degraded";
}

/** Freenet does not expose peer LRU age; missing packs are the real rescue signal
 * (freenet-git: `exhausted all peers`). Soft-GET latency is shown as info only. */
function rescueNeedFromProbe(grade: PackHealthGrade): RescueNeed {
  if (grade === "critical") return "urgent";
  if (grade === "degraded") return "high";
  if (grade === "unknown") return "unknown";
  return "low";
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

async function softGetPack(
  hashHex: string,
  opts?: { bundleId?: string; localOnly?: boolean },
): Promise<{ ok: boolean; ms: number; local: boolean }> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always soft-GET over WS — raced tip soft-fill on the serial pump and
  // reported false "missing" while packs were already in local tip cache.
  // NEW CODE - TESTING: local tip IDB/memory hit = reachable (no WS)
  if (opts?.bundleId) {
    try {
      const { idbGetPack } = await import("../tip-browse/idb-cache");
      const cached = await idbGetPack(opts.bundleId);
      if (cached?.bytes && cached.bytes.byteLength > 0) {
        return { ok: true, ms: 0, local: true };
      }
    } catch {
      /* fall through */
    }
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Network soft-GET here — starved behind soft-fill high-priority GETs →
  // Packs reachable / Repo settings hung forever (ws 1006 under load).
  // NEW CODE - TESTING: localOnly skips WS (sidebar first paint)
  if (opts?.localOnly) {
    return { ok: false, ms: 0, local: false };
  }
  const t0 = performance.now();
  const bytes = await tryGetContractState(packContractKey(hashHex));
  const ms = performance.now() - t0;
  return {
    ok: bytes != null && bytes.length > 0,
    ms,
    local: false,
  };
}

function bundleHasMissing(
  bundleId: string,
  prior: PackHealthProbeResult | undefined,
): boolean {
  if (!prior || prior.targets.length === 0) return true;
  return prior.targets.some((t) => t.bundleId === bundleId && !t.ok);
}

/** Soft-GET tip pack/manifest contracts; grades availability + rescue need. */
export async function probePackHealth(
  tippedBundles: TipBundle[],
  opts?: { localOnly?: boolean },
): Promise<PackHealthProbeResult> {
  const targets: ProbeTarget[] = [];
  const localOnly = opts?.localOnly === true;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // for (const b of tippedBundles) { await softGetPack … }  // serial; N packs = N queue hops
  // NEW CODE - TESTING: bounded parallel soft-GETs for single packs; chunked still pooled

  const singlePacks = tippedBundles.filter(
    (b) => !(b.kind === "chunked" && b.manifest_hash) && b.pack_hash,
  );
  const chunked = tippedBundles.filter(
    (b) => b.kind === "chunked" && b.manifest_hash,
  );

  const PACK_PROBE_CONC = localOnly ? 16 : 8;
  let nextSingle = 0;
  async function singleWorker(): Promise<void> {
    for (;;) {
      const i = nextSingle++;
      if (i >= singlePacks.length) return;
      const b = singlePacks[i]!;
      const h = b.pack_hash!.trim().toLowerCase();
      const soft = await softGetPack(h, {
        bundleId: b.bundle_id,
        localOnly,
      });
      targets.push({
        kind: "pack",
        hashHex: h,
        bundleId: b.bundle_id,
        ok: soft.ok,
        ms: soft.ms,
      });
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          PACK_PROBE_CONC,
          Math.max(1, singlePacks.length),
        ),
      },
      () => singleWorker(),
    ),
  );

  for (const b of chunked) {
    const mh = b.manifest_hash!.trim().toLowerCase();
    // Local reassembled pack ⇒ treat whole chunked tip as reachable.
    const man = await softGetPack(mh, {
      bundleId: b.bundle_id,
      localOnly,
    });
    if (man.ok && man.local) {
      targets.push({
        kind: "manifest",
        hashHex: mh,
        bundleId: b.bundle_id,
        ok: true,
        ms: 0,
      });
      continue;
    }
    targets.push({
      kind: "manifest",
      hashHex: mh,
      bundleId: b.bundle_id,
      ok: man.ok,
      ms: man.ms,
    });
    if (!man.ok) continue;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Enumerated every chunk via pool/shell soft-GET — freenet-core-scale tip
    // packs hung "Packs reachable / Checking…" for minutes on the serial WS.
    // NEW CODE - TESTING: pack-level health = manifest (+ local IDB). Chunk
    // rescue still walks chunks inside rescueTipPacks when needed.
  }

  const total = targets.length;
  const reachable = targets.filter((t) => t.ok).length;
  const grade = gradeFromCounts(reachable, total);
  const medianMs = median(
    targets.filter((t) => t.ok && t.ms != null).map((t) => t.ms!),
  );
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const rescueNeed = rescueNeedFromProbe(grade);
  // — localOnly misses (soft-fill not done) graded High/Urgent and flashed in UI.
  // NEW CODE - TESTING: local-only incomplete is "unknown", not a rescue alarm.
  const rescueNeed =
    localOnly && grade !== "healthy" && grade !== "unknown"
      ? "unknown"
      : rescueNeedFromProbe(grade);

  let message: string;
  if (grade === "healthy") {
    message = localOnly
      ? "All tip packs present in local tip cache."
      : "All tip packs reachable. Preventive Rescue (or a cron) still helps against future eviction — Freenet is LRU, not permanent storage.";
  } else if (grade === "degraded") {
    message = localOnly
      ? `${total - reachable} of ${total} tip packs not in local cache yet (soft-fill may still be running).`
      : `${total - reachable} of ${total} tip pack contracts missing — Rescue may help if this node still has the bytes.`;
  } else if (grade === "critical") {
    message = localOnly
      ? "Few tip packs in local cache — soft-fill or Rescue may still recover them."
      : "Most tip pack data is unreachable. Rescue re-PUTs only what this node or the network can still serve.";
  } else {
    message = "No tipped pack contracts to probe.";
  }

  return {
    grade,
    rescueNeed,
    reachable,
    total,
    medianMs,
    targets,
    checkedAt: Date.now(),
    message,
  };
}

/**
 * Re-PUT tip pack contracts from local backup, tip IDB cache, or network GET.
 * Does not rewrite RepoState. Skips bundles that probed fully OK when
 * `onlyMissing` and a prior probe is provided.
 */
export async function rescueTipPacks(
  prefix: string,
  tippedBundles: TipBundle[],
  opts?: {
    onlyMissing?: boolean;
    priorProbe?: PackHealthProbeResult;
    onProgress?: (msg: string) => void;
  },
): Promise<RescueResult> {
  const onlyMissing = opts?.onlyMissing !== false;
  let putCount = 0;
  let skippedAlreadyOk = 0;
  let attempted = 0;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const { idbGetPack } = await import("../tip-browse/idb-cache");
  // const { fetchPackByHash } = await import("./tip-fetch");
  // Prefer: shared repo backup (CA) → tip IDB → network
  const { idbGetPack } = await import("../tip-browse/idb-cache");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const { fetchPackByHash } = await import("./tip-fetch");
  const { backupBytesForHash, rehydrateBackupBlobs } = await import(
    "./repo-backup"
  );
  const { decodeChunkedManifest } = await import("../tip-browse/decode-wasm");

  // Fill backup blob store from pin hashes when sandbox wiped pack bytes.
  try {
    opts?.onProgress?.("Rehydrating local backup bytes…");
    await rehydrateBackupBlobs(prefix, { onProgress: opts?.onProgress });
  } catch {
    /* best-effort */
  }

  async function loadHash(
    hashHex: string,
    bundleId?: string,
  ): Promise<Uint8Array> {
    const fromBackup = await backupBytesForHash(hashHex);
    if (fromBackup) return fromBackup;
    if (bundleId) {
      const cached = await idbGetPack(bundleId);
      if (cached?.bytes) return new Uint8Array(cached.bytes);
    }
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return fetchPackByHash(hashHex, prefix); // 3×12s → rescue hangs then "Nothing recoverable"
    // NEW CODE - TESTING: one short attempt — backup rescue should not wait on a cold network
    const { getContractState } = await import("./ws");
    const { packContractKey, bytesToHex } = await import("./keys");
    const { blake3 } = await import("@noble/hashes/blake3");
    const bytes = await getContractState(packContractKey(hashHex), {
      priority: "high",
      scope: prefix,
      timeoutMs: 8_000,
      maxAttempts: 1,
    });
    const got = bytesToHex(blake3(bytes));
    const want = hashHex.trim().toLowerCase();
    if (got !== want) {
      throw new Error(
        `pack BLAKE3 mismatch: got ${got}, expected ${want}`,
      );
    }
    return bytes;
  }

  for (const b of tippedBundles) {
    if (
      onlyMissing &&
      opts?.priorProbe &&
      !bundleHasMissing(b.bundle_id, opts.priorProbe)
    ) {
      skippedAlreadyOk += 1;
      continue;
    }
    attempted += 1;

    if (b.kind === "chunked" && b.manifest_hash) {
      const mh = b.manifest_hash.trim().toLowerCase();
      let packBytes: Uint8Array | null = null;
      let chunkSize = DEFAULT_CHUNK_SIZE;

      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const cached = await idbGetPack(b.bundle_id);
      // if (cached?.bytes) packBytes = new Uint8Array(cached.bytes);
      const cached = await idbGetPack(b.bundle_id);
      if (cached?.bytes) {
        packBytes = new Uint8Array(cached.bytes);
      }

      if (!packBytes) {
        try {
          opts?.onProgress?.(`Fetching ChunkedPack ${mh.slice(0, 12)}…`);
          const manBytes = await loadHash(mh, b.bundle_id);
          const man = await decodeChunkedManifest(manBytes);
          chunkSize = man.chunk_size || DEFAULT_CHUNK_SIZE;
          const parts: Uint8Array[] = [];
          for (let i = 0; i < man.chunk_hashes.length; i++) {
            opts?.onProgress?.(
              `Fetching chunk ${i + 1}/${man.chunk_hashes.length}…`,
            );
            parts.push(
              await loadHash(man.chunk_hashes[i]!, b.bundle_id),
            );
          }
          let total = 0;
          for (const p of parts) total += p.length;
          packBytes = new Uint8Array(total);
          let o = 0;
          for (const p of parts) {
            packBytes.set(p, o);
            o += p.length;
          }
        } catch (err) {
          opts?.onProgress?.(
            `Could not assemble ${b.bundle_id.slice(0, 12)}: ${
              err instanceof Error ? err.message : err
            }`,
          );
          continue;
        }
      } else {
        try {
          const manBytes = await loadHash(mh, b.bundle_id);
          const man = await decodeChunkedManifest(manBytes);
          chunkSize = man.chunk_size || DEFAULT_CHUNK_SIZE;
        } catch {
          /* IDB path: default chunk size */
        }
      }

      if (!packBytes) continue;
      opts?.onProgress?.(
        `Re-PUTting ChunkedPack (${packBytes.length} bytes)…`,
      );
      await rescueRepublishChunkedPack(packBytes, chunkSize, (p) => {
        if (p.phase === "put_chunk") {
          opts?.onProgress?.(`Rescue put chunk ${p.i}/${p.n}`);
        }
      });
      putCount += 1;
    } else if (b.pack_hash) {
      const h = b.pack_hash.trim().toLowerCase();
      try {
        opts?.onProgress?.(`Re-PUTting pack ${h.slice(0, 12)}…`);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // let bytes: Uint8Array | null = null;
        // const cached = await idbGetPack(b.bundle_id);
        // if (cached?.bytes) bytes = new Uint8Array(cached.bytes);
        // if (!bytes) bytes = await fetchPackByHash(h, prefix);
        const bytes = await loadHash(h, b.bundle_id);
        await rescuePutBytes(bytes);
        putCount += 1;
      } catch (err) {
        opts?.onProgress?.(
          `Rescue failed for ${h.slice(0, 12)}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  const probe =
    putCount > 0
      ? await probePackHealth(tippedBundles).catch(() => null)
      : opts?.priorProbe ?? null;
  let message: string;
  if (putCount === 0 && skippedAlreadyOk > 0 && attempted === 0) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // "Nothing recoverable…" even when tip packs were already healthy
    // NEW CODE - TESTING: distinguish "already OK" from "no bytes"
    message =
      opts?.priorProbe?.message ??
      `Tip packs already reachable (${skippedAlreadyOk} bundle(s)) — nothing missing to re-PUT.`;
  } else if (putCount === 0) {
    message =
      "Nothing recoverable from local backup bytes or the network (Freenet sandbox often drops pack caches on reload — run Backup again while tip packs are reachable, then Rescue).";
  } else if (probe) {
    message = `Re-published ${putCount} tip pack bundle(s). ${probe.message}`;
  } else {
    message = `Re-published ${putCount} tip pack bundle(s).`;
  }
  return {
    putCount,
    message,
    probe: probe ?? {
      grade: "unknown",
      rescueNeed: "unknown",
      reachable: 0,
      total: 0,
      medianMs: null,
      targets: [],
      checkedAt: Date.now(),
      message,
    },
  };
}
