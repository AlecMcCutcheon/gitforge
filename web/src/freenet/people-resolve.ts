/**
 * Resolve a people URL / search token to a canonical `freenet:id:…` fingerprint.
 *
 * Word slugs are one-way from the fingerprint, so reverse lookup scans known
 * fingerprints (session identity, local index, ForgeRegistry, ForgeStars).
 */
import { currentIdentity, getCachedIdentity } from "./auth-api";
import {
  fingerprintWordsJoined,
  isFingerprintId,
  looksLikeWordSlug,
  normalizeWordSlug,
  sanitizeFingerprintId,
  wordsMatchFingerprint,
} from "./fingerprint-words";
import {
  loadStarsCached,
  peekCachedRegistry,
  peekCachedStars,
  storeCachedRegistry,
} from "./discover-cache";
import { fetchForgeRegistry } from "./forge-registry";
import { fetchForgeStars } from "./forge-stars";
import { isBrowserNativeMode } from "../tip-browse";
import { api } from "../api";

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  return Promise.race([
    promise.then((v) => v).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

const LOCAL_INDEX_KEY = "gitforge.people-fp-index.v1";

/**
 * Freenet `__sandbox=1` denies localStorage (null origin). Keep a tab-lifetime
 * mirror so soft navigations still resolve word slugs after first sighting.
 */
const memoryIndex = new Map<string, string>();

function readStoredIndex(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, fp] of memoryIndex) out[slug] = fp;
  try {
    const raw = localStorage.getItem(LOCAL_INDEX_KEY);
    if (!raw) return out;
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [slug, fp] of Object.entries(data)) {
      if (isFingerprintId(fp)) {
        out[slug] = fp;
        memoryIndex.set(slug, fp);
      }
    }
  } catch {
    /* sandbox / opaque origin — memory only */
  }
  return out;
}

/** Remember a fingerprint so fingerprint-word URLs resolve on this browser. */
export function rememberPersonFingerprint(fingerprint: string): void {
  const fp = fingerprint.trim();
  if (!isFingerprintId(fp)) return;
  const slug = fingerprintWordsJoined(fp);
  memoryIndex.set(slug, fp);
  try {
    const data = readStoredIndex();
    if (data[slug] === fp) {
      /* still rewrite storage from merged memory */
    }
    data[slug] = fp;
    localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(data));
  } catch {
    /* ignore — memoryIndex still set */
  }
}

function fingerprintsFromLocalIndex(): string[] {
  return Object.values(readStoredIndex()).filter((fp) => isFingerprintId(fp));
}

function fingerprintFromLocalSlug(slug: string): string | null {
  const hit = memoryIndex.get(slug) ?? readStoredIndex()[slug];
  return hit && isFingerprintId(hit) ? hit : null;
}

async function knownFingerprints(opts?: {
  /** Await ForgeRegistry/stars so word-only cold loads can resolve. */
  network?: boolean;
}): Promise<string[]> {
  const out = new Set<string>();

  // Prefer live delegate session over stale cache alone — but don't hang resolve.
  const self =
    (
      await withTimeout(currentIdentity().catch(() => null), 2_500)
    )?.fingerprint ??
    getCachedIdentity()?.fingerprint ??
    null;
  if (self) {
    out.add(self);
    rememberPersonFingerprint(self);
  }
  for (const fp of fingerprintsFromLocalIndex()) out.add(fp);

  const addRepos = (repos: { identity_fingerprint?: string }[]) => {
    for (const r of repos) {
      if (r.identity_fingerprint) {
        out.add(r.identity_fingerprint);
        rememberPersonFingerprint(r.identity_fingerprint);
      }
    }
  };
  const addStars = (byRepo: Record<string, Record<string, unknown>>) => {
    for (const map of Object.values(byRepo)) {
      for (const fp of Object.keys(map)) {
        out.add(fp);
        rememberPersonFingerprint(fp);
      }
    }
  };

  // Warm caches only — never block word resolve on Freenet GETs (reload path).
  const cachedRepos = peekCachedRegistry();
  if (cachedRepos) addRepos(cachedRepos);
  const cachedStars = peekCachedStars();
  if (cachedStars?.by_repo) addStars(cachedStars.by_repo);

  const pullNetwork = async () => {
    if (isBrowserNativeMode()) {
      const reg = await withTimeout(fetchForgeRegistry(), 10_000);
      if (reg) {
        storeCachedRegistry(reg.repos);
        addRepos(reg.repos);
      }
      const stars = await withTimeout(
        loadStarsCached(() => fetchForgeStars()).then((state) => ({ state })),
        8_000,
      );
      if (stars?.state?.by_repo) addStars(stars.state.by_repo);
    } else {
      const data = await withTimeout(api.registry(), 8_000);
      if (data) addRepos(data.repos);
    }
  };

  if (opts?.network) {
    await pullNetwork();
  } else {
    // Background refresh for later navigations; ignore failures.
    void pullNetwork();
  }

  return [...out];
}

export type ResolvePersonResult =
  | { ok: true; fingerprint: string; via: "id" | "words" }
  | { ok: false; error: string };

/**
 * Resolve `/people/:ref` or a search box token to a fingerprint.
 * Accepts `freenet:id:…` or a 3–6 word BIP-39 slug.
 * Optional `fpHint` (`?fp=`) is legacy — preferred URLs are word-slug only.
 */
export async function resolvePersonRef(
  raw: string,
  fpHint?: string | null,
): Promise<ResolvePersonResult> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "empty person reference" };
  }

  const hint = sanitizeFingerprintId(fpHint?.trim() ?? "") ?? "";
  if (hint && isFingerprintId(hint)) {
    rememberPersonFingerprint(hint);
    // Path may be words or id; when words, verify they match the hint.
    let decoded = trimmed;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      decoded = trimmed;
    }
    if (isFingerprintId(decoded) || isFingerprintId(trimmed)) {
      return { ok: true, fingerprint: hint, via: "id" };
    }
    if (
      looksLikeWordSlug(decoded) ||
      looksLikeWordSlug(trimmed)
    ) {
      const slug = normalizeWordSlug(decoded);
      if (wordsMatchFingerprint(hint, slug)) {
        return { ok: true, fingerprint: hint, via: "words" };
      }
    } else {
      return { ok: true, fingerprint: hint, via: "id" };
    }
  }

  if (isFingerprintId(trimmed)) {
    rememberPersonFingerprint(trimmed);
    return { ok: true, fingerprint: trimmed, via: "id" };
  }

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  if (isFingerprintId(decoded)) {
    rememberPersonFingerprint(decoded);
    return { ok: true, fingerprint: decoded, via: "id" };
  }

  if (!looksLikeWordSlug(decoded) && !looksLikeWordSlug(trimmed)) {
    return {
      ok: false,
      error:
        "Use a freenet:id:… fingerprint or six fingerprint words (apple-banana-…)",
    };
  }

  const slug = normalizeWordSlug(decoded);

  const localHit = fingerprintFromLocalSlug(slug);
  if (localHit && wordsMatchFingerprint(localHit, slug)) {
    return { ok: true, fingerprint: localHit, via: "words" };
  }

  // Fast path: session + warm caches.
  let candidates = await knownFingerprints();
  let hits = candidates.filter((fp) => wordsMatchFingerprint(fp, slug));

  // Cold word-only URL: wait on ForgeRegistry/stars so registered identities resolve.
  if (hits.length === 0) {
    candidates = await knownFingerprints({ network: true });
    hits = candidates.filter((fp) => wordsMatchFingerprint(fp, slug));
  }

  if (hits.length === 1) {
    rememberPersonFingerprint(hits[0]!);
    return { ok: true, fingerprint: hits[0]!, via: "words" };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error:
        "Ambiguous fingerprint words — open the full freenet:id: link instead",
    };
  }
  return {
    ok: false,
    error:
      "No known identity matches those fingerprint words yet. Sign in if this is you, open Discover first so ForgeRegistry can load, or use a freenet:id: URL.",
  };
}
