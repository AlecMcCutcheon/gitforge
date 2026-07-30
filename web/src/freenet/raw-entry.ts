/**
 * Freenet gateway 404s deep SPA paths on reload / new-tab
 * (freenet-core#3841). Raw file links therefore use the website root with a
 * `?raw=` query — the server returns index.html (200), then the SPA fetches
 * the tip pack and rewrites the document (best-effort “raw” on stock nodes).
 *
 * True HTTP text/plain needs a freenet-core `/v1/git/.../raw` route; we do not
 * use that for GitForge links (must work on any stock node).
 */
import { freenetBasename } from "./shell-history-sync";
import { forgeWebsiteBasename } from "./website-constants";

export const RAW_QUERY_PARAM = "raw";

/** Absolute GitForge URL that survives reload: `/v1/contract/web/KEY/?raw=/…/raw/…`. */
export function freenetRawFileHref(appRawPath: string): string {
  const path = appRawPath.startsWith("/") ? appRawPath : `/${appRawPath}`;
  const base = (freenetBasename() || forgeWebsiteBasename()).replace(
    /\/$/,
    "",
  );
  const origin =
    typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://127.0.0.1:7509";
  const qs = new URLSearchParams();
  qs.set(RAW_QUERY_PARAM, path);
  return `${origin}${base}/?${qs.toString()}`;
}

/** Read `?raw=` from the current location (iframe or top). */
export function peekRawQueryPath(
  search = typeof window !== "undefined" ? window.location.search : "",
): string | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = params.get(RAW_QUERY_PARAM)?.trim();
  if (!raw) return null;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export interface ParsedRawAppPath {
  /** Full app pathname including /raw/… */
  appPath: string;
  prefix: string;
  label: string;
  branch: string;
  filePath: string;
  ownerSlug: string | null;
}

/**
 * Parse GitForge raw app paths:
 * `/r/{prefix}~{label}/raw/{branch}/{file…}`
 * `/{words}/{prefix}~{label}/raw/{branch}/{file…}`
 * `/{prefix}~{label}/raw/{branch}/{file…}`
 */
export function parseRawAppPath(appPath: string): ParsedRawAppPath | null {
  const clean = appPath.split("?")[0]?.split("#")[0] ?? "";
  const parts = clean.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length < 4) return null;

  let ownerSlug: string | null = null;
  let repoId: string;
  let rest: string[];

  if (parts[0] === "r") {
    repoId = parts[1] ?? "";
    rest = parts.slice(2);
  } else if (parts[1]?.includes("~")) {
    ownerSlug = parts[0] ?? null;
    repoId = parts[1] ?? "";
    rest = parts.slice(2);
  } else if (parts[0]?.includes("~")) {
    repoId = parts[0] ?? "";
    rest = parts.slice(1);
  } else {
    return null;
  }

  if (rest[0] !== "raw" || !rest[1]) return null;
  const tilde = repoId.indexOf("~");
  if (tilde <= 0) return null;
  const prefix = repoId.slice(0, tilde);
  const label = repoId.slice(tilde + 1);
  if (!prefix || !label) return null;
  const branch = decodeURIComponent(rest[1]);
  const filePath = rest
    .slice(2)
    .map((p) => decodeURIComponent(p))
    .join("/");
  if (!filePath) return null;

  return {
    appPath: clean.startsWith("/") ? clean : `/${clean}`,
    prefix,
    label,
    branch,
    filePath,
    ownerSlug,
  };
}
