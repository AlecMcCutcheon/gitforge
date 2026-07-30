/**
 * Short-lived in-memory / session caches for discover-page Freenet reads.
 */
import type { ForgeRegistration } from "../api";
import type { ForgeStarsStateJson } from "./forge-stars";

const REGISTRY_KEY = "gitforge.registry.v1";
const STARS_KEY = "gitforge.stars.v1";

/** Prefixes removed locally until a later upsert re-lists them. */
const locallyRemovedPrefixes = new Set<string>();

let registryMemory: ForgeRegistration[] | null = null;
let starsMemory: ForgeStarsStateJson | null = null;
let starsInflight: Promise<ForgeStarsStateJson> | null = null;
/** Bumped on invalidate/upsert so stale in-flight GETs cannot overwrite. */
let registryEpoch = 0;

export function peekCachedRegistry(): ForgeRegistration[] | null {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return registryMemory / session as-is
  // NEW CODE - TESTING: hide locally-unregistered prefixes from warm reads
  if (!registryMemory) {
    try {
      const raw = sessionStorage.getItem(REGISTRY_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as { repos?: ForgeRegistration[] };
      if (Array.isArray(data.repos)) {
        registryMemory = data.repos;
      }
    } catch {
      /* ignore */
    }
  }
  if (!registryMemory) return null;
  return applyLocalRemovals(registryMemory);
}

export function storeCachedRegistry(repos: ForgeRegistration[]): void {
  registryMemory = repos;
  try {
    sessionStorage.setItem(REGISTRY_KEY, JSON.stringify({ repos }));
  } catch {
    /* ignore */
  }
}

/**
 * Merge a just-registered / updated listing into the warm cache so repo pages
 * navigated to right after create see Registered without waiting on a GET race.
 */
export function upsertCachedRegistryEntry(entry: ForgeRegistration): void {
  const cur = peekCachedRegistry() ?? [];
  const next = [
    ...cur.filter((r) => r.repo_prefix !== entry.repo_prefix),
    entry,
  ];
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // storeCachedRegistry only; stale inflight could wipe the upsert.
  // NEW CODE - TESTING: bump epoch + drop inflight so late GETs don't clobber
  locallyRemovedPrefixes.delete(entry.repo_prefix);
  registryEpoch += 1;
  registryInflight = null;
  storeCachedRegistry(next);
}

/**
 * Drop one listing from the warm cache (unregister / soft-delete).
 * Keeps a tombstone so a lagging ForgeRegistry GET cannot resurrect it.
 */
export function removeCachedRegistryEntry(prefix: string): void {
  locallyRemovedPrefixes.add(prefix);
  registryEpoch += 1;
  registryInflight = null;
  const cur = peekCachedRegistry();
  if (cur) {
    storeCachedRegistry(cur.filter((r) => r.repo_prefix !== prefix));
  } else {
    storeCachedRegistry([]);
  }
}

/** Drop warm registry so Discover refreshes after unregister / soft-delete. */
export function invalidateRegistryCache(): void {
  registryMemory = null;
  registryInflight = null;
  registryEpoch += 1;
  locallyRemovedPrefixes.clear();
  try {
    sessionStorage.removeItem(REGISTRY_KEY);
  } catch {
    /* ignore */
  }
}

/** True while this tab intentionally unregistered the prefix (session tombstone). */
export function isLocallyRemovedRegistryPrefix(prefix: string): boolean {
  return locallyRemovedPrefixes.has(prefix.trim());
}

function applyLocalRemovals(repos: ForgeRegistration[]): ForgeRegistration[] {
  if (locallyRemovedPrefixes.size === 0) return repos;
  return repos.filter((r) => !locallyRemovedPrefixes.has(r.repo_prefix));
}

let registryInflight: Promise<ForgeRegistration[]> | null = null;

/** Deduped ForgeRegistry GET — repo pages were issuing 3× identical contract GETs. */
export async function loadRegistryCached(
  fetcher: () => Promise<{ repos: ForgeRegistration[] }>,
): Promise<ForgeRegistration[]> {
  const warm = peekCachedRegistry();
  if (warm) {
    if (!registryInflight) {
      const epoch = registryEpoch;
      registryInflight = fetcher()
        .then(({ repos }) => {
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // storeCachedRegistry(repos);
          // NEW CODE - TESTING: skip store if upsert/invalidate raced ahead;
          // always strip locally-removed prefixes so stale Freenet GETs don't
          // resurrect an unregister that already succeeded on this node.
          if (epoch === registryEpoch) {
            storeCachedRegistry(applyLocalRemovals(repos));
          }
          return peekCachedRegistry() ?? applyLocalRemovals(repos);
        })
        .finally(() => {
          registryInflight = null;
        });
    }
    return applyLocalRemovals(warm);
  }
  if (registryInflight) return registryInflight;
  const epoch = registryEpoch;
  registryInflight = fetcher()
    .then(({ repos }) => {
      const filtered = applyLocalRemovals(repos);
      if (epoch === registryEpoch) {
        storeCachedRegistry(filtered);
      }
      return peekCachedRegistry() ?? filtered;
    })
    .finally(() => {
      registryInflight = null;
    });
  return registryInflight;
}

export function peekCachedStars(): ForgeStarsStateJson | null {
  if (starsMemory) return starsMemory;
  try {
    const raw = sessionStorage.getItem(STARS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as ForgeStarsStateJson;
    if (data && typeof data === "object" && data.by_repo) {
      starsMemory = data;
      return data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function storeCachedStars(state: ForgeStarsStateJson): void {
  starsMemory = state;
  try {
    sessionStorage.setItem(STARS_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** Deduped ForgeStars GET so discover badges / profiles share one round-trip. */
export async function loadStarsCached(
  fetcher: () => Promise<{ state: ForgeStarsStateJson }>,
): Promise<ForgeStarsStateJson> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (starsMemory) { … return starsMemory; }
  // NEW CODE - TESTING: hydrate from session peek, not only in-process memory
  const warm = peekCachedStars();
  if (warm) {
    if (!starsInflight) {
      starsInflight = fetcher()
        .then(({ state }) => {
          storeCachedStars(state);
          return state;
        })
        .finally(() => {
          starsInflight = null;
        });
    }
    return warm;
  }
  if (starsInflight) return starsInflight;
  starsInflight = fetcher()
    .then(({ state }) => {
      storeCachedStars(state);
      return state;
    })
    .finally(() => {
      starsInflight = null;
    });
  return starsInflight;
}
