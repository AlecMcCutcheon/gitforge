/**
 * Content-addressed repo backup: tip pack bytes + pin index.
 * Blobs are durable on the forge-identity delegate; IndexedDB/memory are mirrors.
 * Shared by Stars + Repositories — one pin per repo_prefix; reasons dedupe star∩own.
 */

import type { ForgeRegistration } from "../api";
import type { TipBundle } from "../tip-browse/decode-wasm";
import type { ForgeRepoMetaStateJson } from "./forge-repo";

export type BackupReason = "star" | "own";

export interface RepoBackupBlob {
  hashHex: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

export interface RepoBackupPin {
  prefix: string;
  reasons: BackupReason[];
  /** Prefer updating this pin when Stars/Repos auto-sync runs. */
  autoUpdate: boolean;
  tipCommit: string | null;
  tipBundles: TipBundle[];
  /** Content hashes stored for the pinned tip (packs / manifests / chunks). */
  contentHashes: string[];
  registry: ForgeRegistration | null;
  repoMeta: ForgeRepoMetaStateJson | null;
  pinnedAt: number;
  updatedAt: number;
  /** Wall time of last freshness / auto-worker check (persisted in identity). */
  lastCheckedAt?: number;
}

/** Reserved pin prefix for backup prefs JSON in the identity secret. */
export const BACKUP_PREFS_PIN_PREFIX = "__gitforge_backup_prefs__";

const DB_NAME = "gitforge-repo-backup";
const BLOBS = "blobs";
const PINS = "pins";
const DB_VERSION = 1;

const memoryBlobs = new Map<string, RepoBackupBlob>();
const memoryPins = new Map<string, RepoBackupPin>();

let idbAvailable: boolean | null = null;

async function probeIdb(): Promise<boolean> {
  if (idbAvailable !== null) return idbAvailable;
  if (typeof indexedDB === "undefined") {
    idbAvailable = false;
    return false;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: "hashHex" });
        }
        if (!db.objectStoreNames.contains(PINS)) {
          db.createObjectStore(PINS, { keyPath: "prefix" });
        }
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () =>
        reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
    idbAvailable = true;
  } catch {
    idbAvailable = false;
  }
  return idbAvailable;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS, { keyPath: "hashHex" });
      }
      if (!db.objectStoreNames.contains(PINS)) {
        db.createObjectStore(PINS, { keyPath: "prefix" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function normalizeHash(hashHex: string): string {
  return hashHex.trim().toLowerCase();
}

function mergeReasons(
  a: BackupReason[],
  b: BackupReason[],
): BackupReason[] {
  return [...new Set([...a, ...b])];
}

/** Slim pin for identity secrets (drop channel history — keeps message small). */
export function pinForIdentityStore(pin: RepoBackupPin): RepoBackupPin {
  return {
    ...pin,
    tipBundles: pin.tipBundles.map((b) => ({
      bundle_id: b.bundle_id,
      tip_commit: b.tip_commit,
      kind: b.kind,
      pack_hash: b.pack_hash ?? null,
      manifest_hash: b.manifest_hash ?? null,
      size_bytes: b.size_bytes ?? null,
      total_size: b.total_size ?? null,
      chunk_count: b.chunk_count ?? null,
    })),
    repoMeta: pin.repoMeta
      ? {
          ...pin.repoMeta,
          channels: { public: [], private: [] },
        }
      : null,
  };
}

export async function backupGetBlob(
  hashHex: string,
): Promise<RepoBackupBlob | null> {
  const key = normalizeHash(hashHex);
  const mem = memoryBlobs.get(key);
  if (mem) return mem;
  if (await probeIdb()) {
    try {
      const db = await openDb();
      const row = await new Promise<RepoBackupBlob | null>((resolve, reject) => {
        const tx = db.transaction(BLOBS, "readonly");
        const req = tx.objectStore(BLOBS).get(key);
        req.onsuccess = () => {
          resolve((req.result as RepoBackupBlob | undefined) ?? null);
        };
        req.onerror = () => reject(req.error);
      });
      if (row?.bytes && row.bytes.byteLength > 0) {
        memoryBlobs.set(key, row);
        return row;
      }
    } catch (err) {
      console.warn("[freenet-forge] backupGetBlob failed; trying identity", err);
      idbAvailable = false;
    }
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return null when IDB/memory miss (Freenet sandbox → always miss after reload)
  // NEW CODE - TESTING: hydrate tip pack bytes from identity delegate secrets
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (!isBrowserNativeMode()) return null;
    const { forgeOwnerContractsReady } = await import("./owner-constants");
    if (!forgeOwnerContractsReady()) return null;
    const { nativeGetRepoBackupBlob } = await import("./owner-api");
    const bytes = await nativeGetRepoBackupBlob(key);
    if (!bytes || bytes.length === 0) return null;
    const entry: RepoBackupBlob = {
      hashHex: key,
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      storedAt: Date.now(),
    };
    memoryBlobs.set(key, entry);
    if (await probeIdb()) {
      try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(BLOBS, "readwrite");
          tx.objectStore(BLOBS).put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        /* best-effort IDB mirror */
      }
    }
    return entry;
  } catch (err) {
    console.warn("[freenet-forge] identity backup blob get failed", err);
    return null;
  }
}

export async function backupPutBlob(
  hashHex: string,
  bytes: Uint8Array,
): Promise<void> {
  const key = normalizeHash(hashHex);
  const entry: RepoBackupBlob = {
    hashHex: key,
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    storedAt: Date.now(),
  };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // memory + IDB only — wiped by Freenet sandbox reload
  // NEW CODE - TESTING: identity delegate first (durable), then local mirrors
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (isBrowserNativeMode()) {
      const { forgeOwnerContractsReady } = await import("./owner-constants");
      if (forgeOwnerContractsReady()) {
        const { nativeUpsertRepoBackupBlob } = await import("./owner-api");
        await nativeUpsertRepoBackupBlob(key, bytes);
      }
    }
  } catch (err) {
    console.warn("[freenet-forge] identity backup blob put failed", err);
    throw err instanceof Error
      ? err
      : new Error(String(err ?? "identity backup blob put failed"));
  }

  memoryBlobs.set(key, entry);
  if (await probeIdb()) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(BLOBS, "readwrite");
        tx.objectStore(BLOBS).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("[freenet-forge] backupPutBlob IDB failed; kept in memory", err);
      idbAvailable = false;
    }
  }
}

/** True when tip pack bytes exist in memory, IDB, or the identity delegate. */
export async function backupHasBlob(hashHex: string): Promise<boolean> {
  const row = await backupGetBlob(hashHex);
  return Boolean(row?.bytes && row.bytes.byteLength > 0);
}

/** Count how many of `hashes` have durable bytes available. */
export async function backupCountPresentBlobs(
  hashes: string[],
): Promise<{ present: number; missing: string[] }> {
  const wanted = [
    ...new Set(hashes.map((h) => normalizeHash(h)).filter(Boolean)),
  ];
  if (wanted.length === 0) return { present: 0, missing: [] };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // for (const h of hashes) if (await backupHasBlob(h)) …
  // NEW CODE - TESTING: prefer identity-delegate index (true durable store)
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (isBrowserNativeMode()) {
      const { forgeOwnerContractsReady } = await import("./owner-constants");
      if (forgeOwnerContractsReady()) {
        const { nativeListRepoBackupBlobHashes } = await import("./owner-api");
        const indexed = new Set(
          (await nativeListRepoBackupBlobHashes()).map((h) =>
            normalizeHash(h),
          ),
        );
        const missing: string[] = [];
        let present = 0;
        for (const h of wanted) {
          if (indexed.has(h)) present += 1;
          else missing.push(h);
        }
        return { present, missing };
      }
    }
  } catch (err) {
    console.warn(
      "[freenet-forge] durable blob audit via identity failed; local fallback",
      err,
    );
  }

  const missing: string[] = [];
  let present = 0;
  for (const h of wanted) {
    if (await backupHasBlob(h)) present += 1;
    else missing.push(h);
  }
  return { present, missing };
}

/**
 * Drop CA blobs that no remaining pin references.
 * Call after pin clear / tip update so the delegate store does not grow forever.
 */
export async function backupGcUnreferencedBlobs(
  keepHashes?: Iterable<string>,
): Promise<number> {
  const keep = new Set(
    [...(keepHashes ?? [])].map((h) => normalizeHash(h)).filter(Boolean),
  );
  if (keep.size === 0) {
    // Collect from all pins when caller did not pass an allow-list.
    const pins = await backupListPins();
    for (const pin of pins) {
      if (pin.prefix === BACKUP_PREFS_PIN_PREFIX) continue;
      for (const h of pin.contentHashes) keep.add(normalizeHash(h));
    }
  }

  let removed = 0;
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (isBrowserNativeMode()) {
      const { forgeOwnerContractsReady } = await import("./owner-constants");
      if (forgeOwnerContractsReady()) {
        const {
          nativeListRepoBackupBlobHashes,
          nativeRemoveRepoBackupBlob,
        } = await import("./owner-api");
        const indexed = await nativeListRepoBackupBlobHashes();
        for (const h of indexed) {
          if (keep.has(h)) continue;
          try {
            await nativeRemoveRepoBackupBlob(h);
            memoryBlobs.delete(h);
            removed += 1;
          } catch (err) {
            console.warn("[freenet-forge] backup blob GC remove failed", h, err);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[freenet-forge] backup blob GC failed", err);
  }

  // Drop orphaned IDB blobs best-effort.
  if (await probeIdb()) {
    try {
      const db = await openDb();
      const all = await new Promise<RepoBackupBlob[]>((resolve, reject) => {
        const tx = db.transaction(BLOBS, "readonly");
        const req = tx.objectStore(BLOBS).getAll();
        req.onsuccess = () => resolve((req.result as RepoBackupBlob[]) ?? []);
        req.onerror = () => reject(req.error);
      });
      for (const row of all) {
        const h = normalizeHash(row.hashHex);
        if (keep.has(h)) continue;
        memoryBlobs.delete(h);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(BLOBS, "readwrite");
          tx.objectStore(BLOBS).delete(h);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        removed += 1;
      }
    } catch (err) {
      console.warn("[freenet-forge] backup IDB blob GC failed", err);
    }
  }
  return removed;
}

export async function backupGetPin(
  prefix: string,
): Promise<RepoBackupPin | null> {
  const mem = memoryPins.get(prefix);
  if (mem) return mem;
  if (await probeIdb()) {
    try {
      const db = await openDb();
      const row = await new Promise<RepoBackupPin | null>((resolve, reject) => {
        const tx = db.transaction(PINS, "readonly");
        const req = tx.objectStore(PINS).get(prefix);
        req.onsuccess = () => {
          resolve((req.result as RepoBackupPin | undefined) ?? null);
        };
        req.onerror = () => reject(req.error);
      });
      if (row) {
        memoryPins.set(prefix, row);
        return row;
      }
    } catch (err) {
      console.warn("[freenet-forge] backupGetPin IDB failed", err);
      idbAvailable = false;
    }
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return null when IDB/memory miss (Freenet sandbox → always miss after reload)
  // NEW CODE - TESTING: hydrate pin index from identity delegate secrets
  await hydratePinsFromIdentity();
  return memoryPins.get(prefix) ?? null;
}

export async function backupPutPin(pin: RepoBackupPin): Promise<void> {
  // Avoid recursive identity hydrate while merging.
  const existing = memoryPins.get(pin.prefix) ?? null;
  let fromIdb: RepoBackupPin | null = null;
  if (!existing && (await probeIdb())) {
    try {
      const db = await openDb();
      fromIdb = await new Promise((resolve, reject) => {
        const tx = db.transaction(PINS, "readonly");
        const req = tx.objectStore(PINS).get(pin.prefix);
        req.onsuccess = () =>
          resolve((req.result as RepoBackupPin | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      idbAvailable = false;
    }
  }
  const prior = existing ?? fromIdb;
  // Never replace a tip-complete pin with a hollow one (auto-sync race).
  if (
    prior &&
    prior.contentHashes.length > 0 &&
    pin.contentHashes.length === 0
  ) {
    const kept: RepoBackupPin = {
      ...prior,
      reasons: mergeReasons(prior.reasons, pin.reasons),
      autoUpdate: pin.autoUpdate || prior.autoUpdate,
      updatedAt: Date.now(),
      lastCheckedAt: pin.lastCheckedAt ?? prior.lastCheckedAt,
    };
    memoryPins.set(kept.prefix, kept);
    await persistPinToIdentity(kept);
    return;
  }
  const merged: RepoBackupPin = prior
    ? {
        ...pin,
        reasons: mergeReasons(prior.reasons, pin.reasons),
        autoUpdate: pin.autoUpdate || prior.autoUpdate,
        pinnedAt: prior.pinnedAt,
        lastCheckedAt: pin.lastCheckedAt ?? prior.lastCheckedAt,
      }
    : pin;
  memoryPins.set(merged.prefix, merged);
  if (await probeIdb()) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PINS, "readwrite");
        tx.objectStore(PINS).put(merged);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("[freenet-forge] backupPutPin IDB failed; memory + identity", err);
      idbAvailable = false;
    }
  }
  await persistPinToIdentity(merged);
}

/** Add a reason without refreshing tip bytes (idempotent). */
export async function backupAddReason(
  prefix: string,
  reason: BackupReason,
): Promise<RepoBackupPin | null> {
  const pin = await backupGetPin(prefix);
  if (!pin) return null;
  if (pin.reasons.includes(reason)) return pin;
  const next: RepoBackupPin = {
    ...pin,
    reasons: mergeReasons(pin.reasons, [reason]),
    updatedAt: Date.now(),
  };
  await backupPutPin(next);
  return next;
}

/** Drop a reason; delete pin when no reasons remain (blobs kept — CA shared). */
export async function backupRemoveReason(
  prefix: string,
  reason: BackupReason,
): Promise<void> {
  const pin = await backupGetPin(prefix);
  if (!pin) return;
  const reasons = pin.reasons.filter((r) => r !== reason);
  if (reasons.length === 0) {
    await backupClearPin(prefix);
    return;
  }
  await backupPutPin({ ...pin, reasons, updatedAt: Date.now() });
}

/** Delete the pin for a prefix (all reasons) from memory, IDB, and identity. */
export async function backupClearPin(prefix: string): Promise<void> {
  memoryPins.delete(prefix);
  if (await probeIdb()) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PINS, "readwrite");
        tx.objectStore(PINS).delete(prefix);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn("[freenet-forge] backupClearPin IDB failed", err);
      idbAvailable = false;
    }
  }
  await removePinFromIdentity(prefix, null);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // blobs kept — CA shared
  // NEW CODE - TESTING: GC tip pack bytes no longer referenced by any pin
  try {
    await backupGcUnreferencedBlobs();
  } catch (err) {
    console.warn("[freenet-forge] backup blob GC after clear failed", err);
  }
}

export async function backupListPins(): Promise<RepoBackupPin[]> {
  await hydratePinsFromIdentity();
  if (await probeIdb()) {
    try {
      const db = await openDb();
      const rows = await new Promise<RepoBackupPin[]>((resolve, reject) => {
        const tx = db.transaction(PINS, "readonly");
        const req = tx.objectStore(PINS).getAll();
        req.onsuccess = () => resolve((req.result as RepoBackupPin[]) ?? []);
        req.onerror = () => reject(req.error);
      });
      for (const row of rows) memoryPins.set(row.prefix, row);
    } catch (err) {
      console.warn("[freenet-forge] backupListPins IDB failed", err);
      idbAvailable = false;
    }
  }
  return [...memoryPins.values()];
}

let identityHydrate: Promise<void> | null = null;

function parsePin(raw: unknown): RepoBackupPin | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const prefix = typeof o.prefix === "string" ? o.prefix : "";
  if (!prefix) return null;
  const reasonsRaw = Array.isArray(o.reasons) ? o.reasons : [];
  const reasons = reasonsRaw.filter(
    (r): r is BackupReason => r === "star" || r === "own",
  );
  return {
    prefix,
    reasons,
    autoUpdate: o.autoUpdate !== false,
    tipCommit: typeof o.tipCommit === "string" ? o.tipCommit : null,
    tipBundles: Array.isArray(o.tipBundles)
      ? (o.tipBundles as RepoBackupPin["tipBundles"])
      : [],
    contentHashes: Array.isArray(o.contentHashes)
      ? o.contentHashes.filter((h): h is string => typeof h === "string")
      : [],
    registry: (o.registry as RepoBackupPin["registry"]) ?? null,
    repoMeta: (o.repoMeta as RepoBackupPin["repoMeta"]) ?? null,
    pinnedAt: typeof o.pinnedAt === "number" ? o.pinnedAt : Date.now(),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    lastCheckedAt:
      typeof o.lastCheckedAt === "number" ? o.lastCheckedAt : undefined,
  };
}

async function hydratePinsFromIdentity(): Promise<void> {
  if (identityHydrate) return identityHydrate;
  identityHydrate = (async () => {
    try {
      const { isBrowserNativeMode } = await import("../tip-browse");
      if (!isBrowserNativeMode()) return;
      const { forgeOwnerContractsReady } = await import("./owner-constants");
      if (!forgeOwnerContractsReady()) return;
      const { nativeListRepoBackupPins } = await import("./owner-api");
      const rows = await nativeListRepoBackupPins();
      for (const raw of rows) {
        if (
          raw &&
          typeof raw === "object" &&
          (raw as { prefix?: string }).prefix === BACKUP_PREFS_PIN_PREFIX
        ) {
          continue;
        }
        const pin = parsePin(raw);
        if (!pin || pin.reasons.length === 0) continue;
        if (pin.prefix === BACKUP_PREFS_PIN_PREFIX) continue;
        const cur = memoryPins.get(pin.prefix);
        if (!cur || pin.updatedAt >= cur.updatedAt) {
          memoryPins.set(pin.prefix, pin);
        }
      }
    } catch (err) {
      console.warn("[freenet-forge] identity backup hydrate failed", err);
      // Allow retry later (e.g. identity not ready yet).
      identityHydrate = null;
    }
  })();
  return identityHydrate;
}

async function persistPinToIdentity(pin: RepoBackupPin): Promise<void> {
  const { isBrowserNativeMode } = await import("../tip-browse");
  if (!isBrowserNativeMode()) return;
  const { forgeOwnerContractsReady } = await import("./owner-constants");
  if (!forgeOwnerContractsReady()) {
    throw new Error("Owner identity not ready — rebuild/publish forge-identity");
  }
  const { nativeUpsertRepoBackupPin } = await import("./owner-api");
  await nativeUpsertRepoBackupPin(pinForIdentityStore(pin));
  // Allow a later hydrate to re-read what we just wrote.
  identityHydrate = null;
}

async function removePinFromIdentity(
  prefix: string,
  reason: BackupReason | null,
): Promise<void> {
  try {
    const { isBrowserNativeMode } = await import("../tip-browse");
    if (!isBrowserNativeMode()) return;
    const { forgeOwnerContractsReady } = await import("./owner-constants");
    if (!forgeOwnerContractsReady()) return;
    const { nativeRemoveRepoBackupPin } = await import("./owner-api");
    await nativeRemoveRepoBackupPin(prefix, reason);
  } catch (err) {
    console.warn("[freenet-forge] identity backup remove failed", err);
  }
}
