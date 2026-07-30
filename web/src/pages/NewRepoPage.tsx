import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import { api } from "../api";
import {
  currentIdentity,
  getCachedIdentity,
  getCachedProfile,
  getSessionVaultId,
  onAuthSessionChange,
} from "../freenet/auth-api";
import type { ForgeIdentityInfo } from "../freenet/owner-api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { ProfileAvatar } from "../components/ProfileAvatar";
import { repoHref } from "../lib/repo-path";
import { registryLabel } from "../lib/brand";
import { isBrowserNativeMode } from "../tip-browse";
import { listLicenses } from "@gitforge/licensee";
import { useDocumentTitle } from "../lib/document-title";

function parseRepoPath(url: string): { prefix: string; label: string } | null {
  const m = /freenet::([^\s/]+)\/([^\s]+)/.exec(url);
  if (!m) return null;
  return { prefix: m[1]!, label: m[2]! };
}

/** Nav state for post-create first-commit editor. */
export interface FirstCommitNavState {
  registration?: unknown;
  firstCommit?: {
    addReadme: boolean;
    licenseKey: string | null;
  };
}

export function NewRepoPage() {
  useDocumentTitle("New repository");
  const websiteMode = isBrowserNativeMode();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<ForgeIdentityInfo | null>(() =>
    getCachedIdentity(),
  );
  const [sessionReady, setSessionReady] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // (no README / license starters on create)
  // NEW CODE - TESTING: GitHub-like Add README + Add license
  const [addReadme, setAddReadme] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const avatar = getCachedProfile()?.avatar ?? "";
  const vaultId = getSessionVaultId() ?? "";

  const featuredLicenses = useMemo(
    () => listLicenses({ featured: true }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await currentIdentity();
        if (!cancelled) setIdentity(id);
      } catch {
        if (!cancelled) setIdentity(getCachedIdentity());
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return onAuthSessionChange(() => {
      setIdentity(getCachedIdentity());
    });
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const label = name.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createRepo(label, description.trim() || undefined);
      if (!result.ok) {
        throw new Error(result.stderr || result.error || "create failed");
      }
      const path =
        (result.url && parseRepoPath(result.url)) ||
        (result.stdout && parseRepoPath(result.stdout));
      if (path) {
        const wantReadme = addReadme;
        const wantLicense = licenseKey.trim() || null;
        const needsFirstCommit = wantReadme || Boolean(wantLicense);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // navigate(repoHref(...), { state: { registration } })
        // NEW CODE - TESTING: land in first-commit editor when starters chosen
        if (needsFirstCommit) {
          const branch = "main";
          const state: FirstCommitNavState = {
            registration: result.registration,
            firstCommit: {
              addReadme: wantReadme,
              licenseKey: wantLicense,
            },
          };
          navigate(
            `${repoHref(path.prefix, path.label, `new/${encodeURIComponent(branch)}`)}`,
            { state },
          );
          return;
        }
        navigate(repoHref(path.prefix, path.label), {
          state: result.registration
            ? {
                registration: result.registration,
              }
            : undefined,
        });
        // Auto-protect own repos: one Freenet shell scope prompt after create
        void (async () => {
          try {
            const { getProtectPrefs } = await import("../freenet/protect-prefs");
            if (!getProtectPrefs().autoProtectOwnRepos) return;
            const {
              hasLocalProtectCapability,
              isAppGranted,
              findScope,
              fetchProtectStatus,
              repoGrantId,
              ensureRepoScopeAndSync,
            } = await import("../freenet/local-protect");
            if (!(await hasLocalProtectCapability())) return;
            if (!(await isAppGranted())) return;
            const status = await fetchProtectStatus();
            if (findScope(status, repoGrantId(path.prefix))) return;
            const { repoContractKey } = await import("../freenet/keys");
            const { repoScopePresentation } = await import(
              "../freenet/protect-presentation"
            );
            let repoKey = "";
            try {
              repoKey = repoContractKey(path.prefix).encode();
            } catch {
              repoKey = String(repoContractKey(path.prefix));
            }
            await ensureRepoScopeAndSync({
              prefix: path.prefix,
              repoContractKey: repoKey,
              tipPackKeys: [],
              tipRetention: "current",
              presentation: repoScopePresentation(
                label,
                repoKey,
                "current",
              ),
            });
          } catch (err: unknown) {
            console.warn(
              "[freenet-forge] create protect prompt failed",
              err instanceof Error ? err.message : err,
            );
          }
        })();
        return;
      }
      throw new Error(
        result.registerError
          ? `Created, but could not open repo: ${result.registerError}`
          : "Created, but could not parse repo URL",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (websiteMode && !sessionReady) {
    return <PageLoadingOverlay skeleton="auth" message="" />;
  }

  if (websiteMode && !identity) {
    return (
      <main className="page new-repo-page">
        <section className="panel">
          <h1>Create a new repository</h1>
          <p className="lede">
            Connect a Freenet identity before creating a repository.
          </p>
          <div className="row">
            <Link className="btn" to="/identity?create=1">
              Create identity
            </Link>
            <Link className="btn secondary" to="/identity?restore=1">
              Restore backup
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page new-repo-page">
      <header className="new-repo-hero">
        <h1>Create a new repository</h1>
        <p className="muted">
          Repositories hold Freenet-hosted git history. Required fields are
          marked with an asterisk (*).
        </p>
      </header>

      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}

      <form className="new-repo-form" onSubmit={(e) => void onSubmit(e)}>
        <section className="new-repo-step">
          <div className="new-repo-step-marker" aria-hidden>
            1
          </div>
          <div className="new-repo-step-body">
            <h2>General</h2>
            <div className="new-repo-owner-row">
              <div className="new-repo-owner">
                <span className="settings-label">Owner *</span>
                <div className="new-repo-owner-chip">
                  <ProfileAvatar
                    fingerprint={identity?.fingerprint ?? null}
                    vaultId={vaultId}
                    avatarUrl={avatar || null}
                    size={28}
                    className="new-repo-owner-avatar"
                  />
                  <span>{identity?.name ?? "you"}</span>
                </div>
              </div>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              <span className="new-repo-owner-slash" aria-hidden>
                /
              </span>
              */}
              {/* NEW CODE - TESTING: spacer label so / sits on the control row */}
              <div className="new-repo-owner-slash-col" aria-hidden>
                <span className="settings-label">&nbsp;</span>
                <span className="new-repo-owner-slash">/</span>
              </div>
              <label className="settings-field new-repo-name-field">
                <span className="settings-label">Repository name *</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="my-project"
                  aria-label="Repository name"
                />
              </label>
            </div>
            <p className="muted tiny">
              Great repository names are short and memorable.
            </p>
            <label className="settings-field">
              <span className="settings-label">Description</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={350}
                placeholder="Optional short description"
              />
              <span className="muted tiny">
                {description.length} / 350 characters
              </span>
            </label>
          </div>
        </section>

        <section className="new-repo-step">
          <div className="new-repo-step-marker" aria-hidden>
            2
          </div>
          <div className="new-repo-step-body">
            <h2>Configuration</h2>
            <label className="settings-field">
              <span className="settings-label">Visibility *</span>
              <div className="new-repo-visibility" aria-readonly="true">
                <span className="new-repo-visibility-icon" aria-hidden>
                  <svg viewBox="0 0 16 16" width="16" height="16">
                    <path
                      fill="currentColor"
                      d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 4.97-4.97a.75.75 0 0 1 1.06 1.06Z"
                    />
                  </svg>
                </span>
                <div>
                  <strong>Public</strong>
                  <p className="muted tiny" style={{ margin: 0 }}>
                    Freenet-hosted repos are public on the network. Private
                    repos are not part of freenet-git yet.
                  </p>
                </div>
              </div>
            </label>

            <div className="new-repo-starter-row">
              <label className="new-repo-switch">
                <input
                  type="checkbox"
                  checked={addReadme}
                  onChange={(e) => setAddReadme(e.target.checked)}
                />
                <span className="new-repo-switch-ui" aria-hidden />
                <span className="new-repo-switch-copy">
                  <strong>Add a README file</strong>
                  <span className="muted tiny">
                    This is where you can write a long description for your
                    project.
                  </span>
                </span>
              </label>
            </div>

            <label className="settings-field">
              <span className="settings-label">Add a license</span>
              <select
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                aria-label="Add a license"
              >
                <option value="">No license</option>
                {featuredLicenses.map((lic) => (
                  <option key={lic.key} value={lic.key}>
                    {lic.title}
                    {lic.spdx_id ? ` (${lic.spdx_id})` : ""}
                  </option>
                ))}
              </select>
              <span className="muted tiny">
                Licenses let others use, change, and redistribute your work.
              </span>
            </label>

            <button
              type="submit"
              className="btn"
              disabled={busy || !name.trim()}
            >
              {busy ? "Creating…" : "Create repository"}
            </button>
            {!websiteMode ? (
              <p className="muted tiny">
                Uses local <span className="mono">freenet-git create</span>, then
                Hub register.
              </p>
            ) : (
              <p className="muted tiny">
                Creates an empty repo contract on your node, registers it on
                {registryLabel()}, then opens a first-commit editor when
                README or a license is selected.
              </p>
            )}
          </div>
        </section>
      </form>
    </main>
  );
}
