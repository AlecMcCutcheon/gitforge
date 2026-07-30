import { useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Link } from "../spa-link";
import {
  parseRepoRouteParts,
  repoHref,
  type RepoHrefOpts,
} from "../lib/repo-path";

type RepoTab = "code" | "commits" | "branches" | "tags" | "settings";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// | "releases" — GitHub-style releases UI (tags dressed as releases); removed
// until freenet-git / GitForge have a real release+actions story.

export interface RepoRouteInfo {
  prefix: string;
  label: string;
  branch: string;
  tab: RepoTab;
  ownerSlug: string | null;
  ownerOpts: RepoHrefOpts;
}

/** Detect `/r/{id}/…` or `/{words}/{id}/…` (not Discover / People / …). */
export function useRepoRoute(): RepoRouteInfo | null {
  const location = useLocation();
  const parts = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const parsed = parseRepoRouteParts(parts);
  if (!parsed) return null;

  const { prefix, label, ownerSlug, rest } = parsed;
  const restPath = rest.map(decodeURIComponent).join("/");
  const branchFromPath =
    /^(?:tree|blob|commits)\/([^/]+)/.exec(restPath)?.[1] ?? null;
  const branch = branchFromPath ? decodeURIComponent(branchFromPath) : "HEAD";

  let tab: RepoTab = "code";
  if (rest[0] === "commits") tab = "commits";
  else if (rest[0] === "branches") tab = "branches";
  else if (rest[0] === "tags") tab = "tags";
  else if (rest[0] === "settings") tab = "settings";
  // OLD: else if (rest[0] === "releases") tab = "tags"; — /releases is gone, not a tags alias

  return {
    prefix,
    label,
    branch,
    tab,
    ownerSlug,
    ownerOpts: ownerSlug ? { ownerSlug } : {},
  };
}

function CodeIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function BranchesIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

function TagsIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
      />
    </svg>
  );
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// function ReleasesIcon() { ... } — removed with Releases tab

/** Second row under GitForge — only while browsing a repo. */
export function RepoSiteNav({ route }: { route: RepoRouteInfo }) {
  const { prefix, label, branch, tab, ownerOpts } = route;
  const [settingsAllowed, setSettingsAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettingsAllowed(null);
    void (async () => {
      try {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // const reg = await api.registryLookup(prefix);
        // setSettingsAllowed(Boolean(reg));
        // NEW CODE - TESTING: local site-key holders get Settings; contract
        // create/heal runs in RepoBackupWorker (not here)
        const { isBrowserNativeMode } = await import("../tip-browse");
        if (isBrowserNativeMode()) {
          const { nativeListRepos } = await import("../freenet/owner-api");
          const local = await nativeListRepos();
          if (local.some((r) => r.prefix === prefix)) {
            if (!cancelled) setSettingsAllowed(true);
            return;
          }
        }
        const { api } = await import("../api");
        const reg = await api.registryLookup(prefix);
        if (!cancelled) setSettingsAllowed(Boolean(reg));
      } catch {
        if (!cancelled) setSettingsAllowed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  const treeHref =
    branch === "HEAD"
      ? repoHref(prefix, label, "", ownerOpts)
      : repoHref(
          prefix,
          label,
          `tree/${encodeURIComponent(branch)}`,
          ownerOpts,
        );

  const settingsEnabled = settingsAllowed === true;

  return (
    <nav className="repo-site-nav" aria-label="Repository">
      <div className="repo-site-nav-inner">
        <Link className={tab === "code" ? "active" : ""} to={treeHref}>
          <CodeIcon />
          <span>Code</span>
        </Link>
        <Link
          className={tab === "branches" ? "active" : ""}
          to={repoHref(prefix, label, "branches", ownerOpts)}
        >
          <BranchesIcon />
          <span>Branches</span>
        </Link>
        <Link
          className={tab === "tags" ? "active" : ""}
          to={repoHref(prefix, label, "tags", ownerOpts)}
        >
          <TagsIcon />
          <span>Tags</span>
        </Link>
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <Link
          className={tab === "releases" ? "active" : ""}
          to={repoHref(prefix, label, "releases", ownerOpts)}
        >
          <ReleasesIcon />
          <span>Releases</span>
        </Link>
        */}
        <span
          className="repo-tab-soon"
          title="Not on GitForge yet — needs real release artifacts + runners (see docs/12-future-releases-actions.md)"
        >
          Releases
        </span>
        <span className="repo-tab-soon" title="Not available on GitForge yet">
          Issues
        </span>
        <span className="repo-tab-soon" title="Not available on GitForge yet">
          Pull requests
        </span>
        {settingsEnabled ? (
          <Link
            className={tab === "settings" ? "active" : ""}
            to={repoHref(prefix, label, "settings", ownerOpts)}
          >
            <span>Settings</span>
          </Link>
        ) : (
          <span
            className="repo-tab-soon"
            title={
              settingsAllowed === false
                ? "Settings require the site key on this identity (or a GitForge listing)"
                : "Checking ownership…"
            }
          >
            Settings
          </span>
        )}
      </div>
    </nav>
  );
}
