/**
 * Sync React Router path changes to the Freenet shell address bar without
 * remounting the iframe (shell message type `history`).
 *
 * Prefer `path` (router pathname within the contract) over absolute `href` —
 * the sandbox iframe's location/origin is unreliable for building outer URLs.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { forgeWebsiteBasename } from "./website-constants";
import { parseRepoRouteParts, repoHref } from "../lib/repo-path";

const WEBSITE_BASE_CACHE_KEY = "gitforge.website.base";

export function freenetBasename(): string {
  const fromPath = window.location.pathname.match(
    /^(\/v[12]\/contract\/web\/[^/]+)/,
  );
  if (fromPath?.[1]) {
    try {
      sessionStorage.setItem(WEBSITE_BASE_CACHE_KEY, fromPath[1]);
    } catch {
      /* sandbox may deny storage */
    }
    return fromPath[1];
  }
  try {
    const fromBase = document.baseURI.match(/(\/v[12]\/contract\/web\/[^/]+)/);
    if (fromBase?.[1]) return fromBase[1];
  } catch {
    /* ignore */
  }
  try {
    const cached = sessionStorage.getItem(WEBSITE_BASE_CACHE_KEY);
    if (cached) return cached;
  } catch {
    /* ignore */
  }
  // NEW CODE - TESTING: baked publish key so Raw/new-tab URLs never hit node root
  return forgeWebsiteBasename();
}

/** Absolute gateway path for the current SPA location (Discover ends with `/`). */
export function freenetShellHref(
  pathname: string,
  search = "",
  hash = "",
): string {
  const base = freenetBasename().replace(/\/$/, "");
  const rest = pathname === "/" ? "/" : pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${rest}${search}${hash}`;
}

/**
 * Full URL for opening SPA routes in a new tab (Raw, etc.).
 * Always includes `/v1/contract/web/<key>/` so Freenet serves the website.
 */
export function freenetAbsoluteAppHref(appPath: string): string {
  const path = appPath.startsWith("/") ? appPath : `/${appPath}`;
  const gatewayPath = freenetShellHref(path);
  const origin =
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://127.0.0.1:7509";
  return `${origin}${gatewayPath}`;
}

let lastPostedKey: string | null = null;

/**
 * Deep repo views (/tree/…, /blob/…) 404 if the Freenet shell treats them as
 * real contract paths. Keep the outer URL at the repo root; SPA still routes.
 */
function repoRootPathForShell(pathname: string): string {
  const parts = pathname.replace(/^\//, "").split("/").filter(Boolean);
  const parsed = parseRepoRouteParts(parts);
  if (!parsed || parsed.rest.length === 0) return pathname;
  const head = parsed.rest[0];
  if (
    head !== "tree" &&
    head !== "blob" &&
    head !== "raw" &&
    head !== "commits" &&
    head !== "branches" &&
    head !== "tags" &&
    head !== "new" &&
    head !== "upload" &&
    head !== "settings"
  ) {
    return pathname;
  }
  return repoHref(parsed.prefix, parsed.label, "", {
    ownerSlug: parsed.ownerSlug,
  });
}

/** Drop Freenet shell routing params — they belong on iframe.src, not the tab URL. */
function publicSearch(search: string): string {
  if (!search) return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  for (const key of [...params.keys()]) {
    if (key.startsWith("__sandbox") || key.startsWith("authToken")) {
      params.delete(key);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function postShellHistory(opts: {
  /** App path inside the contract, e.g. `/` or `/r/owner/repo`. */
  path: string;
  search?: string;
  hash?: string;
  replace?: boolean;
}): void {
  if (typeof window === "undefined") return;
  if (!window.parent || window.parent === window) return;
  const rawPath = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const path = rawPath;
  // NEW CODE - TESTING: never push /tree|/blob deep paths to Freenet shell
  const path = repoRootPathForShell(rawPath);
  const search = publicSearch(opts.search ?? "");
  const hash = opts.hash ?? "";
  const key = `${path}${search}${hash}`;
  if (lastPostedKey === key) return;
  lastPostedKey = key;
  try {
    window.parent.postMessage(
      {
        __freenet_shell__: true,
        type: "history",
        path,
        search,
        hash,
        href: freenetShellHref(path, search, hash),
        replace: opts.replace === true || path !== rawPath,
      },
      "*",
    );
  } catch {
    /* ignore */
  }
}

/** Mount once under BrowserRouter — keeps outer Freenet URL in sync with SPA. */
export function FreenetShellHistorySync(): null {
  const location = useLocation();
  const navType = useNavigationType();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const key = `${location.pathname}${location.search}${location.hash}`;
    if (lastKey.current === key) return;
    lastKey.current = key;

    // Freenet gateway 404s deep /raw/ on reload (#3841). Never push those into
    // the shell bar — keep root + ?raw= so the URL stays openable.
    const isDeepRaw = /(^|\/)raw\//.test(location.pathname);
    if (isDeepRaw) {
      const params = new URLSearchParams();
      params.set("raw", location.pathname);
      postShellHistory({
        path: "/",
        search: `?${params.toString()}`,
        hash: "",
        replace: true,
      });
      return;
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // postShellHistory(full pathname) — shell/prefetch GETs /tree/main → 404
    // (console "main:1") and can remount the iframe mid tip-load.
    // NEW CODE - TESTING: keep Freenet shell URL at repo root for deep views
    const shellPath = repoRootPathForShell(location.pathname);

    postShellHistory({
      path: shellPath,
      search: location.search,
      hash: location.hash,
      replace: navType === "POP" || navType === "REPLACE" || shellPath !== location.pathname,
    });
  }, [location, navType]);

  return null;
}
