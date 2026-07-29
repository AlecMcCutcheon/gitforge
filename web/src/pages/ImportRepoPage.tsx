import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import { api, type HubRegistration } from "../api";
import {
  currentIdentity,
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
import type { HubIdentityInfo } from "../freenet/owner-api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { repoHref } from "../lib/repo-path";
import { isBrowserNativeMode } from "../tip-browse";
import { useDocumentTitle } from "../lib/document-title";

/** Parse freenet: / freenet:: URLs into prefix + label. */
export function parseFreenetRepoUrl(
  raw: string,
): { prefix: string; label: string } | null {
  const s = raw.trim();
  const m =
    /^(?:freenet::?)?([1-9A-HJ-NP-Za-km-z]{8,48})\/([A-Za-z0-9._~-]+)$/.exec(
      s,
    );
  if (!m) return null;
  return { prefix: m[1]!, label: m[2]! };
}

interface VerifyResult {
  found: boolean;
  canWrite: boolean;
  alreadyRegistered: boolean;
  detail: string;
  prefix: string;
  label: string;
}

interface ImportableRepo {
  prefix: string;
  label: string;
  freenetUrl: string;
  verify: VerifyResult;
}

async function loadLocalRepoKeys(): Promise<
  Array<{ prefix: string; label: string }>
> {
  if (isBrowserNativeMode()) {
    const { nativeListRepos } = await import("../freenet/owner-api");
    return nativeListRepos();
  }
  const id = await api.identity();
  if (!id.ok) return [];
  const { parseWhoamiStdout } = await import("../lib/whoami");
  return parseWhoamiStdout(id.stdout)?.repos ?? [];
}

async function loadRegistryRepos(): Promise<HubRegistration[]> {
  if (isBrowserNativeMode()) {
    const { loadRegistryCached, peekCachedRegistry } = await import(
      "../freenet/discover-cache"
    );
    const { fetchHubRegistry } = await import("../freenet/hub-registry");
    const warm = peekCachedRegistry();
    if (warm) return warm;
    return loadRegistryCached(() => fetchHubRegistry()).catch(() => []);
  }
  try {
    const reg = await api.registry();
    return reg.repos ?? [];
  } catch {
    return [];
  }
}

async function repoContractFound(
  prefix: string,
  label: string,
): Promise<{ found: boolean; detail: string }> {
  if (isBrowserNativeMode()) {
    try {
      const { fetchRepoState } = await import("../freenet/tip-fetch");
      await fetchRepoState(prefix);
      return { found: true, detail: "Repo contract found on Freenet." };
    } catch (err) {
      return {
        found: false,
        detail:
          err instanceof Error
            ? `Could not load repo: ${err.message}`
            : "Could not load repo from Freenet.",
      };
    }
  }
  try {
    await api.repo(prefix, label);
    return { found: true, detail: "Repo found via Hub bridge." };
  } catch (err) {
    return {
      found: false,
      detail:
        err instanceof Error
          ? `Could not load repo: ${err.message}`
          : "Could not load repo.",
    };
  }
}

/**
 * Scan identity keys: only repos that exist on Freenet, you can write, and
 * are not yet on HubRegistry.
 */
async function scanImportableRepos(): Promise<ImportableRepo[]> {
  const [local, registry] = await Promise.all([
    loadLocalRepoKeys(),
    loadRegistryRepos(),
  ]);
  const registered = new Set(registry.map((r) => r.repo_prefix));
  const candidates = local.filter((r) => !registered.has(r.prefix));
  const settled = await Promise.all(
    candidates.map(async (r) => {
      const probe = await repoContractFound(r.prefix, r.label);
      if (!probe.found) return null;
      const verify: VerifyResult = {
        found: true,
        canWrite: true,
        alreadyRegistered: false,
        detail: [
          probe.detail,
          "Your identity holds the repo owner key (can register / push).",
          "Not yet on GitAtlasRegistry (GAR).",
        ].join(" "),
        prefix: r.prefix,
        label: r.label,
      };
      return {
        prefix: r.prefix,
        label: r.label,
        freenetUrl: `freenet::${r.prefix}/${r.label}`,
        verify,
      } satisfies ImportableRepo;
    }),
  );
  return settled
    .filter((r): r is ImportableRepo => r != null)
    .sort((a, b) =>
      `${a.label}/${a.prefix}`.localeCompare(`${b.label}/${b.prefix}`),
    );
}

/**
 * Import / register an existing freenet-git repo onto GitAtlasRegistry (GAR).
 * Does not clone or re-create the contract — only dual-sig listing.
 */
export function ImportRepoPage() {
  useDocumentTitle("Import repository");
  const websiteMode = isBrowserNativeMode();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<HubIdentityInfo | null>(() =>
    getCachedIdentity(),
  );
  const [sessionReady, setSessionReady] = useState(false);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Manual URL + Verify button + raw delegate list (including already-registered).
  // NEW CODE - TESTING: pre-verified dropdown of importable (unregistered) repos only
  const [importable, setImportable] = useState<ImportableRepo[]>([]);
  const [scanBusy, setScanBusy] = useState(true);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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

  useEffect(() => {
    if (!identity) {
      setImportable([]);
      setScanBusy(false);
      return;
    }
    let cancelled = false;
    setScanBusy(true);
    setError(null);
    setNote(null);
    setVerify(null);
    setSelectedUrl("");
    void scanImportableRepos()
      .then((rows) => {
        if (cancelled) return;
        setImportable(rows);
        if (rows.length === 0) {
          setNote(
            "No unregistered repositories with write access were found in your identity on this device.",
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setImportable([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setScanBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  const onSelectRepo = (value: string) => {
    setSelectedUrl(value);
    setError(null);
    if (!value) {
      setVerify(null);
      setNote(null);
      return;
    }
    const hit = importable.find((r) => r.freenetUrl === value);
    if (!hit) {
      setVerify(null);
      setNote(null);
      return;
    }
    setVerify(hit.verify);
    setNote("Checks passed — you can register on GitAtlasRegistry (GAR).");
  };

  const onRegister = async () => {
    if (!verify?.found || !verify.canWrite || verify.alreadyRegistered) return;
    setRegisterBusy(true);
    setError(null);
    try {
      const registration = await api.registerRepo({
        prefix: verify.prefix,
        label: verify.label,
      });
      navigate(repoHref(verify.prefix, verify.label), {
        state: registration ? { registration } : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegisterBusy(false);
    }
  };

  if (websiteMode && !sessionReady) {
    return <PageLoadingOverlay skeleton="auth" message="" />;
  }

  if (websiteMode && !identity) {
    return (
      <main className="page new-repo-page">
        <section className="panel">
          <h1>Import repository</h1>
          <p className="lede">
            Connect the Freenet identity that owns the repo before importing.
          </p>
          <div className="row">
            <Link className="btn" to="/identity?restore=1">
              Restore identity
            </Link>
            <Link className="btn secondary" to="/identity?create=1">
              Create identity
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const canRegister =
    Boolean(verify?.found && verify.canWrite && !verify.alreadyRegistered);

  return (
    <main className="page new-repo-page">
      <header className="new-repo-hero">
        <h1>Import repository</h1>
        <p className="muted">
          Register an existing freenet-git repo from your identity onto
          GitAtlasRegistry (GAR). Only unregistered repos you can write to are
          listed below.
        </p>
      </header>

      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
      {note ? <p className="muted">{note}</p> : null}

      <div className="new-repo-form">
        <section className="new-repo-step">
          <div className="new-repo-step-marker" aria-hidden>
            1
          </div>
          <div className="new-repo-step-body">
            <h2>Source repository</h2>
            {scanBusy ? (
              <p className="muted">
                Checking local identity repos for import eligibility…
              </p>
            ) : null}
            <label className="settings-field">
              <span className="settings-label">
                Unregistered repos you can import
              </span>
              <select
                value={selectedUrl}
                onChange={(e) => onSelectRepo(e.target.value)}
                disabled={scanBusy}
                aria-label="Unregistered repository to import"
              >
                <option value="">
                  {scanBusy
                    ? "Scanning…"
                    : importable.length === 0
                      ? "No unregistered repositories available to import"
                      : "Choose a repository…"}
                </option>
                {importable.map((r) => (
                  <option key={`${r.prefix}/${r.label}`} value={r.freenetUrl}>
                    {r.label} ({r.prefix})
                  </option>
                ))}
              </select>
              <span className="muted tiny">
                Pre-checked: Freenet contract found, you hold the key, and not
                yet on HubRegistry.
              </span>
            </label>
          </div>
        </section>

        <section className="new-repo-step">
          <div className="new-repo-step-marker" aria-hidden>
            2
          </div>
          <div className="new-repo-step-body">
            <h2>Checks</h2>
            <ul className="import-check-list">
              <li className={verify ? (verify.found ? "ok" : "bad") : "pending"}>
                <span className="import-check-mark" aria-hidden>
                  {verify ? (verify.found ? "✓" : "✕") : "·"}
                </span>
                Repository found on Freenet
              </li>
              <li
                className={
                  verify ? (verify.canWrite ? "ok" : "bad") : "pending"
                }
              >
                <span className="import-check-mark" aria-hidden>
                  {verify ? (verify.canWrite ? "✓" : "✕") : "·"}
                </span>
                Your identity can write (owns repo key)
              </li>
              <li
                className={
                  verify
                    ? verify.alreadyRegistered
                      ? "warn"
                      : "ok"
                    : "pending"
                }
              >
                <span className="import-check-mark" aria-hidden>
                  {verify
                    ? verify.alreadyRegistered
                      ? "!"
                      : "✓"
                    : "·"}
                </span>
                {verify?.alreadyRegistered
                  ? "Already on GitAtlasRegistry (GAR)"
                  : "Not yet on GitAtlasRegistry (GAR)"}
              </li>
            </ul>
            {verify ? (
              <p className="muted tiny" style={{ whiteSpace: "pre-wrap" }}>
                {verify.detail}
              </p>
            ) : (
              <p className="muted tiny">
                Choose a repository above — checks are filled in automatically.
              </p>
            )}
            <button
              type="button"
              className="btn"
              disabled={!canRegister || registerBusy}
              onClick={() => void onRegister()}
            >
              {registerBusy
                ? "Registering…"
                : "Register on GitAtlasRegistry (GAR)"}
            </button>
            <p className="muted tiny">
              Prefer creating from scratch?{" "}
              <Link to="/new">New repository</Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
