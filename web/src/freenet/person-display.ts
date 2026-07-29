/**
 * Resolve a person's display username from HubProfile by fingerprint.
 * HubRegistry no longer stores usernames — only identity_fingerprint.
 */
import { isFingerprintId } from "./fingerprint-words";
import { fetchHubProfile } from "./hub-profile";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normFp(fingerprint: string): string {
  return fingerprint.trim().toLowerCase();
}

/**
 * Fallback when HubProfile is missing / has no username.
 * Prefer the registry identity_fingerprint (`freenet:id:…`) over blank UI.
 */
export function personDisplayFallback(fingerprint: string): string {
  const fp = fingerprint.trim();
  if (!fp) return "unknown";
  return fp;
}

/**
 * Resolve HubProfile.username for a fingerprint (cached).
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
      const profile = await fetchHubProfile(fingerprint).catch(() => null);
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
  await Promise.all(
    unique.map((fp) =>
      resolvePersonDisplayName(
        fingerprints.find((f) => normFp(f) === fp) ?? fp,
      ),
    ),
  );
}

/** Drop cached name (e.g. after self profile save). */
export function invalidatePersonDisplayName(fingerprint: string): void {
  cache.delete(normFp(fingerprint));
}
