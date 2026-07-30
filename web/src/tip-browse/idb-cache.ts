/**
 * Tip-pack cache: IndexedDB when available, in-memory Map otherwise.
 * Freenet website contracts run in a null-origin sandbox where IndexedDB
 * throws ("access to the Indexed Database API is denied").
 */

export interface CachedPack {
  bundleId: string;
  prefix: string;
  commit: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

const DB_NAME = "gitforge-tip-packs";
const STORE = "packs";
const DB_VERSION = 1;

const memoryPacks = new Map<string, CachedPack>();

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
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "bundleId" });
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
    // Freenet null-origin sandbox denies IndexedDB — memory Map is expected.
    idbAvailable = false;
  }
  return idbAvailable;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "bundleId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

export async function idbGetPack(bundleId: string): Promise<CachedPack | null> {
  const mem = memoryPacks.get(bundleId);
  if (mem) return mem;
  if (!(await probeIdb())) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(bundleId);
      req.onsuccess = () => {
        const row = (req.result as CachedPack | undefined) ?? null;
        if (row) memoryPacks.set(bundleId, row);
        resolve(row);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[freenet-forge] idbGetPack failed; memory only", err);
    idbAvailable = false;
    return memoryPacks.get(bundleId) ?? null;
  }
}

export async function idbPutPack(entry: CachedPack): Promise<void> {
  memoryPacks.set(entry.bundleId, entry);
  if (!(await probeIdb())) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[freenet-forge] idbPutPack failed; kept in memory", err);
    idbAvailable = false;
  }
}

export function packCacheKey(bundleId: string): string {
  return `gitforge:pack:${bundleId}`;
}

/** Drop in-memory tip packs for one repo prefix (returns removed bundle ids). */
export function clearMemoryPacksForPrefix(prefix: string): string[] {
  const removed: string[] = [];
  for (const [id, pack] of [...memoryPacks.entries()]) {
    if (pack.prefix === prefix) {
      memoryPacks.delete(id);
      removed.push(id);
    }
  }
  return removed;
}

/** Drop all in-memory tip packs (sandbox has no durable IDB anyway). */
export function clearAllMemoryPacks(): string[] {
  const removed = [...memoryPacks.keys()];
  memoryPacks.clear();
  return removed;
}

/** Drop a bad cached pack (memory + IndexedDB) so the next load refetches. */
export async function idbDeletePack(bundleId: string): Promise<void> {
  memoryPacks.delete(bundleId);
  if (!(await probeIdb())) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(bundleId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[freenet-forge] idbDeletePack failed", err);
    idbAvailable = false;
  }
}

/** Best-effort: remove pack rows for a prefix from IDB too (when available). */
export async function idbClearPacksForPrefix(prefix: string): Promise<void> {
  const fromMem = clearMemoryPacksForPrefix(prefix);
  if (!(await probeIdb())) return;
  try {
    const db = await openDb();
    const all = await new Promise<CachedPack[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as CachedPack[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    const ids = new Set([
      ...fromMem,
      ...all.filter((p) => p.prefix === prefix).map((p) => p.bundleId),
    ]);
    if (ids.size === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const id of ids) tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[freenet-forge] idbClearPacksForPrefix failed", err);
    idbAvailable = false;
  }
}
