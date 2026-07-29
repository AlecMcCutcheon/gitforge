import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "../spa-link";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";
import { api, type BranchRow, type RepoPageData } from "../api";
import { PageLoadingOverlay } from "./PageLoadingOverlay";

type BranchTab = "overview" | "active" | "stale" | "all";

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 45) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 18) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.round(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

function CopyIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path
        fill="currentColor"
        d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
      />
      <path
        fill="currentColor"
        d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"
      />
    </svg>
  );
}

function AheadBehind({ row }: { row: BranchRow }) {
  if (row.isDefault) {
    return <span className="gh-default-pill">Default</span>;
  }
  if (row.behind == null || row.ahead == null) {
    return <span className="muted tiny">—</span>;
  }
  const total = row.behind + row.ahead || 1;
  const behindPct = (row.behind / total) * 100;
  const aheadPct = (row.ahead / total) * 100;
  return (
    <div className="gh-ahead-behind">
      <span className="mono">
        {row.behind} <span className="muted">|</span> {row.ahead}
      </span>
      <div className="gh-ahead-bar" aria-hidden>
        <span style={{ width: `${behindPct}%` }} className="behind" />
        <span style={{ width: `${aheadPct}%` }} className="ahead" />
      </div>
    </div>
  );
}

function BranchTable({
  title,
  rows,
  prefix,
  label,
  ownerOpts,
  footer,
}: {
  title: string;
  rows: BranchRow[];
  prefix: string;
  label: string;
  ownerOpts?: RepoHrefOpts;
  footer?: ReactNode;
}) {
  if (rows.length === 0) return null;

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="gh-branch-section">
      <h3>{title}</h3>
      <div className="gh-branch-table-wrap">
        <table className="gh-branch-table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Updated</th>
              <th>Check status</th>
              <th>Behind | Ahead</th>
              <th>Pull request</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>
                  <div className="gh-branch-name-cell">
                    <Link
                      className="gh-branch-chip"
                      to={repoHref(
                        prefix,
                        label,
                        `tree/${encodeURIComponent(row.name)}`,
                        ownerOpts,
                      )}
                    >
                      {row.name}
                    </Link>
                    <button
                      type="button"
                      className="gh-icon-btn"
                      title="Copy branch name"
                      onClick={() => void copy(row.name)}
                    >
                      <CopyIcon />
                    </button>
                  </div>
                </td>
                <td>
                  <div className="gh-branch-updated">
                    {row.author ? (
                      <span className="gh-avatar" title={row.author}>
                        {row.author.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <span className="gh-avatar muted">?</span>
                    )}
                    <span className="muted">{relativeTime(row.date)}</span>
                  </div>
                </td>
                <td>
                  <span className="muted tiny" title="CI not available on GitAtlas">
                    —
                  </span>
                </td>
                <td>
                  <AheadBehind row={row} />
                </td>
                <td>
                  <span className="muted tiny" title="Pull requests not available on GitAtlas">
                    —
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </section>
  );
}

export function BranchesView({
  prefix,
  label,
  ownerOpts,
  repo,
}: {
  prefix: string;
  label: string;
  ownerOpts?: RepoHrefOpts;
  repo: RepoPageData;
}) {
  const [tab, setTab] = useState<BranchTab>("overview");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void api
      .branches(prefix, label)
      .then((r) => {
        if (cancelled) return;
        setRows(r.branches);
        setNote(r.note ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const defaultName =
          repo.defaultBranch?.replace(/^refs\/heads\//, "") ?? "main";
        const fallback = repo.refs
          .filter((r) => r.name.startsWith("refs/heads/"))
          .map((r) => {
            const name = r.name.replace(/^refs\/heads\//, "");
            return {
              name,
              hash: r.hash,
              short: r.hash.slice(0, 7),
              isDefault: name === defaultName,
              author: null,
              date: null,
              behind: null,
              ahead: null,
              stale: false,
            } satisfies BranchRow;
          });
        setRows(fallback);
        if (fallback.length === 0) {
          setError(err instanceof Error ? err.message : String(err));
        } else {
          setNote(
            "Showing refs only — tip enrichment failed. Ahead/behind and dates may be empty.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, repo]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, query]);

  const defaults = filtered.filter((r) => r.isDefault);
  const active = filtered.filter((r) => !r.isDefault && !r.stale);
  const stale = filtered.filter((r) => !r.isDefault && r.stale);
  const overviewActive = active.slice(0, 8);

  return (
    <section className="gh-branches-page">
      <h2>Branches</h2>

      <nav className="gh-branch-tabs" aria-label="Branch views">
        {(
          [
            ["overview", "Overview"],
            ["active", "Active"],
            ["stale", "Stale"],
            ["all", "All"],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </nav>

      <label className="gh-branch-search">
        <SearchIcon />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search branches…"
          aria-label="Search branches"
        />
      </label>

      {busy ? (
        <PageLoadingOverlay
          skeleton="branches"
          message="Loading branch tips from Freenet…"
        />
      ) : null}
      {error && rows.length === 0 ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
      {note ? <p className="muted tiny">{note}</p> : null}

      {!busy ? (
        <>
          {tab === "overview" ? (
            <>
              <BranchTable
                title="Default"
                rows={defaults}
                prefix={prefix}
                label={label}
                ownerOpts={ownerOpts}
              />
              <BranchTable
                title="Active branches"
                rows={overviewActive}
                prefix={prefix}
                label={label}
                ownerOpts={ownerOpts}
                footer={
                  active.length > overviewActive.length ? (
                    <button
                      type="button"
                      className="gh-view-more"
                      onClick={() => setTab("active")}
                    >
                      View more branches →
                    </button>
                  ) : null
                }
              />
              {active.length === 0 && defaults.length > 0 ? (
                <p className="muted">No other active branches.</p>
              ) : null}
            </>
          ) : null}

          {tab === "active" ? (
            <BranchTable
              title="Active branches"
              rows={active}
              prefix={prefix}
              label={label}
              ownerOpts={ownerOpts}
            />
          ) : null}

          {tab === "stale" ? (
            <BranchTable
              title="Stale branches"
              rows={stale}
              prefix={prefix}
              label={label}
              ownerOpts={ownerOpts}
            />
          ) : null}

          {tab === "all" ? (
            <BranchTable
              title="All branches"
              rows={filtered}
              prefix={prefix}
              label={label}
              ownerOpts={ownerOpts}
            />
          ) : null}

          {!busy && filtered.length === 0 ? (
            <p className="muted">No branches match this filter.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
