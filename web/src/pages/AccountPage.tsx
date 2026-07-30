import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Link } from "../spa-link";
import {
  compareVaultAndDelegate,
  createIdentity,
  currentIdentity,
  downloadBytesFile,
  ensureSessionVaultId,
  ensureSignedInAccountVault,
  exportFreenetGitCliBundle,
  getCachedIdentity,
  getCachedProfile,
  getSessionVaultId,
  importFreenetGitIdentityBundle,
  listVaultApiKeys,
  loadPublicProfile,
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // logoutAccount,
  // NEW CODE - TESTING: confirm when identity-delegate backups would be wiped
  confirmAndLogoutAccount,
  mergeFreenetGitIdentityBundle,
  mintVaultApiKey,
  onAuthSessionChange,
  probeVaultBackupEnabled,
  pullVaultReposToDelegate,
  pushDelegateReposToVault,
  revealSessionRecoveryPhrase,
  restoreFromRecoveryPhrase,
  revokeVaultApiKey,
  updatePublicProfile,
  type VaultDelegateSyncStatus,
} from "../freenet/auth-api";
import {
  ENVELOPE_PAGES,
  ENVELOPE_REPOS,
  ENVELOPE_SETTINGS,
  type VaultApiKeyScope,
  type VaultApiKeyWrap,
} from "../freenet/vault-crypto";
import {
  defaultContactFromFingerprint,
  fingerprintWords,
} from "../freenet/fingerprint-words";
import type { ForgeIdentityInfo } from "../freenet/owner-api";
import { ProfileAvatar } from "../components/ProfileAvatar";
import { BrandLogo } from "../components/BrandLogo";
import { FlashNotice } from "../components/FlashNotice";
import { BusyLabel, OperationStatus } from "../components/OperationStatus";
import { AccountHealthBlock } from "../components/AccountHealthBlock";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { PassphraseReveal } from "../components/PassphraseReveal";
import { VaultSyncPanel } from "../components/VaultSyncPanel";
import {
  defaultBusyLabel,
  type BusyScenario,
} from "../lib/busy-copy";
import {
  normalizeProfileAvatar,
  resizeImageToDataUrl,
} from "../lib/avatar-image";
import { brand } from "../lib/brand";
import { isBrowserNativeMode } from "../tip-browse";
import { useDocumentTitle } from "../lib/document-title";
import {
  IdentityProtectSettings,
  useLocalProtectAvailable,
} from "../components/IdentityProtectSettings";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import {
//   getBackupPrefs,
//   hydrateBackupPrefsFromIdentity,
//   onBackupPrefsChange,
//   setBackupPrefs,
//   type BackupPrefs,
// } from "../freenet/repo-backup";

type AuthView =
  | "hub"
  | "create"
  | "backup"
  | "restore";
type SettingsSection =
  | "profile"
  | "account"
  | "backups"
  | "vault"
  | "export"
  | "api-keys"
  | "local-protect";

/** Stable shell — must stay outside AccountPage or inputs remount on each keystroke. */
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <Link to="/" className="auth-brand-mark">
          <BrandLogo size={40} className="brand-logo" />
          {brand.displayName}
        </Link>
      </div>
      {children}
    </main>
  );
}

export function AccountPage() {
  const websiteMode = isBrowserNativeMode();
  const localProtectAvailable = useLocalProtectAvailable();
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<AuthView>(() => {
    if (searchParams.get("create") === "1") return "create";
    if (searchParams.get("restore") === "1") return "restore";
    return "hub";
  });
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("profile");
  const [identity, setIdentity] = useState<ForgeIdentityInfo | null>(() =>
    getCachedIdentity(),
  );
  const [sessionReady, setSessionReady] = useState(false);
  const accountTitle = useMemo(() => {
    if (!sessionReady) return "Account";
    if (identity) {
      switch (settingsSection) {
        case "profile":
          return "Public profile";
        case "account":
          return "Account settings";
        case "backups":
          return "Backups";
        case "local-protect":
          return "Pin";
        case "vault":
          return "Sync";
        case "export":
          return "Downloads";
        case "api-keys":
          return "API keys";
        default:
          return "Settings";
      }
    }
    switch (view) {
      case "create":
        return "Create identity";
      case "restore":
        return "Restore identity";
      case "backup":
        return "Save your identity bundle";
      default:
        return "Sign in";
    }
  }, [sessionReady, identity, settingsSection, view]);
  useDocumentTitle(accountTitle);
  const [vaultId, setVaultId] = useState(getSessionVaultId() ?? "");
  const [username, setUsername] = useState(
    () => searchParams.get("username")?.trim() ?? "",
  );
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // password / TOTP unlock state removed (passwordless vault)
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [pendingBundle, setPendingBundle] = useState<IdentityExportBundle | null>(null);
  // const [recoveryPhrase, setRecoveryPhrase] = useState("");
  // const [showRecoveryOnce, setShowRecoveryOnce] = useState(false);
  // const [recoveryAck, setRecoveryAck] = useState(false);
  // NEW CODE - TESTING: freenet-git identity.bundle is the create backup
  const [pendingGitBundle, setPendingGitBundle] = useState<{
    bytes: Uint8Array;
    filename: string;
    passphrase: string;
    fingerprint: string;
  } | null>(null);
  const [fingerprintWordList, setFingerprintWordList] = useState<string[]>([]);
  const [backupTaken, setBackupTaken] = useState(false);
  const [backupConfirm, setBackupConfirm] = useState(false);
  const [passphraseAck, setPassphraseAck] = useState(false);
  const [bundleFile, setBundleFile] = useState<Uint8Array | null>(null);
  const [bundleFileName, setBundleFileName] = useState("");
  const [bundlePassphrase, setBundlePassphrase] = useState("");
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // restore showed bundle + phrase fields together (+ optional username)
  // NEW CODE - TESTING: tabbed restore methods
  const [restoreTab, setRestoreTab] = useState<"bundle" | "phrase">("bundle");
  const [cliExport, setCliExport] = useState<{
    filename: string;
    passphrase: string;
  } | null>(null);
  const [vaultBackupEnabled, setVaultBackupEnabled] = useState(false);
  // NEW CODE - TESTING: auto re-ensure vault if missing after reload / failed Put
  const [vaultEnsureBusy, setVaultEnsureBusy] = useState(false);
  const [vaultEnsureStep, setVaultEnsureStep] = useState<string | null>(null);
  const [vaultEnsureError, setVaultEnsureError] = useState<string | null>(null);
  const [showFingerprintWords, setShowFingerprintWords] = useState(false);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [backupPrefs, setBackupPrefsState] = useState<BackupPrefs>(() =>
  //   getBackupPrefs(),
  // );
  const [revealPhrase, setRevealPhrase] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  // NEW CODE - TESTING: same-identity CLI bundle merge while signed in
  const [mergeFile, setMergeFile] = useState<Uint8Array | null>(null);
  const [mergeFileName, setMergeFileName] = useState("");
  const [mergePassphrase, setMergePassphrase] = useState("");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [mergeVaultPassword, setMergeVaultPassword] = useState("");
  // const [mergeTotp, setMergeTotp] = useState("");
  // NEW CODE - TESTING: vault API keys
  const [apiKeys, setApiKeys] = useState<VaultApiKeyWrap[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  // NEW CODE - TESTING: mintable envelope scopes (repos / pages / settings)
  const [mintScopes, setMintScopes] = useState<VaultApiKeyScope[]>([
    ENVELOPE_REPOS,
  ]);
  const [mintedApiKey, setMintedApiKey] = useState<string | null>(null);
  const [mintedVaultId, setMintedVaultId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const toggleMintScope = (scope: VaultApiKeyScope, on: boolean) => {
    setMintScopes((prev) => {
      if (on) return prev.includes(scope) ? prev : [...prev, scope];
      return prev.filter((s) => s !== scope);
    });
  };
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [syncPassword, setSyncPassword] = useState("");
  // const [syncTotp, setSyncTotp] = useState("");
  // NEW CODE - TESTING: vault ↔ delegate sync (identity-unwrapped, no password)
  const [syncStatus, setSyncStatus] = useState<VaultDelegateSyncStatus | null>(
    null,
  );
  const [syncBusy, setSyncBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyScenario, setBusyScenario] = useState<BusyScenario>("generic");
  const [opStep, setOpStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // needsTotpEnroll removed with passwordless vault
  const cached = getCachedProfile();
  const [profileName, setProfileName] = useState(
    () => getCachedIdentity()?.name ?? "",
  );
  const [profileEmail, setProfileEmail] = useState(
    () => cached?.public_email ?? getCachedIdentity()?.email ?? "",
  );
  const [bio, setBio] = useState(() => cached?.bio ?? "");
  const [profileUrl, setProfileUrl] = useState(() => cached?.url ?? "");
  const [avatar, setAvatar] = useState(() =>
    normalizeProfileAvatar(cached?.avatar),
  );
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [statusText, setStatusText] = useState("");
  // const [statusEmoji, setStatusEmoji] = useState("");
  // const [pinnedPrefixes, setPinnedPrefixes] = useState("");
  // const [profilePassword, setProfilePassword] = useState("");
  // const [profileTotp, setProfileTotp] = useState("");

  const refresh = async () => {
    const prior = getCachedIdentity();
    const id = await currentIdentity();
    if (!id && prior) {
      setIdentity(prior);
      const sid = getSessionVaultId();
      if (sid) setVaultId(sid);
      return;
    }
    setIdentity(id);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // setNeedsTotpEnroll(getVaultNeedsTotpEnroll());
    if (id) {
      setProfileName(id.name);
      setProfileEmail(id.email || getCachedProfile()?.public_email || "");
      const sid = (await ensureSessionVaultId()) ?? getSessionVaultId();
      if (sid) {
        setVaultId(sid);
        const [profile, enabled] = await Promise.all([
          loadPublicProfile(id.fingerprint).catch(() => null),
          probeVaultBackupEnabled(sid),
        ]);
        setVaultBackupEnabled(enabled);
        if (profile) {
          setBio(profile.bio);
          setProfileUrl(profile.url);
          setAvatar(normalizeProfileAvatar(profile.avatar));
          if (profile.public_email) setProfileEmail(profile.public_email);
          if (profile.username) setProfileName(profile.username);
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // setStatusText(profile.statusText ?? "");
          // setStatusEmoji(profile.statusEmoji ?? "");
          // setPinnedPrefixes((profile.pinnedPrefixes ?? []).join(", "));
        }
      } else {
        setVaultBackupEnabled(false);
        const profile = await loadPublicProfile(id.fingerprint).catch(
          () => null,
        );
        if (profile) {
          setBio(profile.bio);
          setProfileUrl(profile.url);
          setAvatar(normalizeProfileAvatar(profile.avatar));
          if (profile.public_email) setProfileEmail(profile.public_email);
          if (profile.username) setProfileName(profile.username);
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // setStatusText(profile.statusText ?? "");
          // setStatusEmoji(profile.statusEmoji ?? "");
          // setPinnedPrefixes((profile.pinnedPrefixes ?? []).join(", "));
        }
      }
    } else {
      const sid = getSessionVaultId();
      if (sid) setVaultId(sid);
    }
  };

  useEffect(() => {
    if (!websiteMode) {
      setSessionReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled && !getCachedIdentity()) {
          await new Promise((r) => setTimeout(r, 400));
          if (!cancelled) await refresh();
        }
      } catch {
        if (!cancelled) setIdentity(getCachedIdentity());
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    const unsub = onAuthSessionChange(() => {
      if (cancelled) return;
      const sid = getSessionVaultId();
      if (sid) setVaultId(sid);
      const cachedId = getCachedIdentity();
      if (cachedId) setIdentity(cachedId);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [websiteMode]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // useEffect(() => {
  //   setBackupPrefsState(getBackupPrefs());
  //   void hydrateBackupPrefsFromIdentity().then((p) => {
  //     setBackupPrefsState(p);
  //   });
  //   return onBackupPrefsChange((p) => setBackupPrefsState(p));
  // }, []);

  // NEW CODE - TESTING: if signed in but vault ciphertext missing, re-ensure with UI
  useEffect(() => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (!websiteMode || !sessionReady || !identity || vaultBackupEnabled) return;
    // NEW CODE - TESTING: clear ensure UI as soon as vault is ready (incl. cancel race)
    if (vaultBackupEnabled) {
      setVaultEnsureBusy(false);
      setVaultEnsureStep(null);
      setVaultEnsureError(null);
      return;
    }
    if (!websiteMode || !sessionReady || !identity) {
      return;
    }
    // Create/restore forms manage their own ensure; retry here after hub/backup
    if (view !== "hub" && view !== "backup") return;
    let cancelled = false;
    setVaultEnsureBusy(true);
    setVaultEnsureError(null);
    setVaultEnsureStep(null);
    void ensureSignedInAccountVault({
      onStatus: (msg) => {
        if (!cancelled) setVaultEnsureStep(msg);
      },
    })
      .then((result) => {
        if (cancelled) return;
        setVaultBackupEnabled(result.vaultEnabled);
        if (!result.vaultEnabled) {
          setVaultEnsureError(
            result.error ??
              "Account vault is not on Freenet yet. Retry — Sync and API keys need it.",
          );
        } else {
          setVaultEnsureError(null);
          setVaultEnsureStep(null);
          if (view === "hub") {
            setNote("Identity ready. Account vault is on Freenet.");
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setVaultEnsureError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // if (!cancelled) setVaultEnsureBusy(false);
        // NEW CODE - TESTING: always drop busy so cancel-on-success can't stick
        setVaultEnsureBusy(false);
        if (!cancelled) setVaultEnsureStep(null);
      });
    return () => {
      cancelled = true;
    };
  }, [websiteMode, sessionReady, identity, vaultBackupEnabled, view]);

  // NEW CODE - TESTING: auto vault↔node sync status when viewing Account vault
  useEffect(() => {
    if (settingsSection !== "vault" || !vaultBackupEnabled || !identity) {
      return;
    }
    let cancelled = false;
    setSyncBusy(true);
    void compareVaultAndDelegate()
      .then((status) => {
        if (!cancelled) setSyncStatus(status);
      })
      .catch((e) => {
        if (!cancelled) {
          setSyncStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setSyncBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsSection, vaultBackupEnabled, identity]);

  if (!websiteMode) {
    return (
      <main className="page">
        <section className="panel">
          <h1>Account</h1>
          <p className="muted">
            Identity login runs on the Freenet-hosted website (native WS mode).
            Use freenet-git CLI identity tools for local bridge workflows.
          </p>
        </section>
      </main>
    );
  }

  if (!sessionReady && !identity) {
    return (
      <main className="auth-page">
        <div className="auth-brand">
          <Link to="/" className="auth-brand-mark">
            <BrandLogo size={40} className="brand-logo" />
            {brand.displayName}
          </Link>
        </div>
        <PageLoadingOverlay skeleton="auth" message="" />
      </main>
    );
  }

  const run = async (
    fn: () => Promise<void>,
    opts?: { scenario?: BusyScenario; skipRefresh?: boolean },
  ) => {
    setBusy(true);
    setBusyScenario(opts?.scenario ?? "generic");
    setOpStep(null);
    setError(null);
    setNote(null);
    try {
      await fn();
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // await refresh();
      // NEW CODE - TESTING: create skips refresh-under-busy (backup UI was stuck)
      if (!opts?.skipRefresh) await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setOpStep(null);
    }
  };

  const switchView = (next: AuthView) => {
    setView(next);
    setError(null);
    setNote(null);
  };

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    void run(
      async () => {
      const result = await createIdentity({
        username,
        onStatus: setOpStep,
      });
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // setPendingBundle(result.bundle); … recovery_phrase …
      // NEW CODE - TESTING: freenet-git identity.bundle as create backup
      setPendingGitBundle({
        ...result.git_bundle,
        fingerprint: result.identity.fingerprint,
      });
      setFingerprintWordList(result.fingerprint_words);
      setProfileEmail(result.identity.email);
      setVaultId(result.vault_id);
      setVaultBackupEnabled(false);
      setBackupTaken(false);
      setBackupConfirm(false);
      setPassphraseAck(false);
      // NEW CODE - TESTING: paint signed-in without holding busy through refresh()
      setIdentity(result.identity);
      setView("backup");
    },
      { scenario: "create", skipRefresh: true },
    );
  };

  const onDownloadBackup = () => {
    if (!pendingGitBundle) return;
    downloadBytesFile(pendingGitBundle.filename, pendingGitBundle.bytes);
    setBackupTaken(true);
    setNote("Identity bundle downloaded — store it with the passphrase.");
  };

  const onConfirmBackup = () => {
    if (!backupTaken || !backupConfirm) {
      setError("Download your identity bundle and confirm before continuing.");
      return;
    }
    if (!passphraseAck) {
      setError("Confirm you saved the bundle passphrase before continuing.");
      return;
    }
    setPendingGitBundle(null);
    setPassphraseAck(false);
    setFingerprintWordList([]);
    setError(null);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // startVaultEnroll(); setView("vault-prompt");
    // setVaultBackupEnabled(Boolean(getSessionVaultId()));
    // void ensureSignedInAccountVault(…) here AND in useEffect — double busy/status
    // NEW CODE - TESTING: hub view; vault ensure runs once via the useEffect
    setView("hub");
    setSettingsSection("profile");
    setNote("Identity ready.");
  };

  const onRestore = (e: FormEvent) => {
    e.preventDefault();
    void run(
      async () => {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // startVaultEnroll(); setView("vault-prompt");
      // NEW CODE - TESTING: restore signs in directly — vault setup is create-only
      if (restoreTab === "bundle") {
        if (!bundleFile) {
          throw new Error("Choose a freenet-git identity.bundle file");
        }
        await importFreenetGitIdentityBundle({
          bytes: bundleFile,
          passphrase: bundlePassphrase,
          onStatus: setOpStep,
        });
      } else {
        const phrase = recoveryPhrase.trim();
        if (!phrase) {
          throw new Error("Enter your 24-word recovery phrase");
        }
        await restoreFromRecoveryPhrase({ phrase, onStatus: setOpStep });
      }
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // setNote("Identity restored on this node.");
      // NEW CODE - TESTING
      setNote(
        restoreTab === "phrase"
          ? "Identity restored — vault repos pulled when available."
          : "Identity restored on this node. Sync vault from Settings if needed.",
      );
      setBundleFile(null);
      setBundleFileName("");
      setBundlePassphrase("");
      setRecoveryPhrase("");
      setView("hub");
      setSettingsSection("profile");
    },
      {
        scenario:
          restoreTab === "phrase" ? "restore-phrase" : "restore-bundle",
      },
    );
  };

  // Backup gate runs after create even though identity is already on the node.
  if (view === "backup" && pendingGitBundle) {
    return (
      <AuthShell>
        <div className="auth-card auth-card-wide">
          <h1 className="auth-title">Save your identity bundle</h1>
          <p className="auth-lede">
            Same{" "}
            <span className="mono">git-identity.bundle</span> format as
            freenet-git. Download it and copy the passphrase — that pair is
            how you restore in {brand.displayName} or the CLI later.
          </p>
          {error ? <div className="error-banner">{error}</div> : null}
          {note ? <p className="muted auth-note">{note}</p> : null}

          <div className="auth-secret-block">
            <div className="auth-label-row">
              <span className="auth-label">Fingerprint</span>
            </div>
            <pre className="account-phrase-box mono break tiny">
              {pendingGitBundle.fingerprint}
            </pre>
            <p className="auth-hint">
              Public fingerprint words (not a password):{" "}
              <span className="mono">{fingerprintWordList.join(" ")}</span>
            </p>
          </div>

          <button
            type="button"
            className="btn auth-submit"
            onClick={onDownloadBackup}
          >
            Download {pendingGitBundle.filename}
          </button>
          {backupTaken ? (
            <PassphraseReveal
              passphrase={pendingGitBundle.passphrase}
              filename={pendingGitBundle.filename}
            />
          ) : (
            <p className="muted tiny">
              Download first — the passphrase appears after the file is saved.
            </p>
          )}
          <label className="account-check">
            <input
              type="checkbox"
              checked={backupConfirm}
              onChange={(e) => setBackupConfirm(e.target.checked)}
            />
            I downloaded the identity bundle
          </label>
          <label className="account-check">
            <input
              type="checkbox"
              checked={passphraseAck}
              onChange={(e) => setPassphraseAck(e.target.checked)}
            />
            I saved the bundle passphrase somewhere safe
          </label>
          <button
            type="button"
            className="btn auth-submit"
            disabled={!backupTaken || !backupConfirm || !passphraseAck || busy}
            onClick={onConfirmBackup}
          >
            Continue
          </button>
        </div>
      </AuthShell>
    );
  }

  if (!identity) {
    if (view === "create") {
      return (
        <AuthShell>
          <h1 className="auth-heading">Create identity</h1>
          <div className="auth-card">
            {error ? (
              <FlashNotice variant="error" onDismiss={() => setError(null)}>
                {error}
              </FlashNotice>
            ) : null}
            <form className="auth-form" onSubmit={onCreate}>
              <label className="auth-field" htmlFor="create-username">
                <span className="auth-label">Username</span>
                <input
                  id="create-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <span className="auth-hint">
                  Shown on listings. Your contact string defaults to the
                  six-word fingerprint slug from your new id (change it later
                  under Public profile).
                </span>
              </label>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              Email field on create — now auto-filled from fingerprint words.
              */}
              <OperationStatus
                active={busy}
                scenario="create"
                step={opStep}
              />
              <button type="submit" className="btn auth-submit" disabled={busy}>
                <BusyLabel
                  busy={busy}
                  busyText={defaultBusyLabel("create")}
                  idleText="Generate identity"
                />
              </button>
            </form>
          </div>
          <p className="auth-switch">
            <button
              type="button"
              className="auth-inline-link"
              onClick={() => switchView("hub")}
            >
              Back
            </button>
          </p>
        </AuthShell>
      );
    }

    if (view === "restore") {
      return (
        <AuthShell>
          <h1 className="auth-heading">Restore identity</h1>
          <div className="auth-card">
            {error ? (
              <FlashNotice variant="error" onDismiss={() => setError(null)}>
                {error}
              </FlashNotice>
            ) : null}
            {note ? (
              <FlashNotice variant="success" onDismiss={() => setNote(null)}>
                {note}
              </FlashNotice>
            ) : null}
            <nav className="auth-tabs" aria-label="Restore method">
              {(
                [
                  ["bundle", "Identity bundle"],
                  ["phrase", "Recovery phrase"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={
                    restoreTab === id ? "auth-tab active" : "auth-tab"
                  }
                  onClick={() => {
                    setRestoreTab(id);
                    setError(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <form className="auth-form" onSubmit={onRestore}>
              {restoreTab === "bundle" ? (
                <>
                  <label className="auth-field">
                    <span className="auth-label">
                      freenet-git identity bundle
                    </span>
                    <input
                      type="file"
                      accept=".bundle,application/octet-stream"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void file.arrayBuffer().then((buf) => {
                          setBundleFile(new Uint8Array(buf));
                          setBundleFileName(file.name);
                          setNote(`Loaded ${file.name}`);
                        });
                      }}
                    />
                    <span className="muted tiny">
                      {bundleFile
                        ? `Ready: ${bundleFileName}`
                        : "Same .bundle as freenet-git init-identity / export-identity."}
                    </span>
                  </label>
                  <label className="auth-field">
                    <span className="auth-label">Bundle passphrase</span>
                    <input
                      type="password"
                      value={bundlePassphrase}
                      onChange={(e) => setBundlePassphrase(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Six words (empty if --no-passphrase)"
                    />
                  </label>
                </>
              ) : (
                <label className="auth-field">
                  <span className="auth-label">Recovery phrase (24 words)</span>
                  <textarea
                    value={recoveryPhrase}
                    onChange={(e) => setRecoveryPhrase(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="word1 word2 … word24"
                    required
                  />
                  <span className="muted tiny">
                    BIP-39 form of your identity seed — same key as inside the
                    .bundle.
                  </span>
                </label>
              )}
              <OperationStatus
                active={busy}
                scenario={
                  restoreTab === "phrase" ? "restore-phrase" : "restore-bundle"
                }
                step={opStep}
              />
              <button type="submit" className="btn auth-submit" disabled={busy}>
                <BusyLabel
                  busy={busy}
                  busyText={defaultBusyLabel(
                    restoreTab === "phrase"
                      ? "restore-phrase"
                      : "restore-bundle",
                  )}
                  idleText="Restore"
                />
              </button>
            </form>
          </div>
          <p className="auth-switch">
            <button
              type="button"
              className="auth-inline-link"
              onClick={() => switchView("hub")}
            >
              Back
            </button>
          </p>
        </AuthShell>
      );
    }

    return (
      <AuthShell>
        <h1 className="auth-heading">Sign in to {brand.displayName}</h1>
        <p className="auth-lede auth-lede-center">
          Identities live on your Freenet node. No central account.
        </p>
        {error ? (
          <FlashNotice variant="error" onDismiss={() => setError(null)}>
            {error}
          </FlashNotice>
        ) : null}
        {note ? (
          <FlashNotice variant="success" onDismiss={() => setNote(null)}>
            {note}
          </FlashNotice>
        ) : null}
        <div className="auth-card auth-actions">
          <button
            type="button"
            className="btn auth-submit"
            onClick={() => switchView("create")}
          >
            Create identity
          </button>
          <button
            type="button"
            className="btn secondary auth-submit"
            onClick={() => switchView("restore")}
          >
            Restore identity
          </button>
        </div>
      </AuthShell>
    );
  }

  const words = fingerprintWords(identity.fingerprint);

  return (
    <main className="settings-page">
      <div className="settings-layout">
        <aside className="settings-nav">
          {identity ? (
            <AccountHealthBlock
              fingerprint={identity.fingerprint}
              vaultId={vaultId || getSessionVaultId()}
              compact
            />
          ) : null}
          <div className="settings-nav-heading">Settings</div>
          <nav className="settings-nav-group">
            {(
              [
                ["profile", "Public profile"],
                ["account", "Account"],
                // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                // ["backups", "Backups"],
                // NEW CODE - TESTING: tip-pack backup prefs replaced by Pin
                ...(localProtectAvailable
                  ? ([["local-protect", "Pin"]] as const)
                  : []),
                ["vault", "Sync"],
                // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                // ["export", "Backup & export"],
                // NEW CODE - TESTING
                ["export", "Downloads"],
                ["api-keys", "API keys"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={
                  settingsSection === id
                    ? "settings-nav-item active"
                    : "settings-nav-item"
                }
                onClick={() => {
                  setSettingsSection(id);
                  setError(null);
                  setNote(null);
                  if (id === "api-keys") {
                    void listVaultApiKeys()
                      .then(setApiKeys)
                      .catch(() => setApiKeys([]));
                  }
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="settings-nav-footer">
            <button
              type="button"
              className="settings-nav-link danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  // await logoutAccount();
                  // setView("hub");
                  // NEW CODE - TESTING
                  const ok = await confirmAndLogoutAccount();
                  if (ok) setView("hub");
                })
              }
            >
              Sign out
            </button>
          </div>
        </aside>

        <section className="settings-main">
          {error ? (
            <FlashNotice
              className="settings-flash"
              variant="error"
              onDismiss={() => setError(null)}
            >
              {error}
            </FlashNotice>
          ) : null}
          {note ? (
            <FlashNotice
              className="settings-flash"
              variant="success"
              onDismiss={() => setNote(null)}
            >
              {note}
            </FlashNotice>
          ) : null}
          {busy && identity ? (
            <OperationStatus
              active
              scenario={busyScenario}
              step={opStep}
            />
          ) : null}
          {/* NEW CODE - TESTING: vault ensure progress after reload / failed Put */}
          {identity && (vaultEnsureBusy || vaultEnsureError) ? (
            <div className="settings-vault-ensure">
              {vaultEnsureBusy ? (
                <OperationStatus
                  active
                  scenario="vault-sync"
                  step={vaultEnsureStep}
                />
              ) : null}
              {vaultEnsureError && !vaultEnsureBusy ? (
                <FlashNotice
                  className="settings-flash"
                  variant="error"
                  onDismiss={() => setVaultEnsureError(null)}
                >
                  {vaultEnsureError}{" "}
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ marginLeft: "0.5rem" }}
                    onClick={() => {
                      setVaultEnsureError(null);
                      setVaultEnsureBusy(true);
                      void ensureSignedInAccountVault({
                        onStatus: setVaultEnsureStep,
                      }).then((result) => {
                        setVaultBackupEnabled(result.vaultEnabled);
                        setVaultEnsureBusy(false);
                        if (!result.vaultEnabled) {
                          setVaultEnsureError(
                            result.error ?? "Account vault still missing.",
                          );
                        } else {
                          setNote("Account vault is on Freenet.");
                        }
                      });
                    }}
                  >
                    Retry vault
                  </button>
                </FlashNotice>
              ) : null}
            </div>
          ) : null}

          {settingsSection === "profile" ? (
            <>
              <header className="settings-header">
                <h1>Public profile</h1>
                <p className="muted">
                  Display name, contact string, bio, URL, and avatar are public
                  on Freenet (like your fingerprint) and signed by your
                  identity. Your account vault (Sync) holds encrypted repo keys on
                  Freenet — part of this identity, not a second login.
                </p>
              </header>
              <div className="settings-profile-grid">
                <form
                  className="settings-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await updatePublicProfile({
                        vault_id: vaultId,
                        name: profileName,
                        email: profileEmail,
                        bio,
                        url: profileUrl,
                        avatar,
                        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                        // statusText, statusEmoji,
                        // NEW CODE - TESTING: status via profile / header Edit status modal
                        onStatus: setOpStep,
                      });
                      setNote("Profile saved to Freenet.");
                    });
                  }}
                >
                  <label className="settings-field">
                    <span className="settings-label">Display name</span>
                    <input
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      required
                    />
                  </label>
                  {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  <label className="settings-field">
                    <span className="settings-label">Status</span>
                    … emoji + text in Settings …
                  </label>
                  */}
                  {/* NEW CODE - TESTING: status edited from profile avatar / header menu */}
                  <label className="settings-field">
                    <span className="settings-label">
                      Contact{" "}
                      <span className="muted">
                        (e.g. email, nick, or fingerprint words)
                      </span>
                    </span>
                    <input
                      type="text"
                      value={profileEmail}
                      onChange={(e) => setProfileEmail(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="settings-hint muted tiny">
                      Git-style author metadata on commits and Hub listings —
                      not used for login or mail delivery.
                    </span>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ marginTop: "0.5rem", alignSelf: "flex-start" }}
                      disabled={busy || !identity}
                      onClick={() => {
                        if (!identity) return;
                        setProfileEmail(
                          defaultContactFromFingerprint(identity.fingerprint),
                        );
                      }}
                    >
                      Restore fingerprint-word default
                    </button>
                  </label>
                  <label className="settings-field">
                    <span className="settings-label">Bio</span>
                    <textarea
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      rows={3}
                    />
                  </label>
                  <label className="settings-field">
                    <span className="settings-label">URL</span>
                    <input
                      value={profileUrl}
                      onChange={(e) => setProfileUrl(e.target.value)}
                    />
                  </label>
                  {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  Vault password / TOTP were required because bio lived in vault ciphertext.
                  {vaultBackupEnabled ? ( ... ) : ( ... )}
                  */}
                  <p className="muted tiny">
                    Saving publishes a {brand.displayName} profile contract addressed by
                    your fingerprint. Anyone can read it; only your identity can
                    update it.
                  </p>
                  <OperationStatus
                    active={busy && settingsSection === "profile"}
                    scenario="save-profile"
                    step={opStep}
                  />
                  <button type="submit" className="btn" disabled={busy}>
                    <BusyLabel
                      busy={busy && settingsSection === "profile"}
                      busyText={defaultBusyLabel("save-profile")}
                      idleText="Save profile"
                    />
                  </button>
                </form>
                <div className="settings-avatar-panel">
                  <div className="settings-avatar-wrap">
                    <ProfileAvatar
                      fingerprint={identity.fingerprint}
                      vaultId={vaultId}
                      avatarUrl={avatar || null}
                      size={120}
                      className="settings-avatar-img account-settings-identicon"
                    />
                  </div>
                  {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  Upload was overlaid on the image; "Use identicon" only when set.
                  NEW CODE - TESTING: Upload + Reset side by side; Reset clears to null */}
                  <div className="settings-avatar-actions">
                    <label className="settings-avatar-edit btn secondary">
                      Upload
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          void resizeImageToDataUrl(file).then(setAvatar);
                        }}
                      />
                    </label>
                    {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                    disabled={!isStoredCustomAvatar(avatar)}
                    — load strips non-upload values to "", so Reset stayed disabled
                    even when ForgeProfile still had a frozen/generated avatar on chain.
                    NEW CODE - TESTING: always allow Reset; Save writes empty. */}
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        setAvatar("");
                        setNote(
                          "Avatar cleared — save profile to store empty and use the live identicon.",
                        );
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {settingsSection === "account" ? (
            <>
              <header className="settings-header">
                <h1>Account</h1>
              </header>
              <dl className="settings-dl">
                <div className="settings-dl-row">
                  <dt>Username</dt>
                  <dd>{identity.name}</dd>
                </div>
                <div className="settings-dl-row">
                  <dt>Fingerprint</dt>
                  <dd className="mono break tiny">{identity.fingerprint}</dd>
                </div>
                <div className="settings-dl-row">
                  <dt>Vault address</dt>
                  <dd>
                    <p className="mono break tiny" style={{ margin: 0 }}>
                      {vaultId || "—"}
                    </p>
                    <p className="muted tiny" style={{ margin: "0.35rem 0 0" }}>
                      Derived from your identity seed. The account vault is
                      ensured on create/restore at this address.
                    </p>
                    <p className="tiny" style={{ margin: "0.35rem 0 0" }}>
                      Status:{" "}
                      {vaultEnsureBusy
                        ? vaultEnsureStep || "Provisioning account vault…"
                        : vaultBackupEnabled
                          ? "Account vault on Freenet"
                          : "Account vault not found yet"}
                    </p>
                  </dd>
                </div>
                <div className="settings-dl-row">
                  <dt>Fingerprint words</dt>
                  <dd>
                    <p className="muted tiny" style={{ margin: "0 0 0.5rem" }}>
                      Not a recovery phrase. Anyone can recompute these from
                      your public fingerprint. Hidden by default.
                    </p>
                    {!showFingerprintWords ? (
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => setShowFingerprintWords(true)}
                      >
                        Show fingerprint words
                      </button>
                    ) : (
                      <>
                        <div className="fingerprint-words-grid">
                          {words.map((w, i) => (
                            <div
                              key={`${w}-${i}`}
                              className="fingerprint-word"
                            >
                              <span className="fingerprint-word-n">
                                {i + 1}
                              </span>
                              {w}
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="btn secondary"
                          style={{ marginTop: "0.5rem" }}
                          onClick={() => setShowFingerprintWords(false)}
                        >
                          Hide
                        </button>
                      </>
                    )}
                  </dd>
                </div>
              </dl>
            </>
          ) : null}

          {settingsSection === "backups" ? (
            <>
              <header className="settings-header">
                <h1>Backups</h1>
                <p className="muted">
                  Tip-pack backups on this node are replaced by{" "}
                  <strong>Settings → Pin</strong> when your Freenet node
                  advertises local contract pinning. Open Pin to authorize
                  the site and grant per-repo scopes (including auto-pin
                  prefs for repositories and stars).
                </p>
              </header>
            </>
          ) : null}

          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING: tip-pack backup prefs UI removed */}

          {settingsSection === "local-protect" ? (
            <IdentityProtectSettings
              fingerprint={identity.fingerprint}
              vaultId={vaultId || getSessionVaultId()}
              userAvatarDataUrl={avatar || null}
            />
          ) : null}

          {settingsSection === "vault" ? (
            <>
              <header className="settings-header">
                {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                <h1>Vault backup</h1>
                <p className="muted">
                  Optional Freenet ciphertext. {VAULT_PASSWORD_HINT} TOTP
                  required when enabling.
                </p>
                */}
                {/* NEW CODE - TESTING: identity-first sync */}
                <h1>Sync</h1>
                <p className="muted">
                  Your account vault holds encrypted repo keys on Freenet. It is
                  created with your identity — use push/pull here after a bundle
                  import, or when nodes drift.
                </p>
              </header>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              Enable / re-enroll authenticator button + TOTP copy
              */}
              {vaultBackupEnabled ? (
                <p className="muted tiny">
                  Vault is live on Freenet for this identity.
                </p>
              ) : (
                <p className="muted tiny">
                  Vault not found yet — it is provisioned on create/restore.
                  Retry after the network catches up, or restore again.
                </p>
              )}

              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              <h2 className="settings-subhead">Recovery phrase</h2>
              … vault password gate + “not re-rollable” freeze copy …
              */}
              {/* NEW CODE - TESTING: phrase reveal lives under Downloads */}

              {vaultBackupEnabled ? (
                <>
                  {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  <h2 className="settings-subhead">Repo keys: vault ↔ this node</h2>
                  … raw status text + Refresh / Push / Pull buttons …
                  */}
                  {/* NEW CODE - TESTING: modern vault sync panel */}
                  <VaultSyncPanel
                    status={syncStatus}
                    syncBusy={syncBusy}
                    busy={busy}
                    onRefresh={() =>
                      void run(async () => {
                        setSyncBusy(true);
                        try {
                          const status = await compareVaultAndDelegate();
                          setSyncStatus(status);
                          if (status.kind === "in_sync") {
                            setNote(
                              `In sync — repos ${status.delegate_count}/${status.vault_count}, Pages keys ${status.pages.delegate_count}/${status.pages.vault_count}.`,
                            );
                          } else if (status.kind === "vault_behind") {
                            setNote(
                              `Vault is behind this node (repos local-only ${status.only_delegate.length}, Pages local-only ${status.pages.only_delegate.length}). Push to update Freenet.`,
                            );
                          } else if (status.kind === "delegate_behind") {
                            setNote(
                              `This node is behind the vault (repos vault-only ${status.only_vault.length}, Pages vault-only ${status.pages.only_vault.length}). Pull to update delegates.`,
                            );
                          } else if (status.kind === "diverged") {
                            setNote(
                              "Vault and this node have conflicting repo and/or Pages keys — resolve carefully.",
                            );
                          } else {
                            setNote(
                              "No vault ciphertext found for this identity.",
                            );
                          }
                        } finally {
                          setSyncBusy(false);
                        }
                      })
                    }
                    onPush={() =>
                      void run(async () => {
                        await pushDelegateReposToVault();
                        const status = await compareVaultAndDelegate();
                        setSyncStatus(status);
                        setNote(
                          `Pushed this node’s repo and Pages keys to ${brand.displayName} vault.`,
                        );
                      })
                    }
                    onPull={(overwrite) =>
                      void run(async () => {
                        const r = await pullVaultReposToDelegate({
                          overwriteMismatched: overwrite,
                        });
                        const status = await compareVaultAndDelegate();
                        setSyncStatus(status);
                        setNote(
                          `Pulled vault → node (imported ${r.imported}, updated ${r.updated}).`,
                        );
                      })
                    }
                  />
                </>
              ) : null}

              {/* NEW CODE - TESTING: Sync CLI repos moved from Downloads */}
              <h2 className="settings-subhead">
                Sync CLI repos (same identity)
              </h2>
              <p className="muted tiny">
                After <span className="mono">freenet-git create</span>, merge the
                updated CLI bundle here. If {brand.displayName} vault was already in sync with this
                node, the vault auto-updates (signed-in identity — no password).
                If vault and this node were out of sync, the merge still updates
                the delegate — resolve the conflict in{" "}
                <strong>Vault ↔ this node</strong> above first.
              </p>
              <label className="settings-field">
                <span className="settings-label">freenet-git identity.bundle</span>
                <input
                  type="file"
                  accept=".bundle,application/octet-stream"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) {
                      setMergeFile(null);
                      setMergeFileName("");
                      return;
                    }
                    void file.arrayBuffer().then((buf) => {
                      setMergeFile(new Uint8Array(buf));
                      setMergeFileName(file.name);
                    });
                  }}
                />
                {mergeFileName ? (
                  <span className="muted tiny mono">{mergeFileName}</span>
                ) : null}
              </label>
              <label className="settings-field">
                <span className="settings-label">Bundle passphrase</span>
                <input
                  type="password"
                  value={mergePassphrase}
                  onChange={(e) => setMergePassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              vault password + TOTP fields for merge auto-update
              */}
              {/* NEW CODE - TESTING */}
              {vaultBackupEnabled ? (
                <p className="muted tiny">
                  Vault auto-update runs when vault ↔ this node were already in
                  sync before the merge.
                </p>
              ) : (
                <p className="muted tiny">
                  Merge still updates this node without a live vault; create or
                  restore so Freenet can auto-update when in sync.
                </p>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy || !mergeFile}
                onClick={() =>
                  void run(async () => {
                    if (!mergeFile) return;
                    const result = await mergeFreenetGitIdentityBundle({
                      bytes: mergeFile,
                      passphrase: mergePassphrase,
                    });
                    let msg = `Merged ${result.imported} new repo key(s)`;
                    if (result.skipped) {
                      msg += ` (${result.skipped} already present)`;
                    }
                    if (result.vaultUpdated) {
                      msg += "; vault auto-updated (was in sync).";
                    } else if (result.vaultSkippedDueToConflict) {
                      msg +=
                        "; vault not updated — resolve vault ↔ node sync above.";
                    } else {
                      msg += ".";
                    }
                    setNote(msg);
                    setMergeFile(null);
                    setMergeFileName("");
                    setMergePassphrase("");
                    const status = await compareVaultAndDelegate().catch(
                      () => null,
                    );
                    if (status) setSyncStatus(status);
                  })
                }
              >
                Merge into this identity
              </button>

              {vaultBackupEnabled ? (
                <p className="muted tiny">
                  Vault is identity-gated (no password). Push or pull repos above
                  to sync with Freenet.
                </p>
              ) : null}
            </>
          ) : null}

          {settingsSection === "export" ? (
            <>
              <header className="settings-header">
                {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                <h1>Backup &amp; export</h1>
                … restore-another-backup form …
                */}
                {/* NEW CODE - TESTING: downloads only — restore is signed-out flow */}
                <h1>Downloads</h1>
                <p className="muted">
                  Download a freenet-git identity bundle (same file the CLI
                  uses). To restore elsewhere, sign out and use{" "}
                  <strong>Restore identity</strong> with the bundle + passphrase.
                  To merge new CLI repo keys into this account, use{" "}
                  <strong>Sync</strong>.
                </p>
              </header>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              Download identity backup JSON + separate freenet-git section
              */}
              {/* NEW CODE - TESTING: one bundle format */}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const sealed = await exportFreenetGitCliBundle();
                    downloadBytesFile(sealed.filename, sealed.bytes);
                    setCliExport({
                      filename: sealed.filename,
                      passphrase: sealed.passphrase,
                    });
                    setNote(`Downloaded ${sealed.filename}.`);
                  })
                }
              >
                Download freenet-git identity bundle
              </button>
              {cliExport ? (
                <PassphraseReveal
                  passphrase={cliExport.passphrase}
                  filename={cliExport.filename}
                />
              ) : (
                <p className="muted tiny" style={{ marginTop: "0.5rem" }}>
                  A new passphrase is minted for each download — copy it when it
                  appears.
                </p>
              )}

              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              <h2 className="settings-subhead">
                Sync CLI repos (same identity)
              </h2>
              … merge form lived here; moved to Account vault …
              */}

              <h2 className="settings-subhead">Recovery phrase (optional)</h2>
              <div className="settings-reveal-phrase">
                <p className="muted tiny">
                  24-word BIP-39 of your seed — not required if you keep the
                  .bundle + passphrase. Reveal only on a trusted screen.
                </p>
                {!revealPhrase ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={revealBusy}
                    onClick={() => {
                      void (async () => {
                        setRevealBusy(true);
                        setError(null);
                        try {
                          const phrase = await revealSessionRecoveryPhrase();
                          setRevealPhrase(phrase);
                          setNote(
                            "Recovery phrase revealed — copy it, then hide.",
                          );
                        } catch (err: unknown) {
                          setError(
                            err instanceof Error ? err.message : String(err),
                          );
                        } finally {
                          setRevealBusy(false);
                        }
                      })();
                    }}
                  >
                    {revealBusy ? "Revealing…" : "Reveal recovery phrase"}
                  </button>
                ) : (
                  <div className="auth-secret-block">
                    <pre className="account-phrase-box mono break tiny">
                      {revealPhrase}
                    </pre>
                    <div className="row">
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(revealPhrase);
                          setNote("Recovery phrase copied");
                        }}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => setRevealPhrase("")}
                      >
                        Hide
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : null}

          {settingsSection === "api-keys" ? (
            <>
              <header className="settings-header">
                <h1>API keys</h1>
                <p className="muted">
                  Scoped keys for CLI tools (any Freenet node). Mint while signed
                  in — each key unlocks only the envelopes you select, not your
                  identity seed. Hub register / about / rename still need your
                  identity bundle (<span className="mono">{brand.cliName} repo</span>).
                  Revoke to invalidate a key.
                </p>
              </header>
              {!vaultBackupEnabled ? (
                <p className="muted">
                  {vaultEnsureBusy
                    ? vaultEnsureStep ||
                      "Account vault is still provisioning on Freenet…"
                    : "Account vault is not ready yet. Use Retry vault above, or wait for provisioning to finish."}
                </p>
              ) : (
                <>
                  <form
                    className="settings-form"
                    method="post"
                    autoComplete="on"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        if (mintScopes.length === 0) {
                          throw new Error("Select at least one scope");
                        }
                        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                        // const { apiKey, wrap, vault_id } = await mintVaultApiKey({
                        //   name: apiKeyName,
                        // });
                        // NEW CODE - TESTING: pass selected envelope scopes
                        const { apiKey, wrap, vault_id } = await mintVaultApiKey({
                          name: apiKeyName,
                          scopes: mintScopes,
                        });
                        setMintedApiKey(apiKey);
                        setMintedVaultId(vault_id);
                        setApiKeyName("");
                        setApiKeys(await listVaultApiKeys());
                        setNote(
                          `Created API key “${wrap.name}” (scope: ${wrap.scopes.join(", ")}) — copy key and vault id now; the secret will not be shown again.`,
                        );
                      });
                    }}
                  >
                    <label className="settings-field">
                      <span className="settings-label">Account</span>
                      <input
                        type="text"
                        name="username"
                        id="vault-apikey-username"
                        value={vaultId || getSessionVaultId() || ""}
                        readOnly
                        autoComplete="username"
                        spellCheck={false}
                        autoCapitalize="none"
                      />
                    </label>
                    <label className="settings-field">
                      <span className="settings-label">Key name</span>
                      <input
                        name="api-key-name"
                        value={apiKeyName}
                        onChange={(e) => setApiKeyName(e.target.value)}
                        required
                        placeholder="laptop-cli"
                        autoComplete="off"
                      />
                    </label>
                    <fieldset className="settings-field">
                      <legend className="settings-label">Scopes</legend>
                      <p className="settings-hint">
                        Envelope access for this key. CLI vault sync needs{" "}
                        <span className="mono">repos</span>.
                      </p>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={mintScopes.includes(ENVELOPE_REPOS)}
                          onChange={(e) =>
                            toggleMintScope(ENVELOPE_REPOS, e.target.checked)
                          }
                        />
                        <span>
                          <strong>repos</strong>
                          <span className="muted block tiny">
                            Repo keys envelope —{" "}
                            <span className="mono">{brand.cliName} vault sync-bundle</span>
                          </span>
                        </span>
                      </label>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={mintScopes.includes(ENVELOPE_PAGES)}
                          onChange={(e) =>
                            toggleMintScope(ENVELOPE_PAGES, e.target.checked)
                          }
                        />
                        <span>
                          <strong>pages</strong>
                          <span className="muted block tiny">
                            Pages website signing keys envelope
                          </span>
                        </span>
                      </label>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={mintScopes.includes(ENVELOPE_SETTINGS)}
                          onChange={(e) =>
                            toggleMintScope(ENVELOPE_SETTINGS, e.target.checked)
                          }
                        />
                        <span>
                          <strong>settings</strong>
                          <span className="muted block tiny">
                            Settings / prefs envelope (Protect remember, backups)
                          </span>
                        </span>
                      </label>
                    </fieldset>
                    <button
                      type="submit"
                      className="btn"
                      disabled={busy || mintScopes.length === 0}
                    >
                      <BusyLabel
                        busy={busy && settingsSection === "api-keys"}
                        busyText="Minting…"
                        idleText="Mint API key"
                      />
                    </button>
                  </form>
                  {mintedApiKey ? (
                    <div className="auth-secret-block" style={{ marginTop: "1rem" }}>
                      <p className="settings-label">New API key (copy now)</p>
                      <pre className="account-phrase-box mono break tiny">
                        {mintedApiKey}
                      </pre>
                      {mintedVaultId ? (
                        <>
                          <p className="settings-label">Vault id</p>
                          <pre className="account-phrase-box mono break tiny">
                            {mintedVaultId}
                          </pre>
                        </>
                      ) : null}
                      <div className="row">
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => {
                            void navigator.clipboard?.writeText(mintedApiKey);
                            setNote("API key copied");
                          }}
                        >
                          Copy key
                        </button>
                        {mintedVaultId ? (
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => {
                              void navigator.clipboard?.writeText(mintedVaultId);
                              setNote("Vault id copied");
                            }}
                          >
                            Copy vault id
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => {
                            setMintedApiKey(null);
                            setMintedVaultId(null);
                          }}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <h2 className="settings-subhead">Existing keys</h2>
                  {apiKeys.length === 0 ? (
                    <p className="muted">No API keys yet.</p>
                  ) : (
                    <ul className="settings-list">
                      {apiKeys.map((k) => (
                        <li key={k.id} className="settings-list-row">
                          <div>
                            <strong>{k.name}</strong>
                            <div className="muted tiny">
                              {k.created_at} · {k.scopes.join(", ")}
                            </div>
                          </div>
                          {revokeId === k.id ? (
                            <form
                              className="row"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void run(async () => {
                                  await revokeVaultApiKey({ id: k.id });
                                  setRevokeId(null);
                                  setApiKeys(await listVaultApiKeys());
                                  setNote(`Revoked “${k.name}”.`);
                                });
                              }}
                            >
                              <button type="submit" className="btn danger" disabled={busy}>
                                Confirm revoke
                              </button>
                              <button
                                type="button"
                                className="btn secondary"
                                onClick={() => setRevokeId(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <button
                              type="button"
                              className="btn secondary"
                              onClick={() => setRevokeId(k.id)}
                            >
                              Revoke
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="muted tiny" style={{ marginTop: "1rem" }}>
                    CLI:{" "}
                    <span className="mono">
                      {brand.cliName} vault sync-bundle --api-key … --bundle …
                    </span>
                    {" "}
                    (from repo:{" "}
                    <span className="mono">npm run {brand.cliName} -- vault …</span>
                    {" "}
                    or{" "}
                    <span className="mono">npm run install:cli</span>)
                  </p>
                </>
              )}
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
