import { useEffect, useMemo, useState } from "react";
import { Link } from "../spa-link";
import { api, type ForgePagesConfig, type ForgeRegistration } from "../api";
import {
  currentIdentity,
  downloadBytesFile,
  exportFreenetGitCliBundle,
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
import type { ForgeIdentityInfo } from "../freenet/owner-api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { PassphraseReveal } from "../components/PassphraseReveal";
import { PersonName } from "../components/PersonName";
import { parseWhoamiStdout } from "../lib/whoami";
import {
  fingerprintWordsJoined,
  peoplePath,
} from "../freenet/fingerprint-words";
import { repoHref } from "../lib/repo-path";
import { brand } from "../lib/brand";
import { isBrowserNativeMode } from "../tip-browse";

function WorkRepoPagesControls({
  prefix,
  label,
  registered,
}: {
  prefix: string;
  label: string;
  /** ForgeRegistry listing present (your work list ⇒ you are registry owner). */
  registered: boolean;
}) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const websiteMode = isBrowserNativeMode();
  const [pages, setPages] = useState<ForgePagesConfig | null>(null);
  const [branch, setBranch] = useState("main");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .pages(prefix, label)
      .then((row) => {
        if (cancelled) return;
        setPages(row);
        if (row.branch) setBranch(row.branch);
        if (row.rootPath != null) setRootPath(row.rootPath);
      })
      .catch(() => {
        if (!cancelled) setPages(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label]);

  const run = async (fn: () => Promise<ForgePagesConfig>) => {
    setBusy(true);
    try {
      setPages(await fn());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="work-pages-row">
      <span className="muted tiny">
        Pages:{" "}
        <span className={`gh-pages-status ${pages?.status ?? "off"}`}>
          {pages?.status ?? "off"}
        </span>
        {pages?.siteUrl ? (
          <>
            {" · "}
            <a href={pages.siteUrl} target="_blank" rel="noreferrer">
              Open site
            </a>
          </>
        ) : null}
        {pages?.contractKey ? (
          <>
            {" · "}
            <span className="mono">{pages.contractKey.slice(0, 12)}…</span>
          </>
        ) : null}
      </span>
      {!registered ? (
        <span className="muted tiny">Register on Hub to manage Pages</span>
      ) : !pages?.enabled ? (
        <div className="work-pages-enable">
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch"
            aria-label={`Pages branch for ${label}`}
          />
          <input
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            placeholder="path"
            aria-label={`Pages path for ${label}`}
          />
          <button
            type="button"
            className="btn secondary"
            disabled={busy || !branch.trim()}
            onClick={() => {
              void run(() =>
                api.pagesEnable(prefix, label, {
                  branch: branch.trim(),
                  rootPath: rootPath.trim(),
                  autoSync: true,
                }),
              );
            }}
          >
            {busy ? "Enabling…" : "Enable Pages"}
          </button>
        </div>
      ) : (
        <div className="work-pages-enable">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void run(() => api.pagesSync(prefix, label))}
          >
            Sync Pages
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.pagesDisable(prefix, label, { tombstone: true }),
              )
            }
          >
            Disable Pages
          </button>
        </div>
      )}
    </div>
  );
}

function WorkNeedsIdentity() {
  return (
    <main className="page">
      <section className="panel">
        <h2>Your work</h2>
        <p className="lede">
          Connect a Freenet identity before creating repos or registering on
          Discover. Use Identity to create a new key or restore a backup.
        </p>
        <div className="row">
          <Link className="btn" to="/identity?create=1">
            Create identity
          </Link>
          <Link className="btn secondary" to="/identity?restore=1">
            Restore backup
          </Link>
          <Link className="btn secondary" to="/identity">
            Open Identity
          </Link>
        </div>
      </section>
    </main>
  );
}

export function WorkPage() {
  const websiteMode = isBrowserNativeMode();
  const [forgeIdentity, setForgeIdentity] = useState<ForgeIdentityInfo | null>(() =>
    websiteMode ? getCachedIdentity() : null,
  );
  const [sessionReady, setSessionReady] = useState(!websiteMode);
  const [identity, setIdentity] = useState<{
    ok: boolean;
    stdout: string;
    stderr: string;
  } | null>(null);
  const [delegateRepos, setDelegateRepos] = useState<
    Array<{ prefix: string; label: string }>
  >([]);
  const [registered, setRegistered] = useState<ForgeRegistration[]>([]);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [idName, setIdName] = useState("");
  // const [idEmail, setIdEmail] = useState("");
  // const [idPassphrase, setIdPassphrase] = useState("");
  // const [idNoPassphrase, setIdNoPassphrase] = useState(false);
  // NEW CODE - TESTING: website mode uses /identity; bridge mode keeps init below
  const [idName, setIdName] = useState("");
  const [idEmail, setIdEmail] = useState("");
  const [idPassphrase, setIdPassphrase] = useState("");
  const [idNoPassphrase, setIdNoPassphrase] = useState(false);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [createName, setCreateName] = useState("");
  // const [createDesc, setCreateDesc] = useState("");
  // const [createResult, setCreateResult] = useState<string | null>(null);
  // NEW CODE - TESTING: create lives on /new
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registerBusy, setRegisterBusy] = useState<string | null>(null);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [cliNote, setCliNote] = useState<string | null>(null);
  // NEW CODE - TESTING
  const [cliExport, setCliExport] = useState<{
    filename: string;
    passphrase: string;
  } | null>(null);

  const refresh = async () => {
    if (websiteMode) {
      const id = await currentIdentity();
      setForgeIdentity(id);
      if (!id) {
        setIdentity({
          ok: false,
          stdout: "",
          stderr: `No ${brand.displayName} identity in delegate`,
        });
        setDelegateRepos([]);
        setRegistered([]);
        return;
      }
    }
    const [id, reg] = await Promise.all([api.identity(), api.registry()]);
    setIdentity(id);
    setRegistered(reg.repos);
    if (websiteMode) {
      try {
        const { nativeListRepos } = await import("../freenet/owner-api");
        setDelegateRepos(await nativeListRepos());
      } catch {
        setDelegateRepos([]);
      }
    } else {
      setDelegateRepos([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    const unsub = websiteMode
      ? onAuthSessionChange(() => {
          void refresh().catch(() => undefined);
        })
      : undefined;
    return () => {
      cancelled = true;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount + auth only
  }, [websiteMode]);

  const parsed = useMemo(() => {
    if (websiteMode && forgeIdentity) {
      return {
        fingerprint: forgeIdentity.fingerprint,
        name: forgeIdentity.name,
        email: forgeIdentity.email || null,
        repos: delegateRepos,
      };
    }
    if (!identity?.ok) return null;
    const fromWhoami = parseWhoamiStdout(identity.stdout);
    if (!websiteMode) return fromWhoami;
    return {
      fingerprint: fromWhoami?.fingerprint ?? "",
      name: fromWhoami?.name ?? "",
      email: fromWhoami?.email ?? null,
      repos: delegateRepos,
    };
  }, [identity, websiteMode, delegateRepos, forgeIdentity]);

  const registeredByPrefix = useMemo(() => {
    const m = new Map<string, ForgeRegistration>();
    for (const r of registered) m.set(r.repo_prefix, r);
    return m;
  }, [registered]);

  const createIdentity = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.initIdentity({
        name: idName.trim(),
        email: idEmail.trim(),
        passphrase: idNoPassphrase ? undefined : idPassphrase,
        noPassphrase: idNoPassphrase,
      });
      if (!result.ok) {
        throw new Error(result.stderr || result.error || "init-identity failed");
      }
      setIdPassphrase("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const createRepo = async () => { ... WorkPage inline create ... };

  const registerOnHub = async (prefix: string, label: string) => {
    setRegisterBusy(prefix);
    setError(null);
    try {
      await api.registerRepo({ prefix, label });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegisterBusy(null);
    }
  };

  const exportCliBundle = async () => {
    setBusy(true);
    setError(null);
    setCliExport(null);
    try {
      const sealed = await exportFreenetGitCliBundle();
      downloadBytesFile(sealed.filename, sealed.bytes);
      setCliExport({
        filename: sealed.filename,
        passphrase: sealed.passphrase,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (websiteMode && !sessionReady) {
    return <PageLoadingOverlay skeleton="auth" message="" />;
  }

  if (websiteMode && !forgeIdentity) {
    return <WorkNeedsIdentity />;
  }

  return (
    <main className="page">
      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}

      <section className="panel">
        <h2>Identity</h2>
        <p className="lede">
          {websiteMode ? (
            <>
              Connected via the {brand.displayName} identity delegate. Manage create /
              restore / vault on{" "}
              <Link to="/identity">Identity</Link>. Export a freenet-git CLI
              bundle to push with{" "}
              <span className="mono">git-remote-freenet</span>.
            </>
          ) : (
            <>
              Needed to create/push Freenet repos. Bundle:{" "}
              <span className="mono">~/.config/freenet/git-identity.bundle</span>
            </>
          )}
        </p>
        {identity?.ok || (websiteMode && forgeIdentity) ? (
          <>
            <pre className="mono pre">
              {websiteMode && forgeIdentity
                ? `${forgeIdentity.name} <${forgeIdentity.email}>\n${forgeIdentity.fingerprint}\n`
                : identity?.stdout}
            </pre>
            {parsed?.fingerprint ? (
              <p className="tiny">
                People page:{" "}
                <Link to={peoplePath(parsed.fingerprint)}>
                  /people/{fingerprintWordsJoined(parsed.fingerprint)}
                </Link>
              </p>
            ) : null}
            {websiteMode ? (
              <div className="row" style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void exportCliBundle()}
                >
                  Export freenet-git bundle
                </button>
                <Link className="btn secondary" to="/identity">
                  Identity settings
                </Link>
              </div>
            ) : null}
            {cliExport ? (
              <PassphraseReveal
                passphrase={cliExport.passphrase}
                filename={cliExport.filename}
              />
            ) : null}
          </>
        ) : (
          <>
            {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING: website inline create removed */}
            <p className="muted">
              {identity?.stderr || "No identity yet — create one below."}
            </p>
            <div className="row">
              <input
                placeholder="Display name"
                value={idName}
                onChange={(e) => setIdName(e.target.value)}
              />
              <input
                placeholder="you@example.com"
                value={idEmail}
                onChange={(e) => setIdEmail(e.target.value)}
              />
            </div>
            <div className="row" style={{ marginTop: "0.6rem" }}>
              <input
                type="password"
                placeholder="Passphrase"
                value={idPassphrase}
                disabled={idNoPassphrase}
                onChange={(e) => setIdPassphrase(e.target.value)}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={idNoPassphrase}
                  onChange={(e) => setIdNoPassphrase(e.target.checked)}
                />
                No passphrase
              </label>
              <button
                type="button"
                className="btn"
                disabled={
                  busy ||
                  !idName.trim() ||
                  !idEmail.trim() ||
                  (!idNoPassphrase && !idPassphrase)
                }
                onClick={() => void createIdentity()}
              >
                Create identity
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Your repositories</h2>
        <p className="lede">
          {websiteMode ? (
            <>
              Repos created in this Hub (keys in the identity delegate). Use{" "}
              <strong>Register on Hub</strong> to publish dual-sig listings to
              Discover. Push still uses <span className="mono">freenet-git</span>{" "}
              / <span className="mono">git-remote-freenet</span> with your
              exported CLI bundle.
            </>
          ) : (
            <>
              From your identity bundle. New repos are created via{" "}
              <Link to="/new">New repository</Link>; use{" "}
              <strong>Register on Hub</strong> for existing repos that are not
              listed on Discover yet.
            </>
          )}
        </p>
        <div className="row" style={{ marginBottom: "0.85rem" }}>
          <Link className="btn" to="/new">
            New repository
          </Link>
        </div>
        {!parsed || parsed.repos.length === 0 ? (
          <p className="muted">
            No repos in the local identity registry yet. Create one from{" "}
            <Link to="/new">New repository</Link>.
          </p>
        ) : (
          <ul className="work-repo-list">
            {parsed.repos.map((r) => {
              const hub = registeredByPrefix.get(r.prefix);
              return (
                <li key={`${r.prefix}/${r.label}`}>
                  <div>
                    <Link to={repoHref(r.prefix, r.label, "", hub ? { ownerFingerprint: hub.identity_fingerprint } : undefined)}>
                      <strong>{hub?.name ?? r.label}</strong>
                    </Link>
                    <div className="mono muted tiny">
                      freenet::{r.prefix}/{r.label}
                    </div>
                    {hub ? (
                      <div className="muted tiny">
                        Registered · owner{" "}
                        <PersonName
                          fingerprint={hub.identity_fingerprint}
                          link
                        />
                      </div>
                    ) : (
                      <div className="muted tiny">Not on ForgeRegistry yet</div>
                    )}
                    <WorkRepoPagesControls
                      prefix={r.prefix}
                      label={r.label}
                      registered={Boolean(hub)}
                    />
                  </div>
                  <div className="work-repo-actions">
                    <Link
                      className="btn secondary"
                      to={repoHref(r.prefix, r.label, "", hub ? { ownerFingerprint: hub.identity_fingerprint } : undefined)}
                    >
                      Open
                    </Link>
                    {!hub ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={registerBusy === r.prefix}
                        onClick={() => void registerOnHub(r.prefix, r.label)}
                      >
                        {registerBusy === r.prefix
                          ? "Registering…"
                          : "Register on Hub"}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
      <section className="panel">
        <h2>Create repository</h2>
        ... moved to /new ...
      </section>
      */}
    </main>
  );
}
