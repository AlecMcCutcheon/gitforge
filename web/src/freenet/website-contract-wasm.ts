/**
 * website_contract.wasm loader for Pages Puts.
 *
 * Prefer the bytes from the official freenet-core Freenet tip
 * (`crates/fdev/resources/website_contract.wasm`), then fall back to the
 * copy shipped under web/public/.
 */

import { loadPublicWasm } from "./wasm-cache";

/** Official freenet-core mirror (same as EMBEDDED_DEMOS). */
export const FREENET_CORE_PREFIX = "3GEERif5ihbf";

/** Path inside freenet-core where fdev embeds the website contract. */
export const WEBSITE_CONTRACT_WASM_TIP_PATH =
  "crates/fdev/resources/website_contract.wasm";

/** Don't block Pages enable on a heavy / legacy freenet-core tip. */
const FREENET_CORE_WASM_TIMEOUT_MS = 15_000;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;

let cachedFromNetwork: Uint8Array | null = null;

function looksLikeWasm(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function loadFromFreenetCoreTip(): Promise<Uint8Array> {
  const { loadBrowserTip } = await import("./tip-fetch");
  const { readBlobPath } = await import("../tip-browse/pack-decode");
  const tip = await loadBrowserTip(FREENET_CORE_PREFIX, "HEAD");
  const bytes = await readBlobPath(
    tip.objects,
    tip.commit,
    WEBSITE_CONTRACT_WASM_TIP_PATH,
  );
  if (!looksLikeWasm(bytes)) {
    throw new Error(
      `freenet-core tip blob at ${WEBSITE_CONTRACT_WASM_TIP_PATH} is not WASM`,
    );
  }
  return bytes;
}

/**
 * Load website_contract.wasm: Freenet freenet-core tip first, then public pack.
 */
export async function loadWebsiteContractWasm(): Promise<Uint8Array> {
  if (cachedFromNetwork) {
    return cachedFromNetwork.slice();
  }

  try {
    const fromTip = await withTimeout(
      loadFromFreenetCoreTip(),
      FREENET_CORE_WASM_TIMEOUT_MS,
      "freenet-core website_contract.wasm",
    );
    cachedFromNetwork = fromTip;
    console.info(
      `[pages] website_contract.wasm from freenet::${FREENET_CORE_PREFIX}/freenet-core (${fromTip.length} bytes)`,
    );
    return fromTip.slice();
  } catch (err) {
    console.warn(
      "[pages] freenet-core tip wasm unavailable, using packed web/public copy:",
      err instanceof Error ? err.message : err,
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return loadPublicWasm("./website_contract.wasm");
  // NEW CODE - TESTING: same packed fallback after Freenet tip miss
  return loadPublicWasm("./website_contract.wasm");
}
