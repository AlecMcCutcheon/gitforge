/**
 * Settings → Pin: Layer A capability + per-area Grant/Revoke via Freenet shell.
 * Vault remembers Layer A + scopes; restore re-mints via shell under live Layer A.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContractKey } from "@freenetorg/freenet-stdlib";
import { getSessionVaultId } from "../freenet/auth-api";
import { hubProfileKeyForFingerprint } from "../freenet/hub-profile";
import { hubVaultKeyForId } from "../freenet/hub-vault";
import {
  fetchNodeFeatures,
  fetchProtectStatus,
  grantAppCliHint,
  identityGrantId,
  isAppGrantedFromStatus,
  isScopeActive,
  requestAppGrantViaOverlay,
  requestScopeViaOverlay,
  revokeAppGrant,
  revokeScope,
  type ProtectStatus,
  type ScopePolicy,
} from "../freenet/local-protect";
import {
  identityScopePresentation,
  layerAPresentation,
} from "../freenet/protect-presentation";
import {
  compareProtectIntent,
  forgetProtectScope,
  getProtectPrefs,
  getProtectVaultIntent,
  hydrateProtectIntentFromVault,
  onProtectIntentChanged,
  onProtectPrefsChanged,
  pullProtectIntentFromVaultAsTruth,
  pushProtectIntentFromLocal,
  rememberProtectScope,
  setProtectAppGrantedIntent,
  setProtectPrefs,
  type ProtectIntentCompare,
  type ProtectPrefs,
  type ProtectVaultIntent,
  type RememberedProtectScope,
} from "../freenet/protect-prefs";
import { GITATLAS_WEBSITE_CONTRACT_KEY } from "../freenet/website-constants";

function keyId(key: ContractKey | null): string | null {
  if (!key) return null;
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

function formatIntentSummary(s: {
  appGranted: boolean;
  scopeCount: number;
  autoOwn: boolean;
  autoStars: boolean;
}): string {
  const bits = [
    s.appGranted ? "website permission" : "no website permission",
    `${s.scopeCount} scope${s.scopeCount === 1 ? "" : "s"}`,
  ];
  if (s.autoOwn || s.autoStars) {
    bits.push(
      `auto-pin: ${[
        s.autoOwn ? "repos" : null,
        s.autoStars ? "stars" : null,
      ]
        .filter(Boolean)
        .join("+")}`,
    );
  }
  return bits.join(" · ");
}

export interface IdentityProtectTarget {
  id: "profile" | "vault" | "website";
  label: string;
  help: string;
  key: string | null;
  grantId: string;
}

function buildTargets(
  fingerprint: string | null,
  vaultId: string | null,
): IdentityProtectTarget[] {
  const profileKey = fingerprint
    ? keyId(hubProfileKeyForFingerprint(fingerprint))
    : null;
  const vaultKey = vaultId ? keyId(hubVaultKeyForId(vaultId)) : null;
  return [
    {
      id: "profile",
      label: "Public profile",
      help: "Pin your Hub profile contract on this node.",
      key: profileKey,
      grantId: identityGrantId("profile"),
    },
    {
      id: "vault",
      label: "Account vault",
      help: "Pin your encrypted vault contract on this node.",
      key: vaultKey,
      grantId: identityGrantId("vault"),
    },
    {
      id: "website",
      label: "GitAtlas site files",
      help: "Pin this site’s website contract bytes locally.",
      key: GITATLAS_WEBSITE_CONTRACT_KEY,
      grantId: identityGrantId("website"),
    },
  ];
}

export interface IdentityProtectSettingsProps {
  fingerprint: string | null;
  vaultId?: string | null;
  /** Optional hub profile avatar as data URL for shell presentation. */
  userAvatarDataUrl?: string | null;
}

export function IdentityProtectSettings({
  fingerprint,
  vaultId: vaultIdProp,
  userAvatarDataUrl,
}: IdentityProtectSettingsProps) {
  const vaultId = vaultIdProp ?? getSessionVaultId();
  const targets = useMemo(
    () => buildTargets(fingerprint, vaultId),
    [fingerprint, vaultId],
  );

  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<ProtectStatus | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<ProtectPrefs>(() => getProtectPrefs());
  const [intent, setIntent] = useState<ProtectVaultIntent>(() =>
    getProtectVaultIntent(),
  );
  const [intentCompare, setIntentCompare] =
    useState<ProtectIntentCompare | null>(null);

  const refresh = useCallback(async () => {
    const feat = await fetchNodeFeatures(true);
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

  const refreshIntentCompare = useCallback(async () => {
    try {
      setIntentCompare(await compareProtectIntent());
    } catch {
      setIntentCompare(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      const r = await hydrateProtectIntentFromVault();
      setIntent(r.intent);
      setPrefs(getProtectPrefs());
      setIntentCompare(r.compare);
      if (r.autoApplied === "vault") {
        setMsg("Pin intent loaded from vault (this device had none).");
      } else if (r.autoApplied === "local_pushed") {
        setMsg("Pin intent pushed to vault (vault had none / was behind).");
      } else if (r.compare.kind === "diverged") {
        setMsg(
          "Pin intent differs between vault and this device — choose a source of truth below.",
        );
      }
    })();
  }, []);

  useEffect(() => onProtectPrefsChanged((p) => setPrefs(p)), []);
  useEffect(() => onProtectIntentChanged((i) => setIntent(i)), []);

  if (!available) {
    return (
      <p className="muted">
        This Freenet node does not advertise local contract pinning. Pin
        settings, restore, and auto-pin stay hidden here — vault may still
        hold intent for when you use a capable node.
      </p>
    );
  }

  const granted = isAppGrantedFromStatus(status);

  const missingRememberedScopes = (intent.scopes ?? []).filter(
    (s) => !isScopeActive(status, s.grant_id),
  );
  const needsRestore =
    (Boolean(intent.app_granted) && !granted) ||
    missingRememberedScopes.length > 0;

  const onUseVaultIntent = async () => {
    setBusyId("intent");
    setMsg(null);
    try {
      const next = await pullProtectIntentFromVaultAsTruth();
      setIntent(next);
      setPrefs(getProtectPrefs());
      await refreshIntentCompare();
      setMsg(
        "Using vault Pin intent on this device. Restore below to remint on this node (if needed).",
      );
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const onUseLocalIntent = async () => {
    setBusyId("intent");
    setMsg(null);
    try {
      await pushProtectIntentFromLocal();
      setIntent(getProtectVaultIntent());
      await refreshIntentCompare();
      setMsg("Pushed this device’s Pin intent to the vault.");
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const onRequestLayerA = async () => {
    setBusyId("app");
    setMsg("Check the Freenet overlay to Authorize pinning…");
    try {
      const r = await requestAppGrantViaOverlay(
        layerAPresentation(userAvatarDataUrl, fingerprint),
      );
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      setProtectAppGrantedIntent(true);
      setMsg("GitAtlas may request Pin scopes on this node.");
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const onRevokeLayerA = async () => {
    setBusyId("app");
    setMsg(null);
    try {
      const r = await revokeAppGrant();
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      // Keep vault remembered scopes; node cascade clears live pins.
      setProtectAppGrantedIntent(false);
      setMsg(
        "Website permission revoked — scopes on this node were cleared. Vault still remembers them for Restore.",
      );
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const onGrantScope = async (t: IdentityProtectTarget) => {
    if (!t.key) {
      setMsg(`${t.label} key not available yet.`);
      return;
    }
    if (!granted) {
      setMsg("Authorize pinning for this site first.");
      return;
    }
    setBusyId(t.id);
    setMsg("Check the Freenet overlay to Authorize this scope…");
    try {
      const policy: ScopePolicy = { kind: "single" };
      const r = await requestScopeViaOverlay({
        grantId: t.grantId,
        anchorKey: t.key,
        policy,
        protectAnchor: true,
        presentation: identityScopePresentation(
          t.id,
          t.key,
          userAvatarDataUrl,
          fingerprint,
        ),
      });
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      rememberProtectScope({
        grant_id: t.grantId,
        anchor_key: t.key,
        policy,
        label: t.label,
      });
      setMsg(`Pinned: ${t.label}.`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const onRevokeScope = async (t: IdentityProtectTarget) => {
    setBusyId(t.id);
    setMsg(null);
    try {
      const r = await revokeScope(t.grantId);
      if (!r.ok) {
        setMsg(r.error);
        return;
      }
      forgetProtectScope(t.grantId);
      setMsg(`Revoked: ${t.label}.`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const restoreRememberedScope = async (
    s: RememberedProtectScope,
  ): Promise<boolean> => {
    const area = targets.find((t) => t.grantId === s.grant_id);
    const label = s.label || area?.label || s.grant_id;
    const r = await requestScopeViaOverlay({
      grantId: s.grant_id,
      anchorKey: s.anchor_key,
      policy: (s.policy as ScopePolicy | undefined) ?? { kind: "single" },
      protectAnchor: true,
      presentation: area
        ? identityScopePresentation(
            area.id,
            s.anchor_key,
            userAvatarDataUrl,
            fingerprint,
          )
        : undefined,
    });
    if (!r.ok) {
      setMsg(`Restore cancelled or failed for ${label}: ${r.error}`);
      return false;
    }
    rememberProtectScope({ ...s, label });
    return true;
  };

  const onRestore = async () => {
    if (!available) {
      setMsg("This node does not support pinning — cannot remint scopes here.");
      return;
    }
    setBusyId("restore");
    setMsg("Restoring pins from vault intent…");
    try {
      if (!granted) {
        setMsg("Authorize website pinning first (Freenet overlay)…");
        const g = await requestAppGrantViaOverlay(
          layerAPresentation(userAvatarDataUrl, fingerprint),
        );
        if (!g.ok) {
          setMsg(g.error);
          return;
        }
        setProtectAppGrantedIntent(true);
        await refresh();
      }
      let okCount = 0;
      for (const s of missingRememberedScopes) {
        setMsg(`Authorize scope: ${s.label || s.grant_id}…`);
        if (await restoreRememberedScope(s)) okCount += 1;
        else break;
      }
      await refresh();
      setMsg(
        okCount > 0
          ? `Restored ${okCount} Pin scope(s) on this node.`
          : "No scopes restored.",
      );
    } finally {
      setBusyId(null);
    }
  };

  const updatePref = (patch: Partial<ProtectPrefs>) => {
    const next = setProtectPrefs({ ...prefs, ...patch });
    setPrefs(next);
    void refreshIntentCompare();
    if (patch.autoProtectOwnRepos !== undefined) {
      setMsg(
        next.autoProtectOwnRepos
          ? "On — creating a new repo will prompt to pin it (not existing ones)."
          : "Off — new repos won’t auto-prompt.",
      );
    } else if (patch.autoProtectStars !== undefined) {
      setMsg(
        next.autoProtectStars
          ? "On — future stars will prompt to pin (not existing stars)."
          : "Off — stars won’t auto-prompt.",
      );
    }
  };

  const showIntentConflict =
    intentCompare?.kind === "diverged" ||
    intentCompare?.kind === "vault_behind" ||
    intentCompare?.kind === "local_behind";

  return (
    <>
      <header className="settings-header">
        <h1>Pin</h1>
        <p className="muted">
          Local only. Authorize GitAtlas once in the Freenet shell, then grant
          each area you want kept warm on this node. Intent is sealed in your
          vault; live pins require website permission on this node.
        </p>
      </header>

      {showIntentConflict && intentCompare ? (
        <section className="settings-protect-card">
          <h2 className="settings-subheader">Vault ↔ this device</h2>
          <p className="muted tiny">
            {intentCompare.kind === "diverged"
              ? "Pin intent differs. Pick which copy is the source of truth (intent only — reminting on this node still needs Authorize)."
              : intentCompare.kind === "vault_behind"
                ? "This device has Pin intent the vault does not."
                : "The vault has Pin intent this device is missing."}
          </p>
          <ul className="settings-protect-intent-counts">
            <li>
              <strong>This device:</strong>{" "}
              {formatIntentSummary(intentCompare.localSummary)}
            </li>
            <li>
              <strong>Vault:</strong>{" "}
              {intentCompare.vaultSummary
                ? formatIntentSummary(intentCompare.vaultSummary)
                : "none"}
            </li>
          </ul>
          {(intentCompare.onlyLocal.length > 0 ||
            intentCompare.onlyVault.length > 0) && (
            <p className="muted tiny">
              {intentCompare.onlyLocal.length
                ? `Only here: ${intentCompare.onlyLocal.join(", ")}. `
                : ""}
              {intentCompare.onlyVault.length
                ? `Only vault: ${intentCompare.onlyVault.join(", ")}.`
                : ""}
            </p>
          )}
          <div className="gh-repo-rename-controls local-protect-actions">
            <button
              type="button"
              className="gh-repo-rename-btn"
              disabled={busyId !== null || !intentCompare.vault}
              onClick={() => void onUseVaultIntent()}
            >
              {busyId === "intent" ? "…" : "Use vault"}
            </button>
            <button
              type="button"
              className="gh-repo-rename-btn"
              disabled={busyId !== null}
              onClick={() => void onUseLocalIntent()}
            >
              {busyId === "intent" ? "…" : "Use this device"}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busyId !== null}
              onClick={() => void refreshIntentCompare()}
            >
              Refresh
            </button>
          </div>
        </section>
      ) : null}

      {needsRestore ? (
        <section className="settings-protect-card">
          <h2 className="settings-subheader">Restore from vault</h2>
          <p className="muted tiny">
            Your vault remembers Pin intent
            {intent.app_granted ? " (website permission" : ""}
            {(intent.scopes?.length ?? 0) > 0
              ? `${intent.app_granted ? " +" : " ("}${intent.scopes!.length} scope(s)`
              : ""}
            {intent.app_granted || (intent.scopes?.length ?? 0) > 0
              ? ")"
              : ""}
            . Restoring re-runs Freenet Authorize — Layer A first, then each
            missing scope. Scopes are only valid while website permission is
            granted on this node.
          </p>
          <button
            type="button"
            className="gh-repo-rename-btn"
            disabled={busyId !== null}
            onClick={() => void onRestore()}
          >
            {busyId === "restore" ? "Restoring…" : "Restore pins…"}
          </button>
        </section>
      ) : null}

      <section className="settings-protect-card">
        <h2 className="settings-subheader">Website permission</h2>
        <p className="muted tiny">
          Lets GitAtlas ask for Pin scopes. Does not pin any contracts by
          itself. Revoking clears scopes on this node; vault keeps the list for
          Restore.
        </p>
        {granted ? (
          <button
            type="button"
            className="gh-repo-rename-btn"
            disabled={busyId !== null}
            onClick={() => void onRevokeLayerA()}
          >
            {busyId === "app" ? "Working…" : "Revoke permission"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="gh-repo-rename-btn"
              disabled={busyId !== null}
              onClick={() => void onRequestLayerA()}
            >
              {busyId === "app"
                ? "Waiting for Authorize…"
                : "Authorize pinning…"}
            </button>
            <p className="muted tiny settings-protect-cli">
              CLI: <code className="mono">{grantAppCliHint()}</code>
            </p>
          </>
        )}
      </section>

      {!granted ? (
        <p className="muted tiny settings-protect-gate-note">
          Repository Pin controls and auto-pin prefs appear after you
          authorize the website.
        </p>
      ) : (
        <>
          <section className="settings-protect-card">
            <h2 className="settings-subheader">Auto-pin</h2>
            <p className="muted tiny">
              Applies only to <strong>new</strong> creates and stars after you
              enable it — not retroactive on repositories or stars you already
              have. Pin those from the repo list or repo settings.
            </p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={prefs.autoProtectOwnRepos}
                onChange={(e) =>
                  updatePref({ autoProtectOwnRepos: e.target.checked })
                }
              />
              <span>
                <strong>My repositories</strong>
                <span className="muted tiny block">
                  After creating a <em>new</em> repo, prompt once to pin its
                  scope.
                </span>
              </span>
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={prefs.autoProtectStars}
                onChange={(e) =>
                  updatePref({ autoProtectStars: e.target.checked })
                }
              />
              <span>
                <strong>Stars</strong>
                <span className="muted tiny block">
                  After starring a repo <em>going forward</em>, prompt once to
                  pin it.
                </span>
              </span>
            </label>
          </section>

          <section className="settings-protect-card">
            <h2 className="settings-subheader">Identity scopes</h2>
            <ul className="settings-protect-scope-list">
              {targets.map((t) => {
                const on = isScopeActive(status, t.grantId);
                const busy = busyId === t.id;
                return (
                  <li key={t.id} className="settings-protect-scope-row">
                    <div className="settings-protect-scope-copy">
                      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                      <strong>{t.label}</strong>
                      <span className="muted tiny block">{t.help}</span>
                      */}
                      {/* NEW CODE - TESTING: title + help stacked (not inline) */}
                      <strong className="settings-protect-scope-title">
                        {t.label}
                      </strong>
                      <span className="muted tiny block">{t.help}</span>
                      {!t.key ? (
                        <span className="muted tiny block">
                          Key not ready (sign in / open vault first).
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="gh-repo-rename-btn"
                      disabled={
                        on
                          ? busy || busyId !== null
                          : !t.key || busyId !== null
                      }
                      onClick={() =>
                        void (on ? onRevokeScope(t) : onGrantScope(t))
                      }
                    >
                      {busy ? "…" : on ? "Unpin" : "Pin…"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {msg ? (
        <p className="muted tiny settings-protect-msg">
          {msg}
        </p>
      ) : null}
    </>
  );
}

export function useLocalProtectAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const feat = await fetchNodeFeatures();
      if (cancelled) return;
      setAvailable(
        Boolean(
          feat?.local_contract_protect ||
            feat?.capabilities?.includes("local_contract_protect"),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}
