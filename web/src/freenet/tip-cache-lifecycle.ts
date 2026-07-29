/**
 * Generation tokens so in-flight tip loads don't repopulate caches after
 * clearRepoTipCaches() runs on navigate-away.
 */

let allEpoch = 0;
const prefixEpoch = new Map<string, number>();

/** Debounced clear timers — React StrictMode remount must not abort soft-fill. */
const pendingClearTimers = new Map<string, number>();
const PENDING_CLEAR_ALL = "*";

export function bumpTipCacheEpoch(prefix?: string): void {
  if (!prefix) {
    allEpoch += 1;
    prefixEpoch.clear();
    return;
  }
  prefixEpoch.set(prefix, (prefixEpoch.get(prefix) ?? 0) + 1);
}

/**
 * Schedule tip-cache clear after leaving a repo. Cancelled if the same prefix
 * remounts immediately (StrictMode double-mount) so soft-fill / README images
 * keep the in-flight tip instead of failing against an aborted pack set.
 */
export function scheduleRepoTipCacheClear(
  prefix: string | undefined,
  clearFn: (prefix?: string) => void,
  delayMs = 400,
): () => void {
  const key = prefix?.trim() ? prefix.trim() : PENDING_CLEAR_ALL;
  const existing = pendingClearTimers.get(key);
  if (existing != null) window.clearTimeout(existing);

  const timer = window.setTimeout(() => {
    pendingClearTimers.delete(key);
    clearFn(prefix?.trim() ? prefix.trim() : undefined);
  }, delayMs);
  pendingClearTimers.set(key, timer);

  return () => {
    const t = pendingClearTimers.get(key);
    if (t != null) {
      window.clearTimeout(t);
      pendingClearTimers.delete(key);
    }
  };
}

/** Cancel a pending deferred clear when remounting the same repo. */
export function cancelScheduledRepoTipCacheClear(prefix?: string): void {
  const key = prefix?.trim() ? prefix.trim() : PENDING_CLEAR_ALL;
  const t = pendingClearTimers.get(key);
  if (t != null) {
    window.clearTimeout(t);
    pendingClearTimers.delete(key);
  }
  if (!prefix) {
    for (const [k, id] of pendingClearTimers) {
      window.clearTimeout(id);
      pendingClearTimers.delete(k);
    }
  }
}

export function tipCacheEpoch(prefix: string): number {
  return allEpoch + (prefixEpoch.get(prefix) ?? 0);
}

export function tipCacheEpochValid(prefix: string, epoch: number): boolean {
  return tipCacheEpoch(prefix) === epoch;
}

/**
 * After a successful tip Put/Update — SPA soft-refetch (do not location.assign;
 * Freenet website deep paths 404 on hard nav).
 */
export function notifyRepoTipPushed(prefix: string): void {
  const p = prefix.trim();
  if (!p) return;
  try {
    window.dispatchEvent(
      new CustomEvent("freenethub-repo-tip-pushed", {
        detail: { prefix: p },
      }),
    );
  } catch {
    /* ignore */
  }
}

export function onRepoTipPushed(
  handler: (prefix: string) => void,
): () => void {
  const fn = (ev: Event) => {
    const prefix = (ev as CustomEvent<{ prefix: string }>).detail?.prefix;
    if (prefix) handler(prefix);
  };
  window.addEventListener("freenethub-repo-tip-pushed", fn);
  return () => window.removeEventListener("freenethub-repo-tip-pushed", fn);
}
