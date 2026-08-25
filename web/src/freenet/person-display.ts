/**
 * Resolve a person's display username from ForgeProfile by fingerprint.
 * ForgeRegistry no longer stores usernames — only identity_fingerprint.
 */
import { isFingerprintId } from "./fingerprint-words";
import { fetchForgeProfile } from "./forge-profile";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normFp(fingerprint: string): string {
  return fingerprint.trim().toLowerCase();
}

/**
 * Fallback when ForgeProfile is missing / has no username.
 * Prefer the registry identity_fingerprint (`freenet:id:…`) over blank UI.
 */
export function personDisplayFallback(fingerprint: string): string {
  const fp = fingerprint.trim();
  if (!fp) return "unknown";
  return fp;
}

/**
 * Resolve ForgeProfile.username for a fingerprint (cached).
 * Falls back to the fingerprint id when profile is missing / empty.
 */
export async function resolvePersonDisplayName(
  fingerprint: string,
): Promise<string> {
  const key = normFp(fingerprint);
  if (!key) return "unknown";
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // fetchForgeProfile(fingerprint) — probed legacy hashes × N Discover cards
      // NEW CODE - TESTING: current WASM only for display names (cheap soft GET)
      const profile = await fetchForgeProfile(fingerprint, {
        currentOnly: true,
      }).catch(() => null);
      const username = profile?.username?.trim() ?? "";
      const name =
        username && !isFingerprintId(username)
          ? username
          : personDisplayFallback(fingerprint);
      cache.set(key, name);
      return name;
    } catch {
      const fallback = personDisplayFallback(fingerprint);
      cache.set(key, fallback);
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, work);
  return work;
}

/** Warm cache for many fingerprints (Discover lists). */
export async function prefetchPersonDisplayNames(
  fingerprints: string[],
): Promise<void> {
  const unique = [...new Set(fingerprints.map(normFp).filter(Boolean))];
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Promise.all(unique.map(...)) — stampeded soft GETs, clogged Discover→repo
  // NEW CODE - TESTING: small concurrency so tip/refs can preempt cleanly
  const CONCURRENCY = 3;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((fp) =>
        resolvePersonDisplayName(
          fingerprints.find((f) => normFp(f) === fp) ?? fp,
        ),
      ),
    );
  }
}

/** Drop cached name (e.g. after self profile save). */
export function invalidatePersonDisplayName(fingerprint: string): void {
  cache.delete(normFp(fingerprint));
}
