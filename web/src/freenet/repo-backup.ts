/**
 * Pin / sync / status for local repo backups (Stars + own Repositories).
 * Content-addressed blobs; one pin per prefix with reasons star|own.
 */
import { blake3 } from "@noble/hashes/blake3";
import type { TipBundle } from "../tip-browse/decode-wasm";
import { summarizeRepoState } from "../tip-browse/decode-wasm";
import { idbGetPack } from "../tip-browse/idb-cache";
import { lookupRegistration } from "../registry/client";
import { bytesToHex } from "./keys";
import { fetchHubRepoMeta } from "./hub-repo";
import { fetchPackByHash, fetchRepoState } from "./tip-fetch";
import {
  backupAddReason,
  backupCountPresentBlobs,
  backupGcUnreferencedBlobs,
  backupGetBlob,
  backupGetPin,
  backupHasBlob,
  backupListPins,
  backupPutBlob,
  backupPutPin,
  backupRemoveReason,
  BACKUP_PREFS_PIN_PREFIX,
  type BackupReason,
  type RepoBackupPin,
} from "./repo-backup-store";

export type { BackupReason, RepoBackupPin };
export { BACKUP_PREFS_PIN_PREFIX };

const AUTO_SYNC_KEY = "gitatlas.repo-backup.auto-sync"; // legacy
const PREFS_KEY = "gitatlas.repo-backup.prefs";
const PREFS_EVENT = "freenethub-backup-prefs";

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export type BackupFreshness = "none" | "fresh" | "stale" | "unknown";
// NEW CODE - TESTING: incomplete = pin/hashes exist but tip pack bytes missing
export type BackupFreshness =
  | "none"
  | "fresh"
  | "stale"
  | "incomplete"
  | "unknown";

export interface BackupPrefs {
  /** Refresh existing out-of-date pins in the background. Default on. */
  autoUpdateExisting: boolean;
  /** Create backups for owned repos that have none. Default off. */
  autoBackupOwnRepos: boolean;
  /** Create backups for starred repos that have none. Default off. */
  autoBackupStars: boolean;
}

export const DEFAULT_BACKUP_PREFS: BackupPrefs = {
  autoUpdateExisting: true,
  autoBackupOwnRepos: false,
  autoBackupStars: false,
};

export interface BackupStatus {
  prefix: string;
  pin: RepoBackupPin | null;
  freshness: BackupFreshness;
  reasons: BackupReason[];
  tipCommit: string | null;
  liveTipCommit: string | null;
  hasRegistrySnapshot: boolean;
  hasMetaSnapshot: boolean;
  blobCount: number;
  /** Tip pack hashes that have durable bytes (delegate / IDB / memory). */
  blobBytesPresent: number;
  /** Tip pack hashes listed on the pin but missing bytes. */
  blobBytesMissing: number;
  lastCheckedAt: number | null;
}

function readPrefsLocal(): BackupPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Partial<BackupPrefs>;
      return {
        autoUpdateExisting:
          o.autoUpdateExisting ?? DEFAULT_BACKUP_PREFS.autoUpdateExisting,
        autoBackupOwnRepos:
          o.autoBackupOwnRepos ?? DEFAULT_BACKUP_PREFS.autoBackupOwnRepos,
        autoBackupStars:
          o.autoBackupStars ?? DEFAULT_BACKUP_PREFS.autoBackupStars,
      };
    }
    // Migrate legacy auto-sync checkbox (default was on when unset).
    const legacy = localStorage.getItem(AUTO_SYNC_KEY);
    if (legacy === "0" || legacy === "false") {
      return { ...DEFAULT_BACKUP_PREFS, autoUpdateExisting: false };
    }
  } catch {
    /* sandbox */
  }
  return { ...DEFAULT_BACKUP_PREFS };
}

export function getBackupPrefs(): BackupPrefs {
  return readPrefsLocal();
}

/** @deprecated use getBackupPrefs().autoUpdateExisting */
export function getBackupAutoSync(): boolean {
  return getBackupPrefs().autoUpdateExisting;
}

export function setBackupPrefs(next: Partial<BackupPrefs>): BackupPrefs {
  const merged: BackupPrefs = { ...readPrefsLocal(), ...next };
  writePrefsLocal(merged);
  try {
    window.dispatchEvent(
      new CustomEvent(PREFS_EVENT, { detail: merged }),
    );
  } catch {
    /* ignore */
  }
  void persistBackupPrefsToIdentity(merged).catch((err) => {
    console.warn("[freenet-hub] backup prefs identity persist failed", err);
  });
  // NEW CODE - TESTING: also seal into HubVault settings envelope
  void import("./auth-api")
    .then(({ pushBackupPrefsToVault }) => pushBackupPrefsToVault(merged))
    .catch((err) => {
      console.warn("[freenet-hub] backup prefs vault persist failed", err);
    });
  return merged;
}

/** Apply prefs from vault/identity without pushing back to vault. */
export function applyBackupPrefsFromRemote(
  next: Partial<BackupPrefs>,
): BackupPrefs {
  const cur = readPrefsLocal();
  const merged: BackupPrefs = {
    autoUpdateExisting:
      next.autoUpdateExisting ?? cur.autoUpdateExisting,
    autoBackupOwnRepos:
      next.autoBackupOwnRepos ?? cur.autoBackupOwnRepos,
    autoBackupStars: next.autoBackupStars ?? cur.autoBackupStars,
  };
  writePrefsLocal(merged);
  try {
    window.dispatchEvent(
      new CustomEvent(PREFS_EVENT, { detail: merged }),
    );
  } catch {
    /* ignore */
  }
  void persistBackupPrefsToIdentity(merged).catch(() => {
    /* ignore */
  });
  return merged;
}

function writePrefsLocal(merged: BackupPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    localStorage.setItem(
      AUTO_SYNC_KEY,
      merged.autoUpdateExisting ? "1" : "0",
    );
  } catch {
    /* sandbox */
  }
}

/** @deprecated use setBackupPrefs({ autoUpdateExisting }) */
export function setBackupAutoSync(on: boolean): void {
  setBackupPrefs({ autoUpdateExisting: on });
}

export function onBackupPrefsChange(
  handler: (prefs: BackupPrefs) => void,
): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent<BackupPrefs>).detail;
    handler(detail ?? getBackupPrefs());
  };
  window.addEventListener(PREFS_EVENT, fn);
  return () => window.removeEventListener(PREFS_EVENT, fn);
}

async function persistBackupPrefsToIdentity(prefs: BackupPrefs): Promise<void> {
  const { isBrowserNativeMode } = await import("../tip-browse");
  if (!isBrowserNativeMode()) return;
  const { hubOwnerContractsReady } = await import("./owner-constants");
  if (!hubOwnerContractsReady()) return;
  const { getCachedIdentity } = await import("./auth-api");
  if (!getCachedIdentity()) return;
  const { nativeUpsertRepoBackupPin } = await import("./owner-api");
  const now = Date.now();
  await nativeUpsertRepoBackupPin({
    prefix: BACKUP_PREFS_PIN_PREFIX,
    reasons: [],
    autoUpdate: false,
    tipCommit: null,
    tipBundles: [],
    contentHashes: [],
    registry: null,
    repoMeta: null,
    pinnedAt: now,
    updatedAt: now,
    prefs,
  });
}

/** Load prefs from identity secret + HubVault settings (vault wins when present). */
export async function hydrateBackupPrefsFromIdentity(): Promise<BackupPrefs> {
  let local = readPrefsLocal();
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (!isBrowserNativeMode()) return local;
    const { hubOwnerContractsReady } = await import("./owner-constants");
    if (!hubOwnerContractsReady()) return local;
    const { nativeListRepoBackupPins } = await import("./owner-api");
    const rows = await nativeListRepoBackupPins();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (o.prefix !== BACKUP_PREFS_PIN_PREFIX) continue;
      const p = o.prefs as Partial<BackupPrefs> | undefined;
      if (!p || typeof p !== "object") continue;
      local = applyBackupPrefsFromRemote(p);
      break;
    }
  } catch {
    /* ignore */
  }
  try {
    const { pullBackupPrefsFromVault } = await import("./auth-api");
    const rb = await pullBackupPrefsFromVault();
    if (rb && typeof rb === "object") {
      local = applyBackupPrefsFromRemote({
        autoUpdateExisting: rb.autoUpdateExisting,
        autoBackupOwnRepos: rb.autoBackupOwnRepos,
        autoBackupStars: rb.autoBackupStars,
      });
    }
  } catch {
    /* ignore */
  }
  return local;
}

function tipIdentity(bundles: TipBundle[]): string {
  return bundles
    .map((b) => {
      if (b.kind === "chunked" && b.manifest_hash) {
        return `c:${b.manifest_hash}:${b.bundle_id}`;
      }
      return `s:${b.pack_hash ?? ""}:${b.bundle_id}`;
    })
    .sort()
    .join("|");
}

async function loadLiveTipBundles(prefix: string): Promise<{
  tipCommit: string | null;
  tippedBundles: TipBundle[];
}> {
  // Avoid serving a stale empty RepoState from an earlier soft miss.
  const { clearRepoStateCache } = await import("./tip-fetch");
  clearRepoStateCache(prefix);
  const state = await fetchRepoState(prefix);
  const summary = (await summarizeRepoState(state)) as {
    tipped_bundles?: TipBundle[];
  };
  const tippedBundles = summary.tipped_bundles ?? [];
  const tipCommit = tippedBundles[0]?.tip_commit ?? null;
  return { tipCommit, tippedBundles };
}

async function storePackBytes(
  hashHex: string,
  bytes: Uint8Array,
  hashes: string[],
): Promise<void> {
  const h = hashHex.trim().toLowerCase();
  const digest = bytesToHex(blake3(bytes));
  if (digest !== h) {
    throw new Error(
      `backup BLAKE3 mismatch: got ${digest}, expected ${h}`,
    );
  }
  await backupPutBlob(h, bytes);
  if (!hashes.includes(h)) hashes.push(h);
}

async function captureTipBlobs(
  prefix: string,
  tippedBundles: TipBundle[],
  onProgress?: (msg: string) => void,
): Promise<string[]> {
  const hashes: string[] = [];
  const { decodeChunkedManifest } = await import("../tip-browse/decode-wasm");
  const { DEFAULT_CHUNK_SIZE } = await import("./chunked-pack");

  for (const b of tippedBundles) {
    if (b.kind === "chunked" && b.manifest_hash) {
      const mh = b.manifest_hash.trim().toLowerCase();
      onProgress?.(`Backing up ChunkedPack ${mh.slice(0, 12)}…`);

      let packBytes: Uint8Array | null = null;
      const cached = await idbGetPack(b.bundle_id);
      if (cached?.bytes) packBytes = new Uint8Array(cached.bytes);

      const manBytes = await fetchPackByHash(mh, prefix);
      await storePackBytes(mh, manBytes, hashes);
      const man = await decodeChunkedManifest(manBytes);
      const chunkSize = man.chunk_size || DEFAULT_CHUNK_SIZE;

      if (!packBytes) {
        const parts: Uint8Array[] = [];
        for (let i = 0; i < man.chunk_hashes.length; i++) {
          const ch = man.chunk_hashes[i]!.trim().toLowerCase();
          onProgress?.(
            `Backing up chunk ${i + 1}/${man.chunk_hashes.length}…`,
          );
          const part = await fetchPackByHash(ch, prefix);
          await storePackBytes(ch, part, hashes);
          parts.push(part);
        }
        let total = 0;
        for (const p of parts) total += p.length;
        packBytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          packBytes.set(p, o);
          o += p.length;
        }
      } else {
        // Still store individual chunks from reassembled pack for CA rescue.
        for (let i = 0; i < man.chunk_hashes.length; i++) {
          const ch = man.chunk_hashes[i]!.trim().toLowerCase();
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, packBytes.length);
          const part = packBytes.subarray(start, end);
          await storePackBytes(ch, part, hashes);
        }
      }
      void packBytes;
    } else if (b.pack_hash) {
      const h = b.pack_hash.trim().toLowerCase();
      onProgress?.(`Backing up pack ${h.slice(0, 12)}…`);
      let bytes: Uint8Array | null = null;
      const cached = await idbGetPack(b.bundle_id);
      if (cached?.bytes) bytes = new Uint8Array(cached.bytes);
      if (!bytes) bytes = await fetchPackByHash(h, prefix);
      await storePackBytes(h, bytes, hashes);
    }
  }
  return hashes;
}

/**
 * Snapshot tip packs + HubRegistry listing + HubRepoMeta into the shared store.
 * Dedupes when starring an owned repo (same pin, both reasons).
 */
export async function pinRepoBackup(
  prefix: string,
  reason: BackupReason,
  opts?: {
    autoUpdate?: boolean;
    onProgress?: (msg: string) => void;
    /** Force re-fetch tip even when pin looks fresh. */
    force?: boolean;
  },
): Promise<RepoBackupPin> {
  const existing = await backupGetPin(prefix);

  opts?.onProgress?.("Reading tip…");
  const { tipCommit, tippedBundles } = await loadLiveTipBundles(prefix);
  if (tippedBundles.length === 0) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // saved empty pins → UI "Unknown" / clobbered good pins via auto-sync race
    throw new Error(
      "No tip packs to back up yet — open the repo or push a commit first",
    );
  }

  // Dedup star∩own: same pin; skip re-download when tip + durable bytes ready.
  if (
    !opts?.force &&
    existing &&
    existing.contentHashes.length > 0 &&
    tipIdentity(existing.tipBundles) === tipIdentity(tippedBundles)
  ) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // skipped when contentHashes listed even if bytes were gone after sandbox wipe
    // NEW CODE - TESTING: require durable tip pack bytes before treating as complete
    const { present, missing } = await backupCountPresentBlobs(
      existing.contentHashes,
    );
    if (missing.length === 0 && present === existing.contentHashes.length) {
      const merged = await backupAddReason(prefix, reason);
      if (merged) {
        if (opts?.autoUpdate != null && opts.autoUpdate !== merged.autoUpdate) {
          await backupPutPin({ ...merged, autoUpdate: opts.autoUpdate });
          const saved = (await backupGetPin(prefix)) ?? merged;
          notifyBackupStatusChanged(prefix);
          return saved;
        }
        notifyBackupStatusChanged(prefix);
        return merged;
      }
    }
    opts?.onProgress?.(
      `Backup incomplete (${missing.length} pack(s) missing bytes) — repairing…`,
    );
  }

  const contentHashes = await captureTipBlobs(
    prefix,
    tippedBundles,
    opts?.onProgress,
  );
  if (contentHashes.length === 0) {
    throw new Error("Could not copy any tip pack bytes into the backup store");
  }

  // Confirm bytes landed in durable store (delegate), not only memory.
  const durable = await backupCountPresentBlobs(contentHashes);
  if (durable.missing.length > 0) {
    throw new Error(
      `Backup incomplete — could not durably store ${durable.missing.length} tip pack(s)`,
    );
  }

  opts?.onProgress?.("Snapshotting Hub listing…");
  const registry = await lookupRegistration(prefix).catch(() => null);
  const repoMeta = await fetchHubRepoMeta(prefix).catch(() => null);

  const now = Date.now();
  const pin: RepoBackupPin = {
    prefix,
    reasons: [reason],
    autoUpdate: opts?.autoUpdate ?? existing?.autoUpdate ?? true,
    tipCommit,
    tipBundles: tippedBundles,
    contentHashes,
    registry,
    repoMeta,
    pinnedAt: existing?.pinnedAt ?? now,
    updatedAt: now,
    lastCheckedAt: now,
  };
  await backupPutPin(pin);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // (no GC of superseded tip packs)
  // NEW CODE - TESTING: drop tip pack bytes no longer referenced by any pin
  try {
    await backupGcUnreferencedBlobs();
  } catch (err) {
    console.warn("[freenet-hub] backup GC after pin failed", err);
  }
  const saved = (await backupGetPin(prefix)) ?? pin;
  notifyBackupStatusChanged(prefix);
  return saved;
}

export async function unpinBackupReason(
  prefix: string,
  reason: BackupReason,
): Promise<void> {
  await backupRemoveReason(prefix, reason);
  notifyBackupStatusChanged(prefix);
}

export async function getBackupStatus(prefix: string): Promise<BackupStatus> {
  const pin = await backupGetPin(prefix);
  if (!pin || pin.reasons.length === 0) {
    return {
      prefix,
      pin: null,
      freshness: "none",
      reasons: [],
      tipCommit: null,
      liveTipCommit: null,
      hasRegistrySnapshot: false,
      hasMetaSnapshot: false,
      blobCount: 0,
      blobBytesPresent: 0,
      blobBytesMissing: 0,
      lastCheckedAt: null,
    };
  }

  let liveTipCommit: string | null = null;
  let freshness: BackupFreshness = "unknown";
  const pinnedId = tipIdentity(pin.tipBundles);
  const hasPinTip =
    Boolean(pinnedId) ||
    Boolean(pin.tipCommit) ||
    pin.contentHashes.length > 0;

  const blobAudit = await backupCountPresentBlobs(pin.contentHashes);
  const blobBytesPresent = blobAudit.present;
  const blobBytesMissing = blobAudit.missing.length;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // empty tip pin → "Unknown" (auto-sync race wrote hollow pins)
  // NEW CODE - TESTING: hollow pin = stale; hash-only (no bytes) = incomplete
  if (!hasPinTip) {
    freshness = "stale";
  } else if (
    pin.contentHashes.length === 0 ||
    blobBytesMissing > 0 ||
    blobBytesPresent < pin.contentHashes.length
  ) {
    freshness = "incomplete";
  } else {
    try {
      const live = await loadLiveTipBundles(prefix);
      liveTipCommit = live.tipCommit;
      const liveId = tipIdentity(live.tippedBundles);
      if (!liveId && !liveTipCommit) {
        freshness = "fresh";
      } else if (
        (pinnedId && liveId && pinnedId === liveId) ||
        (pin.tipCommit &&
          liveTipCommit &&
          pin.tipCommit === liveTipCommit &&
          (!pinnedId || !liveId || pinnedId === liveId))
      ) {
        freshness = "fresh";
      } else if (pinnedId && liveId && pinnedId !== liveId) {
        freshness = "stale";
      } else if (
        pin.tipCommit &&
        liveTipCommit &&
        pin.tipCommit !== liveTipCommit
      ) {
        freshness = "stale";
      } else {
        freshness = "fresh";
      }
    } catch {
      freshness = "fresh";
      liveTipCommit = pin.tipCommit;
    }
  }

  return {
    prefix,
    pin,
    freshness,
    reasons: pin.reasons,
    tipCommit: pin.tipCommit,
    liveTipCommit,
    hasRegistrySnapshot: Boolean(pin.registry),
    hasMetaSnapshot: Boolean(pin.repoMeta),
    blobCount: pin.contentHashes.length,
    blobBytesPresent,
    blobBytesMissing,
    lastCheckedAt: pin.lastCheckedAt ?? null,
  };
}

/** Stamp lastCheckedAt on an existing pin (persists to identity). */
export async function markBackupChecked(prefix: string): Promise<void> {
  const pin = await backupGetPin(prefix);
  if (!pin || pin.reasons.length === 0) return;
  const next: RepoBackupPin = {
    ...pin,
    lastCheckedAt: Date.now(),
  };
  await backupPutPin(next);
  notifyBackupStatusChanged(prefix);
}


/** Re-fetch tip + Hub snapshots when pin is missing or behind. */
export async function syncRepoBackup(
  prefix: string,
  opts?: {
    reason?: BackupReason;
    onProgress?: (msg: string) => void;
  },
): Promise<BackupStatus> {
  const pin = await backupGetPin(prefix);
  const reason = opts?.reason ?? pin?.reasons[0] ?? "star";
  await pinRepoBackup(prefix, reason, {
    autoUpdate: pin?.autoUpdate ?? true,
    onProgress: opts?.onProgress,
  });
  return getBackupStatus(prefix);
}

/**
 * Read backup bytes for a content hash (rescue preference order).
 */
export async function backupBytesForHash(
  hashHex: string,
): Promise<Uint8Array | null> {
  const row = await backupGetBlob(hashHex);
  if (!row?.bytes) return null;
  return new Uint8Array(row.bytes);
}

const BACKUP_STATUS_EVENT = "freenethub-backup-status";

/** Notify list chrome to refresh badge after pin/sync/clear/auto-update. */
export function notifyBackupStatusChanged(prefix?: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent(BACKUP_STATUS_EVENT, { detail: { prefix: prefix ?? null } }),
    );
  } catch {
    /* ignore */
  }
}

export function onBackupStatusChanged(
  handler: (prefix: string | null) => void,
): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent<{ prefix: string | null }>).detail;
    handler(detail?.prefix ?? null);
  };
  window.addEventListener(BACKUP_STATUS_EVENT, fn);
  return () => window.removeEventListener(BACKUP_STATUS_EVENT, fn);
}

/**
 * When Freenet sandbox wiped IDB/memory after reload, re-fetch tip pack bytes
 * listed on the durable pin into the backup blob store (best-effort).
 * Prefer identity-delegate bytes; otherwise soft-GET from the network.
 */
export async function rehydrateBackupBlobs(
  prefix: string,
  opts?: { onProgress?: (msg: string) => void },
): Promise<{ restored: number; missing: number }> {
  const pin = await backupGetPin(prefix);
  if (!pin || pin.contentHashes.length === 0) {
    return { restored: 0, missing: 0 };
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // try { const bytes = await fetchPackByHash(h, prefix); ... } // 3×12s timeouts
  // NEW CODE - TESTING: soft GET, one attempt, short miss timeout; durable delegate first
  const { tryGetContractState } = await import("./ws");
  const { packContractKey } = await import("./keys");
  let restored = 0;
  let missing = 0;
  for (let i = 0; i < pin.contentHashes.length; i++) {
    const h = pin.contentHashes[i]!;
    // backupGetBlob already hydrates from identity delegate when IDB is empty
    const existing = await backupBytesForHash(h);
    if (existing) {
      restored += 1;
      continue;
    }
    opts?.onProgress?.(
      `Re-fetching backup object ${i + 1}/${pin.contentHashes.length}…`,
    );
    try {
      const bytes = await tryGetContractState(packContractKey(h), {
        timeoutMs: 4_000,
      });
      if (!bytes || bytes.length === 0) {
        missing += 1;
        continue;
      }
      const digest = bytesToHex(blake3(bytes));
      if (digest !== h.trim().toLowerCase()) {
        missing += 1;
        continue;
      }
      await backupPutBlob(h, bytes);
      restored += 1;
    } catch {
      missing += 1;
    }
  }
  return { restored, missing };
}

/**
 * Repair a hash-only / incomplete pin: pull missing tip packs from tip IDB or
 * Freenet while reachable, then store them on the identity delegate.
 */
export async function repairIncompleteBackup(
  prefix: string,
  opts?: { onProgress?: (msg: string) => void },
): Promise<BackupStatus> {
  const pin = await backupGetPin(prefix);
  if (!pin || pin.reasons.length === 0) {
    return getBackupStatus(prefix);
  }
  const { missing } = await backupCountPresentBlobs(pin.contentHashes);
  if (missing.length === 0) {
    return getBackupStatus(prefix);
  }

  opts?.onProgress?.(
    `Repairing incomplete backup (${missing.length} missing pack(s))…`,
  );

  // Prefer a full tip re-capture while packs are still on the network.
  try {
    await pinRepoBackup(prefix, pin.reasons[0]!, {
      force: true,
      autoUpdate: pin.autoUpdate,
      onProgress: opts?.onProgress,
    });
    return getBackupStatus(prefix);
  } catch (err) {
    console.warn(
      "[freenet-hub] incomplete backup full re-pin failed; trying per-hash",
      err,
    );
  }

  for (let i = 0; i < missing.length; i++) {
    const h = missing[i]!;
    if (await backupHasBlob(h)) continue;
    opts?.onProgress?.(
      `Fetching missing pack ${i + 1}/${missing.length} (${h.slice(0, 12)}…)`,
    );
    try {
      // Tip IDB by scanning tipBundles for matching pack_hash
      let bytes: Uint8Array | null = null;
      for (const b of pin.tipBundles) {
        if (b.pack_hash?.trim().toLowerCase() === h) {
          const cached = await idbGetPack(b.bundle_id);
          if (cached?.bytes) bytes = new Uint8Array(cached.bytes);
          break;
        }
        if (b.manifest_hash?.trim().toLowerCase() === h) {
          /* fetch via network below */
        }
      }
      if (!bytes) bytes = await fetchPackByHash(h, prefix);
      await storePackBytes(h, bytes, []);
    } catch (err) {
      console.warn("[freenet-hub] incomplete backup pack repair failed", h, err);
    }
  }
  notifyBackupStatusChanged(prefix);
  return getBackupStatus(prefix);
}

/** Drop the backup pin entirely (all reasons) from memory / IDB / identity. */
export async function clearRepoBackup(prefix: string): Promise<void> {
  const { backupClearPin } = await import("./repo-backup-store");
  await backupClearPin(prefix);
  notifyBackupStatusChanged(prefix);
}

/** Prefer backup store, then tip IDB, then network — for a single pack hash. */
export async function loadPackBytesPreferBackup(
  hashHex: string,
  prefix: string,
  bundleId?: string,
): Promise<Uint8Array> {
  const fromBackup = await backupBytesForHash(hashHex);
  if (fromBackup) return fromBackup;
  if (bundleId) {
    const cached = await idbGetPack(bundleId);
    if (cached?.bytes) return new Uint8Array(cached.bytes);
  }
  return fetchPackByHash(hashHex, prefix);
}

let syncQueue: Promise<void> = Promise.resolve();

const WORKER_ITEM_GAP_MS = 8_000;

/** Prefixes already queued for post-tip backup refresh (dedupe). */
const tipPushRefreshPending = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * After a Freenet tip push: update/create the local backup pin in the background
 * (module queue — survives SPA navigation). Notifies inbox + list chrome.
 * Delayed so tip UI / soft-fill can use the WS before backup Pack GETs stampede.
 */
export function enqueueBackupRefreshAfterTipPush(prefix: string): Promise<void> {
  const p = prefix.trim();
  if (!p) return Promise.resolve();
  if (tipPushRefreshPending.has(p)) {
    return syncQueue;
  }
  tipPushRefreshPending.add(p);
  const job = async () => {
    try {
      // NEW CODE - TESTING: let post-commit tip paint finish before backup IO
      await sleep(2_500);
      await refreshBackupAfterTipPush(p);
    } finally {
      tipPushRefreshPending.delete(p);
    }
  };
  syncQueue = syncQueue.then(job, job);
  return syncQueue;
}

/**
 * Wait for the new tip to be readable, then pin/sync backup + system inbox.
 * Called from the global worker path (and tip-push listener), not from list pages.
 */
export async function refreshBackupAfterTipPush(
  prefix: string,
): Promise<void> {
  const { getCachedIdentity } = await import("./auth-api");
  if (!getCachedIdentity()) return;

  const prefs = getBackupPrefs();
  const pin = await backupGetPin(prefix);
  const hasPin = Boolean(pin && pin.reasons.length > 0);
  const wantUpdate =
    hasPin &&
    (prefs.autoUpdateExisting || pin!.autoUpdate !== false);
  const wantCreateOwn = !hasPin && prefs.autoBackupOwnRepos;
  // Owner tip push: always refresh an existing own pin even if auto-update off
  // was toggled globally but pin still carries "own".
  const wantOwnRefresh = Boolean(pin?.reasons.includes("own"));

  if (!wantUpdate && !wantCreateOwn && !wantOwnRefresh) {
    return;
  }

  // Tip Put may not be GET-able for a beat after clearRepoTipCaches.
  let tipped = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try {
      const live = await loadLiveTipBundles(prefix);
      if (live.tippedBundles.length > 0) {
        tipped = true;
        break;
      }
    } catch {
      /* retry */
    }
  }
  if (!tipped) {
    console.warn(
      "[freenet-hub] backup after tip: tip not readable yet",
      prefix.slice(0, 12),
    );
    return;
  }

  const before = await backupGetPin(prefix);
  const beforeTip = before ? tipIdentity(before.tipBundles) : "";
  const reason: BackupReason = before?.reasons.includes("own")
    ? "own"
    : before?.reasons[0] ?? "own";

  try {
    await pinRepoBackup(prefix, reason, { force: true });
  } catch (err) {
    console.warn(
      "[freenet-hub] backup after tip failed",
      prefix.slice(0, 12),
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const after = await backupGetPin(prefix);
  const afterTip = after ? tipIdentity(after.tipBundles) : "";
  const created = !before || before.reasons.length === 0;
  const tipChanged = Boolean(afterTip && afterTip !== beforeTip);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (created) notify CREATE; else if (tipChanged || hashes) notify UPDATE
  // — skipped notify when pin looked unchanged; also raced WS with tip Put.
  // NEW CODE - TESTING: always notify after a successful post-tip backup refresh
  try {
    await sleep(1_200);
    const {
      notifySelfSystem,
      SYSTEM_KIND_BACKUP_CREATED,
      SYSTEM_KIND_BACKUP_UPDATED,
    } = await import("./system-notify");
    if (created) {
      await notifySelfSystem(SYSTEM_KIND_BACKUP_CREATED, {
        title: "New repo backup created",
        detail: `Backed up ${prefix} after a new tip was published.`,
        prefix,
      });
    } else {
      await notifySelfSystem(SYSTEM_KIND_BACKUP_UPDATED, {
        title: "Repo backup updated",
        detail: tipChanged
          ? `Backup refreshed for ${prefix} after your commit.`
          : `Backup refreshed for ${prefix} after your commit.`,
        prefix,
      });
    }
  } catch (err) {
    console.warn("[freenet-hub] backup after tip notify failed", err);
  }

  notifyBackupStatusChanged(prefix);
}

let tipPushListenerInstalled = false;

/** Install once — tip pushes enqueue backup refresh without needing a list page. */
export function ensureBackupTipPushListener(): void {
  if (tipPushListenerInstalled) return;
  tipPushListenerInstalled = true;
  void import("./tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
    onRepoTipPushed((prefix) => {
      void enqueueBackupRefreshAfterTipPush(prefix);
    });
  });
}

/**
 * Queue auto-updates for pins that are out of date (or hollow).
 * Does not create new backups — only refreshes existing pins.
 */
export function queueBackupAutoSync(
  prefixes: string[],
  opts?: {
    /** @deprecated ignored — auto-sync no longer creates backups */
    ensureReason?: BackupReason;
    onItem?: (prefix: string, status: BackupStatus | null, err?: string) => void;
    /** Gap between items (ms). */
    gapMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const onItem = opts?.onItem;
  const gapMs = opts?.gapMs ?? WORKER_ITEM_GAP_MS;
  const job = async () => {
    if (!getBackupPrefs().autoUpdateExisting) return;
    const unique = [...new Set(prefixes.filter(Boolean))];
    for (let i = 0; i < unique.length; i++) {
      if (opts?.signal?.aborted) return;
      const prefix = unique[i]!;
      try {
        const pin = await backupGetPin(prefix);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // if (!pin && ensureReason) await pinRepoBackup(...)  // auto-created hollow pins
        // NEW CODE - TESTING: only touch existing pins that are stale/hollow
        if (!pin || pin.reasons.length === 0) {
          onItem?.(prefix, await getBackupStatus(prefix));
        } else if (
          pin.contentHashes.length === 0 ||
          tipIdentity(pin.tipBundles).length === 0
        ) {
          const next = await syncRepoBackup(prefix, {
            reason: pin.reasons[0],
          });
          await markBackupChecked(prefix);
          onItem?.(prefix, next);
        } else {
          const status = await getBackupStatus(prefix);
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // if (status.freshness === "stale" || status.freshness === "unknown")
          // NEW CODE - TESTING: also repair incomplete (hash-only) pins
          if (
            status.freshness === "stale" ||
            status.freshness === "unknown" ||
            status.freshness === "incomplete"
          ) {
            const next =
              status.freshness === "incomplete"
                ? await repairIncompleteBackup(prefix)
                : await syncRepoBackup(prefix, {
                    reason: pin.reasons[0],
                  });
            await markBackupChecked(prefix);
            onItem?.(prefix, next);
          } else {
            await markBackupChecked(prefix);
            onItem?.(prefix, await getBackupStatus(prefix));
          }
        }
      } catch (err) {
        onItem?.(
          prefix,
          null,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (i + 1 < unique.length && gapMs > 0) {
        await sleep(gapMs);
      }
    }
  };
  syncQueue = syncQueue.then(job, job);
  return syncQueue;
}

type WorkerJob =
  | { kind: "create"; prefix: string; reason: BackupReason }
  | { kind: "update"; prefix: string; reason: BackupReason };

/**
 * One background pass: optional create (own/stars) + update stale pins.
 * Items are spaced apart so Freenet GETs/PUTs do not stampede.
 */
export async function runGlobalBackupPass(opts?: {
  signal?: AbortSignal;
  onItem?: (prefix: string, note: string) => void;
  gapMs?: number;
}): Promise<void> {
  const prefs = getBackupPrefs();
  if (
    !prefs.autoUpdateExisting &&
    !prefs.autoBackupOwnRepos &&
    !prefs.autoBackupStars
  ) {
    return;
  }

  const { getCachedIdentity } = await import("./auth-api");
  if (!getCachedIdentity()) return;

  const jobs: WorkerJob[] = [];
  const seen = new Set<string>();

  if (prefs.autoBackupOwnRepos || prefs.autoUpdateExisting) {
    try {
      const { nativeListRepos } = await import("./owner-api");
      const repos = await nativeListRepos();
      for (const r of repos) {
        if (!r.prefix || seen.has(r.prefix)) continue;
        const pin = await backupGetPin(r.prefix);
        if ((!pin || pin.reasons.length === 0) && prefs.autoBackupOwnRepos) {
          jobs.push({ kind: "create", prefix: r.prefix, reason: "own" });
          seen.add(r.prefix);
        } else if (
          pin &&
          pin.reasons.length > 0 &&
          prefs.autoUpdateExisting
        ) {
          jobs.push({
            kind: "update",
            prefix: r.prefix,
            reason: pin.reasons.includes("own") ? "own" : pin.reasons[0]!,
          });
          seen.add(r.prefix);
        }
      }
    } catch (err) {
      console.warn("[freenet-hub] backup worker list repos failed", err);
    }
  }

  if (prefs.autoBackupStars || prefs.autoUpdateExisting) {
    try {
      const { fetchHubStars, reposStarredBy } = await import("./hub-stars");
      const id = getCachedIdentity()!;
      const { state } = await fetchHubStars();
      const stars = reposStarredBy(state, id.fingerprint);
      for (const s of stars) {
        const prefix = s.repo_prefix;
        if (!prefix) continue;
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // if (!prefix || seen.has(prefix)) continue;
        // — skipped owned∩starred without attaching the star reason.
        // NEW CODE - TESTING: one backup job per prefix; merge star reason if needed
        if (seen.has(prefix)) {
          if (prefs.autoBackupStars) {
            const pin = await backupGetPin(prefix);
            if (pin && pin.reasons.length > 0 && !pin.reasons.includes("star")) {
              await backupAddReason(prefix, "star");
            }
          }
          continue;
        }
        const pin = await backupGetPin(prefix);
        if ((!pin || pin.reasons.length === 0) && prefs.autoBackupStars) {
          jobs.push({ kind: "create", prefix, reason: "star" });
          seen.add(prefix);
        } else if (
          pin &&
          pin.reasons.length > 0 &&
          prefs.autoUpdateExisting
        ) {
          jobs.push({
            kind: "update",
            prefix,
            reason: pin.reasons.includes("star") ? "star" : pin.reasons[0]!,
          });
          seen.add(prefix);
        }
      }
    } catch (err) {
      console.warn("[freenet-hub] backup worker list stars failed", err);
    }
  }

  // Existing pins not covered above (e.g. unregistered own still in identity list).
  if (prefs.autoUpdateExisting) {
    const pins = await backupListPins();
    for (const pin of pins) {
      if (pin.prefix === BACKUP_PREFS_PIN_PREFIX) continue;
      if (pin.reasons.length === 0 || seen.has(pin.prefix)) continue;
      jobs.push({
        kind: "update",
        prefix: pin.prefix,
        reason: pin.reasons[0]!,
      });
      seen.add(pin.prefix);
    }
  }

  const gapMs = opts?.gapMs ?? WORKER_ITEM_GAP_MS;
  for (let i = 0; i < jobs.length; i++) {
    if (opts?.signal?.aborted) return;
    const job = jobs[i]!;
    try {
      if (job.kind === "create") {
        opts?.onItem?.(job.prefix, `Backing up ${job.prefix}…`);
        await pinRepoBackup(job.prefix, job.reason);
        await markBackupChecked(job.prefix);
        // NEW CODE - TESTING: notify self-inbox for background auto-backup
        try {
          const { notifySelfSystem, SYSTEM_KIND_BACKUP_CREATED } =
            await import("./system-notify");
          await notifySelfSystem(SYSTEM_KIND_BACKUP_CREATED, {
            title: "New repo backup created",
            detail: `Automatically backed up ${job.prefix} (${job.reason}).`,
            prefix: job.prefix,
          });
        } catch (err) {
          console.warn("[freenet-hub] backup create notify failed", err);
        }
      } else {
        const pin = await backupGetPin(job.prefix);
        if (!pin || pin.reasons.length === 0) continue;
        const status = await getBackupStatus(job.prefix);
        if (
          status.freshness === "stale" ||
          status.freshness === "unknown" ||
          status.freshness === "incomplete" ||
          pin.contentHashes.length === 0
        ) {
          opts?.onItem?.(
            job.prefix,
            status.freshness === "incomplete"
              ? `Repairing incomplete backup ${job.prefix}…`
              : `Updating backup ${job.prefix}…`,
          );
          const beforeTip = tipIdentity(pin.tipBundles);
          if (status.freshness === "incomplete") {
            await repairIncompleteBackup(job.prefix);
          } else {
            await syncRepoBackup(job.prefix, { reason: job.reason });
          }
          const after = await backupGetPin(job.prefix);
          const afterTip = after ? tipIdentity(after.tipBundles) : "";
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // Only notify when tip content actually changed.
          // if (afterTip && afterTip !== beforeTip) { notify… }
          // NEW CODE - TESTING: notify on every successful stale→sync (packs may
          // refresh without tipIdentity changing; user asked for inbox notice)
          try {
            const { notifySelfSystem, SYSTEM_KIND_BACKUP_UPDATED } =
              await import("./system-notify");
            const tipChanged = Boolean(afterTip && afterTip !== beforeTip);
            await notifySelfSystem(SYSTEM_KIND_BACKUP_UPDATED, {
              title: "Repo backup updated",
              detail: tipChanged
                ? `Background sync refreshed ${job.prefix} to a newer tip.`
                : `Background sync refreshed backup packs for ${job.prefix}.`,
              prefix: job.prefix,
            });
          } catch (err) {
            console.warn(
              "[freenet-hub] backup update notify failed",
              err,
            );
          }
        } else {
          opts?.onItem?.(job.prefix, `Checked ${job.prefix}`);
        }
        await markBackupChecked(job.prefix);
      }
    } catch (err) {
      console.warn(
        `[freenet-hub] backup worker ${job.kind} ${job.prefix}`,
        err,
      );
    }
    if (i + 1 < jobs.length && gapMs > 0) {
      await sleep(gapMs);
    }
  }
}

export async function listPinnedPrefixes(
  reason?: BackupReason,
): Promise<string[]> {
  const pins = await backupListPins();
  return pins
    .filter(
      (p) =>
        p.prefix !== BACKUP_PREFS_PIN_PREFIX &&
        (reason ? p.reasons.includes(reason) : p.reasons.length > 0),
    )
    .map((p) => p.prefix);
}

/** Repo backup pins on the identity delegate / local store (excludes prefs stub). */
export async function countRepoBackupPins(): Promise<number> {
  return (await listPinnedPrefixes()).length;
}
