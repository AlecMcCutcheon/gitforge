/**
 * GitHub-style “branch had recent pushes” notice on the default-branch Code view.
 * Ahead/behind comes from tipped pack first-parent walks (nativeBranches).
 * No PR flow yet — CTA is a Coming soon placeholder until Phase 2 contracts.
 */
import { useEffect, useState } from "react";
import { api, type BranchRow } from "../api";
import { Link } from "../spa-link";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";

function relativeTime(iso: string): string {
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

function BranchGlyph() {
  return (
    <svg
      className="octicon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

/** Prefer recent tip date, then largest ahead count. */
function pickDivergedBranch(rows: BranchRow[]): BranchRow | null {
  const candidates = rows.filter(
    (r) => !r.isDefault && r.ahead != null && r.ahead > 0,
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const at = a.date ? Date.parse(a.date) : 0;
    const bt = b.date ? Date.parse(b.date) : 0;
    if (bt !== at) return bt - at;
    return (b.ahead ?? 0) - (a.ahead ?? 0);
  });
  return candidates[0] ?? null;
}

export function BranchDivergenceBanner({
  prefix,
  label,
  currentRef,
  defaultBranch,
  ownerOpts,
}: {
  prefix: string;
  label: string;
  /** Branch currently shown on Code. */
  currentRef: string;
  defaultBranch: string;
  ownerOpts?: RepoHrefOpts;
}) {
  const [row, setRow] = useState<BranchRow | null>(null);
  const [defaultName, setDefaultName] = useState(defaultBranch);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const onDefault =
    currentRef === defaultBranch ||
    currentRef === defaultName ||
    currentRef === "HEAD";

  useEffect(() => {
    if (!onDefault) {
      setRow(null);
      return;
    }
    let cancelled = false;
    void api
      .branches(prefix, label)
      .then((res) => {
        if (cancelled) return;
        setDefaultName(res.defaultBranch || defaultBranch);
        setRow(pickDivergedBranch(res.branches));
      })
      .catch(() => {
        if (!cancelled) setRow(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, onDefault, defaultBranch]);

  if (!onDefault || !row || row.ahead == null || row.ahead <= 0) {
    return null;
  }

  const dismissId = `${prefix}:${row.name}:${row.hash}`;
  if (dismissedKey === dismissId) return null;

  const ahead = row.ahead;
  const when = row.date ? relativeTime(row.date) : null;
  const branchesHref = repoHref(prefix, label, "branches", ownerOpts);

  return (
    <div className="gh-branch-notice" role="status">
      <div className="gh-branch-notice-main">
        <BranchGlyph />
        <p className="gh-branch-notice-text">
          <Link
            className="gh-branch-notice-name"
            to={repoHref(
              prefix,
              label,
              `tree/${encodeURIComponent(row.name)}`,
              ownerOpts,
            )}
          >
            {row.name}
          </Link>
          {when ? (
            <>
              {" "}
              had recent pushes <span className="muted">{when}</span>
            </>
          ) : (
            <>
              {" "}
              is{" "}
              <strong>
                {ahead} commit{ahead === 1 ? "" : "s"}
              </strong>{" "}
              ahead of <span className="mono">{defaultName}</span>
            </>
          )}
          {when ? (
            <>
              {" "}
              ·{" "}
              <strong>
                {ahead} commit{ahead === 1 ? "" : "s"}
              </strong>{" "}
              ahead of <span className="mono">{defaultName}</span>
            </>
          ) : null}
          .{" "}
          <Link className="gh-branch-notice-link" to={branchesHref}>
            View branches
          </Link>
        </p>
      </div>
      <div className="gh-branch-notice-actions">
        <button
          type="button"
          className="btn gh-branch-notice-pr"
          disabled
          title="Pull requests need Phase 2 proposal contracts"
        >
          Compare &amp; pull request
          <span className="gh-branch-notice-soon">Coming soon</span>
        </button>
        <button
          type="button"
          className="gh-branch-notice-dismiss"
          aria-label="Dismiss"
          onClick={() => setDismissedKey(dismissId)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
