/**
 * Repo Settings → Pin: Grant/Revoke via Freenet shell request-scope.
 * Hidden until Settings → Pin has approved the site (Layer A).
 */

import { useCallback, useEffect, useState } from "react";
import { packContractKey, repoContractKey } from "../freenet/keys";
import { fetchRepoState } from "../freenet/tip-fetch";
import { summarizeRepoState, type TipBundle } from "../tip-browse/decode-wasm";
import {
  ensureRepoScopeAndSync,
  fetchNodeFeatures,
  fetchProtectStatus,
  findScope,
  isAppGrantedFromStatus,
  isScopeActive,
  repoGrantId,
  revokeScope,
  tipPackKeysFromBundles,
  type ProtectStatus,
  type TipRetention,
} from "../freenet/local-protect";
import { repoScopePresentation } from "../freenet/protect-presentation";

export interface LocalProtectPanelProps {
  prefix: string;
  label?: string;
  userAvatarDataUrl?: string | null;
}

async function tipKeysForPrefix(
  prefix: string,
  retention: TipRetention,
): Promise<string[]> {
  try {
    const state = await fetchRepoState(prefix);
    const summary = (await summarizeRepoState(state)) as {
      tipped_bundles?: TipBundle[];
    };
    return tipPackKeysFromBundles(
      summary.tipped_bundles ?? [],
      (hash) => {
        try {
          return packContractKey(hash).encode();
        } catch {
          return String(packContractKey(hash));
        }
      },
      retention,
    );
  } catch {
    return [];
  }
}

export function LocalProtectPanel({
  prefix,
  label,
  userAvatarDataUrl,
}: LocalProtectPanelProps) {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<ProtectStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [retention, setRetention] = useState<TipRetention>("current");

  const grantId = repoGrantId(prefix);
  let repoKey = "";
  try {
    repoKey = repoContractKey(prefix).encode();
  } catch {
    repoKey = String(repoContractKey(prefix));
  }

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

  if (!available || !prefix || !repoKey) return null;

  const granted = isAppGrantedFromStatus(status);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!granted) { return (… Authorize pinning… button …); }
  // NEW CODE - TESTING: hide entire repo Pin section until Layer A
  if (!granted) return null;

  const active = isScopeActive(status, grantId);
  const scope = active ? findScope(status, grantId) : undefined;
  const repoLabel = label || prefix;

  const onGrant = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const tipKeys = await tipKeysForPrefix(prefix, retention);
      const r = await ensureRepoScopeAndSync({
        prefix,
        repoContractKey: repoKey,
        tipPackKeys: tipKeys,
        tipRetention: retention,
        presentation: repoScopePresentation(
          repoLabel,
          repoKey,
          retention,
          userAvatarDataUrl,
        ),
      });
      if (!r.ok) {
        setMsg(r.error);
        await refresh();
        return;
      }
      setMsg(
        tipKeys.length > 0
          ? `Pinned — ${tipKeys.length} tip pack(s) on this node.`
          : "Pinned — tip packs will sync when tips exist.",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await revokeScope(grantId);
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      setMsg("Pin scope revoked for this repository.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gh-repo-settings-block local-protect-panel">
      <div className="local-protect-panel-head">
        <h2 className="gh-repo-settings-section-title">Pin</h2>
        <span
          className={
            active
              ? "gh-badge backup-badge backup-badge--fresh"
              : "gh-badge backup-badge backup-badge--none"
          }
        >
          {active ? "Pinned" : "Unpinned"}
        </span>
      </div>
      <p className="muted tiny gh-repo-settings-help">
        Keep this repository’s contract and tip packs warm on this Freenet node.
        Authorize once in the Freenet shell; new tips re-sync under the same
        scope.
      </p>

      <div className="local-protect-fields">
        <label className="local-protect-field">
          <span className="gh-repo-settings-label">Tip retention</span>
          <select
            className="local-protect-select"
            value={retention}
            disabled={busy || active}
            onChange={(e) => setRetention(e.target.value as TipRetention)}
          >
            <option value="current">Latest tips only</option>
            <option value="last_n">Recent history (last 3)</option>
            <option value="all">All tipped packs</option>
          </select>
        </label>
        {active && scope ? (
          <p className="muted tiny local-protect-ledger">
            {scope.ledger?.length ?? 0} key(s) on this node
          </p>
        ) : null}
      </div>

      <div className="gh-repo-rename-controls local-protect-actions">
        {active ? (
          <button
            type="button"
            className="gh-repo-rename-btn"
            disabled={busy}
            onClick={() => void onRevoke()}
          >
            {busy ? "Working…" : "Unpin"}
          </button>
        ) : (
          <button
            type="button"
            className="gh-repo-rename-btn"
            disabled={busy}
            onClick={() => void onGrant()}
          >
            {busy ? "Waiting for Authorize…" : "Pin repository…"}
          </button>
        )}
      </div>
      {msg ? <p className="muted tiny local-protect-msg">{msg}</p> : null}
    </section>
  );
}
