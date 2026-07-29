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

export async function loadPublicWasm(path: string): Promise<Uint8Array> {
  const key = normalizePath(path);
  const hit = cache.get(key);
  if (hit) {
    return hit.slice();
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const resp = await fetch(key);
      if (!resp.ok) {
        throw new Error(`failed to fetch ${key}: ${resp.status}`);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
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
