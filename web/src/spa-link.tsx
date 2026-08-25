/**
 * React Router links that skip Freenet's navigation interceptor.
 *
 * Without `data-freenet-no-intercept`, every <a> click is turned into an
 * iframe.src reload (full SPA remount). That made GitForge→Discover feel
 * broken (cold identity probe) and repo clicks feel endless.
 *
 * Exception: Discover → repo must remount (see ColdRepoLink). Soft SPA nav
 * keeps Discover's in-flight soft GETs on the shared WS and sticks on
 * "Reading refs"; pasting the repo URL / reload is fast.
 */
import {
  Link as RrLink,
  NavLink as RrNavLink,
  type LinkProps,
  type NavLinkProps,
  useHref,
} from "react-router-dom";
import type { MouseEvent, ReactNode } from "react";
import {
  freenetAbsoluteAppHref,
  postShellHistory,
} from "./freenet/shell-history-sync";
import { isBrowserNativeMode } from "./tip-browse";

// Must be a truthy string — interceptor checks `dataset.freenetNoIntercept`
// with a truthy test, so `""` would still remount the iframe.
const SPA = { "data-freenet-no-intercept": "true" } as const;

/** Turn useHref() result into contract-relative path + search + hash. */
function appLocationFromHref(href: string): {
  path: string;
  search: string;
  hash: string;
} {
  let path = href;
  let search = "";
  let hash = "";
  const h = href.indexOf("#");
  if (h >= 0) {
    hash = href.slice(h);
    path = href.slice(0, h);
  }
  const q = path.indexOf("?");
  if (q >= 0) {
    search = path.slice(q);
    path = path.slice(0, q);
  }
  const basem = window.location.pathname.match(
    /^(\/v[12]\/contract\/web\/[^/]+)/,
  );
  const base = basem?.[1] ?? "";
  if (base && path.startsWith(base)) {
    path = path.slice(base.length) || "/";
  }
  if (!path.startsWith("/")) path = `/${path}`;
  return { path, search, hash };
}

function syncShellOnClick(
  href: string,
  replace: boolean | undefined,
  onClick: LinkProps["onClick"] | NavLinkProps["onClick"],
  e: MouseEvent<HTMLAnchorElement>,
): void {
  onClick?.(e);
  if (e.defaultPrevented) return;
  // Eager shell address-bar sync (don't wait for useEffect / navType).
  const loc = appLocationFromHref(href);
  postShellHistory({ ...loc, replace: replace === true });
}

export function Link(props: LinkProps) {
  const { onClick, to, replace, ...rest } = props;
  const href = useHref(to);
  return (
    <RrLink
      {...SPA}
      {...rest}
      to={to}
      replace={replace}
      onClick={(e) => syncShellOnClick(href, replace, onClick, e)}
    />
  );
}

export function NavLink(props: NavLinkProps) {
  const { onClick, to, replace, ...rest } = props;
  const href = useHref(to);
  return (
    <RrNavLink
      {...SPA}
      {...rest}
      to={to}
      replace={replace}
      onClick={(e) => syncShellOnClick(href, replace, onClick, e)}
    />
  );
}

/**
 * Discover → repo: allow Freenet to remount the iframe at this path (same as
 * pasting the URL). Do not use for in-repo links (those stay on soft Link).
 */
export function ColdRepoLink(props: {
  to: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const { to, className, children } = props;
  // Vite / non-website: soft SPA is fine (no Freenet iframe WS hang).
  if (!isBrowserNativeMode()) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // <Link data-freenet-no-intercept> — soft nav from Discover stuck loading
  // NEW CODE - TESTING: plain <a> so Freenet interceptor remounts cleanly
  return (
    <a href={freenetAbsoluteAppHref(to)} className={className}>
      {children}
    </a>
  );
}

/** Programmatic Discover "Open" — same cold remount as ColdRepoLink. */
export function coldNavigateToRepo(appPath: string): void {
  if (!isBrowserNativeMode()) {
    window.location.assign(appPath);
    return;
  }
  window.location.assign(freenetAbsoluteAppHref(appPath));
}
