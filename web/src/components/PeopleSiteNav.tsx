import { useLocation } from "react-router-dom";
import { Link } from "../spa-link";

export type PeopleNavTab = "overview" | "repos" | "stars";

export interface PeopleRouteInfo {
  /** Path segment under `/people/` (word slug or freenet:id). */
  slug: string;
  tab: PeopleNavTab;
}

function tabFromQuery(raw: string | null): PeopleNavTab {
  if (raw === "repositories" || raw === "repos") return "repos";
  if (raw === "stars") return "stars";
  return "overview";
}

/** Detect `/people/{slug}` (Overview / Repositories / Stars). */
export function usePeopleRoute(): PeopleRouteInfo | null {
  const location = useLocation();
  const parts = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
  if (parts[0] !== "people" || !parts[1]) return null;
  let slug = parts[1];
  try {
    slug = decodeURIComponent(parts[1]);
  } catch {
    /* keep raw */
  }
  const tab = tabFromQuery(
    new URLSearchParams(location.search).get("tab"),
  );
  return { slug, tab };
}

function peopleHref(slug: string, tab: PeopleNavTab): string {
  const base = `/people/${encodeURIComponent(slug)}`;
  if (tab === "repos") return `${base}?tab=repositories`;
  if (tab === "stars") return `${base}?tab=stars`;
  return base;
}

function OverviewIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Z"
      />
      <path
        fill="currentColor"
        d="M7 4h5v1.5H7Zm0 3h5v1.5H7Zm0 3h5v1.5H7ZM4 4h1.5v1.5H4Zm0 3H5.5v1.5H4Zm0 3H5.5v1.5H4Z"
      />
    </svg>
  );
}

function ReposIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 10h8ZM4.5 1A1.5 1.5 0 0 0 3 2.5V7h1.5a.75.75 0 0 1 0 1.5H3v3.5A1.5 1.5 0 0 0 4.5 13.5h8.75V1.5Z"
      />
    </svg>
  );
}

function StarsIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"
      />
    </svg>
  );
}

/** Second row under GitAtlas — while viewing a person profile. */
export function PeopleSiteNav({ route }: { route: PeopleRouteInfo }) {
  const { slug, tab } = route;
  return (
    <nav className="repo-site-nav" aria-label="Profile">
      <div className="repo-site-nav-inner">
        <Link
          className={tab === "overview" ? "active" : ""}
          to={peopleHref(slug, "overview")}
        >
          <OverviewIcon />
          <span>Overview</span>
        </Link>
        <Link
          className={tab === "repos" ? "active" : ""}
          to={peopleHref(slug, "repos")}
        >
          <ReposIcon />
          <span>Repositories</span>
        </Link>
        <Link
          className={tab === "stars" ? "active" : ""}
          to={peopleHref(slug, "stars")}
        >
          <StarsIcon />
          <span>Stars</span>
        </Link>
      </div>
    </nav>
  );
}
