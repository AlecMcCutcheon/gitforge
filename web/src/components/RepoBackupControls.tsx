/**
 * Backup status badge + kebab menu for Stars / Repositories list rows.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  clearRepoBackup,
  getBackupStatus,
  onBackupStatusChanged,
  pinRepoBackup,
  rehydrateBackupBlobs,
  repairIncompleteBackup,
  syncRepoBackup,
  type BackupFreshness,
  type BackupReason,
  type BackupStatus,
} from "../freenet/repo-backup";
import { summarizeRepoState } from "../tip-browse/decode-wasm";
import type { TipBundle } from "../tip-browse/decode-wasm";
import { fetchRepoState } from "../freenet/tip-fetch";
import { rescueRepo } from "../freenet/repo-health";
import { backupGetPin } from "../freenet/repo-backup-store";

export interface RepoBackupChromeProps {
  prefix: string;
  reason: BackupReason;
  registered?: boolean;
}

function badgeClass(f: BackupFreshness, busy: boolean): string {
  if (busy) return "gh-badge backup-badge backup-badge--busy";
  switch (f) {
    case "fresh":
      return "gh-badge backup-badge backup-badge--fresh";
    case "stale":
      return "gh-badge backup-badge backup-badge--stale";
    case "incomplete":
      return "gh-badge backup-badge backup-badge--incomplete";
    case "none":
      return "gh-badge backup-badge backup-badge--none";
    default:
      return "gh-badge backup-badge backup-badge--unknown";
  }
}

function badgeLabel(f: BackupFreshness, busy: string | null): string {
  if (busy === "pin" || busy === "sync") return "Updating";
  if (busy === "rescue") return "Rescuing";
  if (busy === "load") return "…";
  if (busy === "clear") return "Clearing";
  switch (f) {
    case "fresh":
      return "Up to date";
    case "stale":
      return "Out of date";
    case "incomplete":
      return "Incomplete";
    case "none":
      return "No backup";
    default:
      return "Unknown";
  }
}

function formatLastChecked(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "Never checked";
  try {
    return `Last checked ${new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  } catch {
    return `Last checked ${new Date(ts).toISOString()}`;
  }
}

export function RepoBackupChrome({
  prefix,
  reason,
  registered = false,
}: RepoBackupChromeProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<
    "load" | "pin" | "sync" | "rescue" | "clear" | null
  >(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy("load");
    setErr(null);
    try {
      setStatus(await getBackupStatus(prefix));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [prefix]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return onBackupStatusChanged((changed) => {
      if (changed && changed !== prefix) return;
      void getBackupStatus(prefix)
        .then(setStatus)
        .catch(() => {
          /* ignore */
        });
    });
  }, [prefix]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const freshness = status?.freshness ?? "none";
  const hasPin = Boolean(status?.pin && status.reasons.length > 0);
  const busyKey = busy && busy !== "load" ? busy : null;

  const onBackup = async () => {
    setOpen(false);
    setBusy("pin");
    setErr(null);
    try {
      await pinRepoBackup(prefix, reason);
      setStatus(await getBackupStatus(prefix));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onUpdate = async () => {
    setOpen(false);
    setBusy("sync");
    setErr(null);
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // setStatus(await syncRepoBackup(prefix, { reason }));
      // NEW CODE - TESTING: incomplete pins repair missing tip pack bytes first
      if (status?.freshness === "incomplete") {
        setStatus(await repairIncompleteBackup(prefix));
      } else {
        setStatus(await syncRepoBackup(prefix, { reason }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onRescue = async () => {
    setOpen(false);
    setBusy("rescue");
    setErr(null);
    try {
      const pin = await backupGetPin(prefix);
      const rehyd = await rehydrateBackupBlobs(prefix);
      let bundles: TipBundle[] =
        pin?.tipBundles && pin.tipBundles.length > 0 ? pin.tipBundles : [];
      if (bundles.length === 0) {
        const state = await fetchRepoState(prefix);
        const summary = (await summarizeRepoState(state)) as {
          tipped_bundles?: TipBundle[];
        };
        bundles = summary.tipped_bundles ?? [];
      }
      const rescued = await rescueRepo(prefix, bundles, {
        onlyMissing: false,
        expectRegistered: registered,
      });
      setStatus(await getBackupStatus(prefix));
      if (rescued.packs.putCount === 0) {
        const hint =
          rehyd.missing > 0 && rehyd.restored === 0
            ? " Backup tip packs were missing on this identity — run Repair / Backup again while tip packs are reachable on Freenet."
            : "";
        setErr(`${rescued.message}${hint}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onClear = async () => {
    setOpen(false);
    setBusy("clear");
    setErr(null);
    try {
      await clearRepoBackup(prefix);
      setStatus(await getBackupStatus(prefix));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="repo-backup-chrome"
      ref={rootRef}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span
        className={badgeClass(freshness, Boolean(busyKey))}
        title={
          err ??
          (freshness === "incomplete"
            ? `Incomplete backup: ${status?.blobBytesMissing ?? "?"} tip pack(s) missing durable bytes. ${formatLastChecked(status?.lastCheckedAt)}`
            : formatLastChecked(status?.lastCheckedAt))
        }
      >
        {badgeLabel(freshness, busy)}
      </span>
      <div className="repo-backup-menu-wrap">
        <button
          type="button"
          className="repo-backup-menu-btn"
          aria-label="Backup options"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={busy !== null && busy !== "load"}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {open ? (
          <ul id={menuId} role="menu" className="repo-backup-menu">
            <li className="repo-backup-menu-header" role="presentation">
              {formatLastChecked(status?.lastCheckedAt)}
            </li>
            {!hasPin ? (
              <li role="none">
                <button type="button" role="menuitem" onClick={() => void onBackup()}>
                  Backup
                </button>
              </li>
            ) : null}
            {hasPin ? (
              <li role="none">
                <button type="button" role="menuitem" onClick={() => void onUpdate()}>
                  {freshness === "incomplete"
                    ? "Repair incomplete backup"
                    : "Update this backup"}
                </button>
              </li>
            ) : null}
            {hasPin ? (
              <li role="none">
                <button type="button" role="menuitem" onClick={() => void onRescue()}>
                  Rescue from backup
                </button>
              </li>
            ) : null}
            {hasPin ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="repo-backup-menu-danger"
                  onClick={() => void onClear()}
                >
                  Clear this backup
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {err ? (
        <span className="error tiny repo-backup-err" title={err}>
          !
        </span>
      ) : null}
    </div>
  );
}

/** @deprecated use RepoBackupChrome */
export function RepoBackupControls(props: RepoBackupChromeProps) {
  return <RepoBackupChrome {...props} />;
}

/** @deprecated Auto-sync lives in Settings → Backups + RepoBackupWorker. */
export function RepoBackupAutoSyncBar(_props: {
  prefixes: string[];
  ensureReason?: BackupReason;
  enabled: boolean;
}) {
  return null;
}
