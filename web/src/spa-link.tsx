/**
 * React Router links that skip Freenet's navigation interceptor.
 *
 * Without `data-freenet-no-intercept`, every <a> click is turned into an
 * iframe.src reload (full SPA remount). That made GitAtlas→Discover feel
 * broken (cold identity probe) and repo clicks feel endless.
 */
import {
  Link as RrLink,
  NavLink as RrNavLink,
  type LinkProps,
  type NavLinkProps,
  useHref,
} from "react-router-dom";
import type { MouseEvent } from "react";
import { postShellHistory } from "./freenet/shell-history-sync";

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
