/**
 * Generation tokens so in-flight tip loads don't repopulate caches after
 * clearRepoTipCaches() runs on navigate-away.
 */

let allEpoch = 0;
const prefixEpoch = new Map<string, number>();

export function bumpTipCacheEpoch(prefix?: string): void {
  if (!prefix) {
    allEpoch += 1;
    prefixEpoch.clear();
    return;
  }
  prefixEpoch.set(prefix, (prefixEpoch.get(prefix) ?? 0) + 1);
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
