/**
 * In-memory cache for public WASM artefacts under the site root.
 *
 * freenet-git reuses pack-contract bytes across chunk Puts (borrow / Arc).
 * Hub Puts used to re-fetch the same file every write; this keeps one fetch
 * per path per page lifetime. See docs/15-freenet-git-ws-hygiene.md.
 *
 * Returns a fresh copy so Put builders may `Array.from` / pass ownership
 * without mutating the cached buffer.
 */
const cache = new Map<string, Uint8Array>();
const inflight = new Map<string, Promise<Uint8Array>>();

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("wasm path required");
  return trimmed.startsWith("./") || trimmed.startsWith("/")
    ? trimmed
    : `./${trimmed}`;
}

/**
 * Resolve a site-root asset against the Freenet website basename when present.
 * Relative `./x.wasm` from `/v1/contract/web/KEY/owner~repo/settings` would
 * otherwise 404 as `…/owner~repo/x.wasm`.
 */
export function resolvePublicAssetUrl(path: string): string {
  const name = normalizePath(path).replace(/^\.\//, "").replace(/^\//, "");
  if (typeof window !== "undefined" && window.location?.pathname) {
    const m = window.location.pathname.match(
      /^(\/v[12]\/contract\/web\/[^/]+)/,
    );
    if (m?.[1]) return `${m[1]}/${name}`;
  }
  try {
    const base = String(
      (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env
        ?.BASE_URL ?? "/",
    );
    const root = base.endsWith("/") ? base : `${base}/`;
    return `${root}${name}`;
  } catch {
    return `./${name}`;
  }
}

async function readWasmBytes(key: string): Promise<Uint8Array> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch(key); — deep Freenet SPA routes break ./relative
  // NEW CODE - TESTING: resolve against /v1/contract/web/{key}/ then fetch
  const url = resolvePublicAssetUrl(key);
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      return new Uint8Array(await resp.arrayBuffer());
    }
  } catch {
    /* fall through to filesystem */
  }
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const name = key.replace(/^\.\//, "");
  const candidates = [
    join(here, "..", "..", "public", name),
    join(here, "..", "public", name),
    join(process.cwd(), "web", "public", name),
    join(process.cwd(), "public", name),
  ];
  for (const abs of candidates) {
    if (existsSync(abs)) {
      return new Uint8Array(readFileSync(abs));
    }
  }
  throw new Error(
    `failed to load wasm ${key} (tried ${url} + ${candidates.join(", ")})`,
  );
}

export async function loadPublicWasm(path: string): Promise<Uint8Array> {
  const key = normalizePath(path);
  const hit = cache.get(key);
  if (hit) {
    return hit.slice();
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const bytes = await readWasmBytes(key);
      cache.set(key, bytes);
      return bytes;
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  const bytes = await pending;
  return bytes.slice();
}

/** Test / hot-reload helper — clears cached WASM bytes. */
export function clearPublicWasmCache(): void {
  cache.clear();
  inflight.clear();
}
