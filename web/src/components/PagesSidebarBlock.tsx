import { useEffect, useState } from "react";
import { api, type ForgePagesConfig } from "../api";
import { Link } from "../spa-link";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";

function publicStatusLabel(pages: ForgePagesConfig | null): string {
  if (!pages?.enabled) return "Disabled";
  if (pages.status === "publishing") return "Publishing";
  if (pages.status === "error") return "Error";
  if (pages.status === "ready") return "Enabled";
  return pages.status || "Enabled";
}

export function PagesSidebarBlock({
  prefix,
  label,
  ownerOpts,
  isOwner,
  registered = false,
  isRegistryOwner = false,
}: {
  prefix: string;
  label: string;
  ownerOpts?: RepoHrefOpts;
  isOwner: boolean;
  /** Listed on GitForge ForgeRegistry. */
  registered?: boolean;
  /** Current identity owns the ForgeRegistry listing. */
  isRegistryOwner?: boolean;
}) {
  const [pages, setPages] = useState<ForgePagesConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Status fetch + autoSync for managers; Enable/Sync/Disable lived in sidebar.
    // NEW CODE - TESTING: sidebar is status-only (manage under Settings → Pages)
    void api
      .pages(prefix, label, false)
      .then((row) => {
        if (!cancelled) setPages(row);
      })
      .catch(() => {
        if (!cancelled) setPages(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label]);

  if (loading) {
    return (
      <section
        className="gh-side-block skel-side-block"
        aria-busy="true"
        aria-label="Loading Pages"
      >
        <span className="skel-bone skel-bone--md" style={{ width: "3.5rem" }} />
        <div className="skel-side-block__body">
          <span className="skel-bone skel-bone--line" style={{ width: "90%" }} />
          <span className="skel-bone skel-bone--line" style={{ width: "70%" }} />
        </div>
      </section>
    );
  }

  const enabled = Boolean(pages?.enabled);
  const status = pages?.status ?? "off";
  const statusClass = enabled
    ? status === "error"
      ? "error"
      : "ready"
    : "off";

  const settingsHref = `${repoHref(prefix, label, "settings", ownerOpts)}?tab=pages`;
  // Settings UI is owner-gated; Pages mutations need registry ownership too.
  const showSettingsLink = isOwner;

  return (
    <section className="gh-side-block">
      <h3>Pages</h3>
      <ul className="gh-side-list">
        <li>
          <span className="muted">Status</span>
          <span className={`gh-pages-status ${statusClass}`}>
            {publicStatusLabel(pages)}
          </span>
        </li>
      </ul>
      {showSettingsLink ? (
        <p className="muted tiny gh-pages-sidebar-link">
          <Link to={settingsHref}>Pages settings</Link>
        </p>
      ) : null}
      {isOwner && (!registered || !isRegistryOwner) ? (
        <p className="muted tiny">
          {!registered
            ? "Register this repository on GitForge before enabling Pages."
            : "Only the GitForge registry owner can enable or update Pages."}
        </p>
      ) : null}
    </section>
  );
}
