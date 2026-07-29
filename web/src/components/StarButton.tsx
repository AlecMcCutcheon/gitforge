import { useEffect, useState } from "react";
import {
  loadStarsCached,
  peekCachedStars,
} from "../freenet/discover-cache";
import {
  fetchHubStars,
  isStarredBy,
  starCountForRepo,
  starRepo,
  unstarRepo,
} from "../freenet/hub-stars";
import { getCachedIdentity } from "../freenet/auth-api";
import { nativeGetIdentity } from "../freenet/owner-api";
import { isBrowserNativeMode } from "../tip-browse";

export function StarButton({
  prefix,
  label,
  registered = false,
}: {
  prefix: string;
  label: string;
  /** HubRegistry listing — starring disabled when false. Defaults off until known. */
  registered?: boolean;
}) {
  const websiteMode = isBrowserNativeMode();
  const [count, setCount] = useState(0);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const refresh = async () => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Always hit HubStars on mount — raced tip-pack parent walks on the WS queue.
    // NEW CODE - TESTING: paint from cache; background refresh is low-priority soft GET
    const warm = peekCachedStars();
    if (warm) {
      setCount(starCountForRepo(warm, prefix));
      const fp = getCachedIdentity()?.fingerprint ?? null;
      setFingerprint(fp);
      setStarred(fp ? isStarredBy(warm, prefix, fp) : false);
    }
    const [state, id] = await Promise.all([
      loadStarsCached(() => fetchHubStars()),
      websiteMode ? nativeGetIdentity().catch(() => null) : Promise.resolve(null),
    ]);
    setCount(starCountForRepo(state, prefix));
    const fp = id?.fingerprint ?? getCachedIdentity()?.fingerprint ?? null;
    setFingerprint(fp);
    setStarred(fp ? isStarredBy(state, prefix, fp) : false);
  };

  useEffect(() => {
    let cancelled = false;
    void refresh().catch(() => {
      if (!cancelled) {
        setCount(0);
        setStarred(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [prefix, websiteMode]);

  if (!websiteMode) return null;

  const loggedIn = Boolean(fingerprint);
  const canStar = loggedIn && registered;
  const readonlyTitle = !registered
    ? "Register this repo on Hub to enable starring"
    : !loggedIn
      ? "Sign in to star"
      : undefined;

  const toggle = async () => {
    if (!canStar) return;
    setBusy(true);
    setError(null);
    try {
      if (starred) {
        await unstarRepo(prefix);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // void import("../freenet/repo-backup").then((m) => m.unpinBackupReason(...))
      } else {
        await starRepo(prefix, label);
        // Auto-protect stars: one Freenet shell scope prompt if prefs + capability
        void (async () => {
          try {
            const { getProtectPrefs } = await import("../freenet/protect-prefs");
            if (!getProtectPrefs().autoProtectStars) return;
            const { hasLocalProtectCapability, isAppGranted, findScope, fetchProtectStatus, repoGrantId, ensureRepoScopeAndSync } =
              await import("../freenet/local-protect");
            if (!(await hasLocalProtectCapability())) return;
            if (!(await isAppGranted())) return;
            const status = await fetchProtectStatus();
            if (findScope(status, repoGrantId(prefix))) return;
            const { repoContractKey } = await import("../freenet/keys");
            const { repoScopePresentation } = await import(
              "../freenet/protect-presentation"
            );
            let repoKey = "";
            try {
              repoKey = repoContractKey(prefix).encode();
            } catch {
              repoKey = String(repoContractKey(prefix));
            }
            await ensureRepoScopeAndSync({
              prefix,
              repoContractKey: repoKey,
              tipPackKeys: [],
              tipRetention: "current",
              presentation: repoScopePresentation(label || prefix, repoKey, "current"),
            });
          } catch (err: unknown) {
            console.warn(
              "[freenet-hub] star protect prompt failed",
              err instanceof Error ? err.message : err,
            );
          }
        })();
      }
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="star-controls">
      <button
        type="button"
        className={`btn secondary star-btn ${starred && canStar ? "starred" : ""} ${
          canStar ? "" : "star-btn-readonly"
        }`}
        disabled={busy || !canStar}
        onClick={() => void toggle()}
        title={readonlyTitle}
        aria-disabled={!canStar}
      >
        {starred && canStar ? "★ Starred" : "☆ Star"} · {count}
      </button>
      {error ? <span className="tiny error-inline">{error}</span> : null}
    </div>
  );
}

/** Discover card star count badge. */
export function StarCountBadge({ prefix }: { prefix: string }) {
  const [count, setCount] = useState<number | null>(() => {
    const cached = peekCachedStars();
    return cached ? starCountForRepo(cached, prefix) : null;
  });

  useEffect(() => {
    let cancelled = false;
    void loadStarsCached(() => fetchHubStars())
      .then((state) => {
        if (!cancelled) setCount(starCountForRepo(state, prefix));
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  if (count == null || count === 0) return null;
  return <span className="star-count-badge">★ {count}</span>;
}
