/**
 * Pin status badge + kebab for Repositories / Stars list rows.
 * Menu (Pin / Unpin / Sync) only when Layer A app grant is approved.
 */

import { useCallback, useEffect, useState } from "react";
import { packContractKey, repoContractKey } from "../freenet/keys";
import { fetchRepoState } from "../freenet/tip-fetch";
import { summarizeRepoState, type TipBundle } from "../tip-browse/decode-wasm";
import {
  ensureRepoScopeAndSync,
  fetchNodeFeatures,
  fetchProtectStatus,
  isAppGrantedFromStatus,
  isScopeActive,
  repoGrantId,
  revokeScope,
  tipPackKeysFromBundles,
  type ProtectStatus,
} from "../freenet/local-protect";
import { repoScopePresentation } from "../freenet/protect-presentation";
import { syncRepoProtectAfterTipPush } from "../freenet/protect-tip-sync";

export interface RepoProtectChromeProps {
  prefix: string;
  label?: string;
  /** "own" | "star" — for future analytics only. */
  reason?: "own" | "star";
}

function encodeKey(key: { encode(): string } | string): string {
  if (typeof key === "string") return key;
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

export function RepoProtectChrome({ prefix, label }: RepoProtectChromeProps) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<ProtectStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const grantId = repoGrantId(prefix);

  const refresh = useCallback(async () => {
    const feat = await fetchNodeFeatures();
    const ok = Boolean(
      feat?.local_contract_protect ||
        feat?.capabilities?.includes("local_contract_protect"),
    );
    setAvailable(ok);
    if (!ok) {
      setStatus(null);
      return;
    }
    setStatus(await fetchProtectStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!available) return null;

  const appGranted = isAppGrantedFromStatus(status);
  const protectedOn = isScopeActive(status, grantId);

  const onGrant = async () => {
    setBusy(true);
    setErr(null);
    setOpen(false);
    try {
      const repoKey = encodeKey(repoContractKey(prefix));
      let tipKeys: string[] = [];
      try {
        const state = await fetchRepoState(prefix);
        const summary = (await summarizeRepoState(state)) as {
          tipped_bundles?: TipBundle[];
          refs?: Array<{ name: string; target: string }>;
          mirror_mode?: string | null;
        };
        tipKeys = tipPackKeysFromBundles(
          summary.tipped_bundles ?? [],
          (h) => encodeKey(packContractKey(h)),
          "current",
          3,
          {
            refTargets: (summary.refs ?? []).map((r) => r.target),
            mirrorMode: summary.mirror_mode,
          },
        );
      } catch {
        /* empty tips ok */
      }
      const r = await ensureRepoScopeAndSync({
        prefix,
        repoContractKey: repoKey,
        tipPackKeys: tipKeys,
        tipRetention: "current",
        presentation: repoScopePresentation(
          label || prefix,
          repoKey,
          "current",
        ),
      });
      if (!r.ok) setErr(r.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async () => {
    setBusy(true);
    setErr(null);
    setOpen(false);
    try {
      const r = await revokeScope(grantId);
      if (!r.ok) setErr(r.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onSync = async () => {
    setBusy(true);
    setErr(null);
    setOpen(false);
    try {
      await syncRepoProtectAfterTipPush(prefix);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const badgeClass = protectedOn
    ? "gh-badge backup-badge backup-badge--fresh"
    : "gh-badge backup-badge backup-badge--none";

  return (
    <div
      className="repo-backup-chrome"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span
        className={badgeClass}
        title={
          err ??
          (protectedOn
            ? "Pinned on this node"
            : appGranted
              ? "Not pinned — open menu to Pin"
              : "Approve pinning under Account → Pin to manage scopes")
        }
      >
        {busy ? "…" : protectedOn ? "Pinned" : "Unpinned"}
      </span>
      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING: menu always shown
      <div className="repo-backup-menu-wrap">…</div>
      */}
      {/* NEW CODE - TESTING: menu only after Layer A */}
      {appGranted ? (
        <div className="repo-backup-menu-wrap">
          <button
            type="button"
            className="repo-backup-menu-btn"
            aria-label="Pin options"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen((v) => !v)}
          >
            ☰
          </button>
          {open ? (
            <div className="repo-backup-menu" role="menu">
              {protectedOn ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void onSync()}
                  >
                    Sync tips
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void onRevoke()}
                  >
                    Unpin
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void onGrant()}
                >
                  Pin repository…
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated Alias for callers still importing backup chrome name. */
export const RepoBackupChrome = RepoProtectChrome;
export const RepoBackupControls = RepoProtectChrome;
