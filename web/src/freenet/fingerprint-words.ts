/**
 * Mail-inspired six fingerprint words over BLAKE3(fingerprint UTF-8).
 *
 * Same packing as freenet-mail `address_book::fingerprint_words` (6×11-bit
 * BIP-39 indices), hashed over the canonical `freenet:id:…` string instead of
 * ML-DSA‖ML-KEM key bytes.
 *
 * Words are a public display / URL slug — not a secret. URLs default to the
 * six-word dash form; full `freenet:id:…` remains accepted.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { hexToBytes } from "@noble/hashes/utils";
import { wordlist } from "@scure/bip39/wordlists/english";
import bs58 from "bs58";

/** Six BIP-39 words from BLAKE3 of the canonical identity fingerprint string. */
export function fingerprintWords(fingerprint: string): string[] {
  const hash = blake3(new TextEncoder().encode(fingerprint.trim()));
  const packed = new Uint8Array(16);
  packed.set(hash.subarray(0, 12), 0);
  let n = 0n;
  for (let i = 0; i < 16; i++) {
    n = (n << 8n) | BigInt(packed[i]!);
  }
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const shift = BigInt(128 - 11 * (i + 1));
    const idx = Number((n >> shift) & 0x7ffn);
    out.push(wordlist[idx]!);
  }
  return out;
}

/** Full six-word slug: `apple-banana-cherry-…` (default people URL / contact). */
export function fingerprintWordsJoined(fingerprint: string): string {
  return fingerprintWords(fingerprint).join("-");
}

/**
 * Default public “contact” string for git-style author metadata.
 * Same as the six-word fingerprint slug — not an inbox address.
 */
export function defaultContactFromFingerprint(fingerprint: string): string {
  return fingerprintWordsJoined(fingerprint);
}

/** `freenet:id:<bs58>` from the 32-byte ed25519 seed (matches forge-identity). */
export function fingerprintFromSeedHex(seedHex: string): string {
  const secret = hexToBytes(seedHex.trim().toLowerCase().replace(/^0x/, ""));
  if (secret.length !== 32) {
    throw new Error("seed must be 32 bytes");
  }
  const pub = ed25519.getPublicKey(secret);
  return `freenet:id:${bs58.encode(pub)}`;
}

/** First three words with dashes (Mail compose-picker short form). */
export function fingerprintWordsShort(fingerprint: string): string {
  const w = fingerprintWords(fingerprint);
  return `${w[0]}-${w[1]}-${w[2]}`;
}

export function isFingerprintId(value: string): boolean {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return value.trim().toLowerCase().startsWith("freenet:id:");
  // NEW CODE - TESTING: reject query junk glued onto fp (e.g. …?tab=repos)
  const v = value.trim();
  if (!v.toLowerCase().startsWith("freenet:id:")) return false;
  if (/[?#&\s]/.test(v)) return false;
  return v.length > "freenet:id:".length;
}

/** Normalize a pasted/typed word slug (spaces or dashes, case-insensitive). */
export function normalizeWordSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * True when `raw` looks like 3–6 BIP-39 English words joined by dashes/spaces
 * (not a freenet:id or repo path).
 */
export function looksLikeWordSlug(raw: string): boolean {
  if (isFingerprintId(raw)) return false;
  const slug = normalizeWordSlug(raw);
  if (!slug || slug.includes("/") || slug.includes(":")) return false;
  const parts = slug.split("-").filter(Boolean);
  if (parts.length < 3 || parts.length > 6) return false;
  const set = new Set(wordlist);
  return parts.every((p) => set.has(p));
}

export function wordsMatchFingerprint(
  fingerprint: string,
  slug: string,
): boolean {
  const want = normalizeWordSlug(slug);
  if (!want) return false;
  const full = fingerprintWordsJoined(fingerprint);
  const short = fingerprintWordsShort(fingerprint);
  return want === full || want === short;
}

/**
 * Default people profile path using the six-word slug.
 *
 * Clean URLs: `/people/{words}` or `/people/{words}?tab=repositories|stars`.
 * Optional `?fp=` is still accepted on load (legacy / hard cases) but not emitted.
 */
export function peoplePath(
  fingerprint: string,
  opts?: { tab?: string },
): string {
  const fp = fingerprint.trim();
  const base = `/people/${encodeURIComponent(fingerprintWordsJoined(fp))}`;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const q = new URLSearchParams();
  // q.set("fp", fp);
  // if (opts?.tab && opts.tab !== "overview") q.set("tab", opts.tab);
  // return `${base}?${q.toString()}`;
  // NEW CODE - TESTING: word slug only; tab query without fp baloney
  const tabRaw = opts?.tab?.trim() ?? "";
  const tab =
    tabRaw === "repos" || tabRaw === "repositories"
      ? "repositories"
      : tabRaw === "stars"
        ? "stars"
        : "";
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
}

/**
 * Rare share/debug path that keeps the canonical freenet:id: form in the path.
 * Prefer {@link peoplePath} for normal links.
 */
export function peoplePathById(fingerprint: string): string {
  const fp = fingerprint.trim();
  return `/people/${encodeURIComponent(fp)}`;
}

/** Strip accidental `?tab=` / `&…` glued into an fp value (bad menu links). */
export function sanitizeFingerprintId(raw: string): string | null {
  const cut = raw.trim().split(/[?#&]/)[0]?.trim() ?? "";
  return isFingerprintId(cut) ? cut : null;
}

/** Read `fp` from a location search string or hash (`#/people/…?fp=`). */
export function fingerprintFromSearch(search: string): string | null {
  try {
    const q = search.startsWith("?") ? search.slice(1) : search;
    const fp = new URLSearchParams(q).get("fp")?.trim() ?? "";
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return isFingerprintId(fp) ? fp : null;
    // NEW CODE - TESTING: recover when ?tab= was appended into fp
    return sanitizeFingerprintId(fp);
  } catch {
    return null;
  }
}
