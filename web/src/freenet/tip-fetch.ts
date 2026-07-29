import { blake3 } from "@noble/hashes/blake3";
import { ensureBrowserTip } from "../tip-browse/browser-api";
import {
  TIP_LOAD_DEADLINE_MS,
  tipLoadDeadlineError,
} from "./contract-fetch-status";
import { bytesToHex, packContractKey, repoContractKey } from "./keys";
import { abortContractGets, getContractState } from "./ws";
import {
  tipCacheEpoch,
  tipCacheEpochValid,
} from "./tip-cache-lifecycle";

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export async function fetchRepoState(prefix: string): Promise<Uint8Array> {
//   return getContractState(repoContractKey(prefix));
// }
// NEW CODE - TESTING: dedupe concurrent + back-to-back repo GETs (nativeRepo + tip)
const repoStateCache = new Map<string, Uint8Array>();
const repoStateInflight = new Map<string, Promise<Uint8Array>>();

export async function fetchRepoState(prefix: string): Promise<Uint8Array> {
  const hit = repoStateCache.get(prefix);
  if (hit) return hit;
  const pending = repoStateInflight.get(prefix);
  if (pending) return pending;
  const epoch = tipCacheEpoch(prefix);
  const p = getContractState(repoContractKey(prefix), {
    priority: "high",
    scope: prefix,
  })
    .then((bytes) => {
      if (tipCacheEpochValid(prefix, epoch)) {
        repoStateCache.set(prefix, bytes);
      }
      return bytes;
    })
    .finally(() => {
      repoStateInflight.delete(prefix);
    });
  repoStateInflight.set(prefix, p);
  return p;
}

/** Drop cached RepoState bytes (all prefixes, or one). */
export function clearRepoStateCache(prefix?: string): void {
  if (!prefix) {
    repoStateCache.clear();
    repoStateInflight.clear();
    return;
  }
  repoStateCache.delete(prefix);
  repoStateInflight.delete(prefix);
}

export async function fetchPackByHash(
  hashHex: string,
  scope?: string,
  opts?: {
    maxAttempts?: number;
    timeoutMs?: number;
    /** Soft-fill / background — must not starve health + UI soft GETs. */
    priority?: "high" | "low";
  },
): Promise<Uint8Array> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const bytes = await getContractState(packContractKey(hashHex), {
  //   priority: "high",
  //   scope,
  // });
  // NEW CODE - TESTING: soft-fill uses low priority so health/hub soft-GETs can run
  const bytes = await getContractState(packContractKey(hashHex), {
    priority: opts?.priority ?? "high",
    scope,
    maxAttempts: opts?.maxAttempts,
    timeoutMs: opts?.timeoutMs,
  });
  const digest = blake3(bytes);
  const got = bytesToHex(digest);
  const want = hashHex.trim().toLowerCase();
  if (got !== want) {
    throw new Error(
      `pack BLAKE3 mismatch: got ${got}, expected ${want} (poisoned/wrong contract)`,
    );
  }
  return bytes;
}

export type TipHandle = Awaited<ReturnType<typeof ensureBrowserTip>>;

export async function loadBrowserTip(
  prefix: string,
  gitRef: string,
): Promise<TipHandle> {
  const epoch = tipCacheEpoch(prefix);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // no overall deadline — silent skeleton while 3×12s pack retries stacked
  // NEW CODE - TESTING: Freenet-aligned deadline; abort GETs so UI can error out
  const work = (async (): Promise<TipHandle> => {
    const repoStateBytes = await fetchRepoState(prefix);
    if (!tipCacheEpochValid(prefix, epoch)) {
      throw new Error("tip load cancelled (left repo)");
    }
    return ensureBrowserTip({
      prefix,
      gitRef,
      repoStateBytes,
      // Tag pack GETs with repo prefix so leave-page abortContractGets drops them.
      // Soft-fill uses { soft: true } → low priority + 1×8s (does not starve health).
      fetchPackByHash: (hashHex, fetchOpts) =>
        fetchPackByHash(hashHex, prefix, {
          maxAttempts: fetchOpts?.soft ? 1 : undefined,
          timeoutMs: fetchOpts?.soft ? 8_000 : undefined,
          priority: fetchOpts?.soft ? "low" : "high",
        }),
      cacheEpoch: epoch,
    });
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        abortContractGets(prefix);
      } catch {
        /* ignore */
      }
      reject(tipLoadDeadlineError(prefix));
    }, TIP_LOAD_DEADLINE_MS);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
