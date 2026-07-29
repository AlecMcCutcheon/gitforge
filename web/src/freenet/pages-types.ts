/**
 * Public Pages metadata stored on RepoState extension key `pages` (UTF-8 JSON).
 * Matches docs/09-hub-pages.md.
 */

export const REPO_PAGES_EXTENSION_KEY = "pages";

export interface RepoPagesMeta {
  enabled: boolean;
  contract_key: string | null;
  branch: string;
  root_path: string;
  last_commit: string | null;
  updated_at: string | null;
  verifying_key_hex?: string | null;
  /** GitAtlas identity fingerprint that enabled Pages (registry owner). */
  identity_fingerprint?: string | null;
}

export function emptyRepoPagesMeta(
  branch = "main",
  rootPath = "",
): RepoPagesMeta {
  return {
    enabled: false,
    contract_key: null,
    branch,
    root_path: rootPath,
    last_commit: null,
    updated_at: null,
    verifying_key_hex: null,
    identity_fingerprint: null,
  };
}

export function parseRepoPagesMeta(raw: unknown): RepoPagesMeta | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    try {
      obj = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return {
    enabled: Boolean(o.enabled),
    contract_key:
      typeof o.contract_key === "string" && o.contract_key.trim()
        ? o.contract_key.trim()
        : null,
    branch:
      typeof o.branch === "string" && o.branch.trim()
        ? o.branch.trim()
        : "main",
    root_path: typeof o.root_path === "string" ? o.root_path.trim() : "",
    last_commit:
      typeof o.last_commit === "string" && o.last_commit.trim()
        ? o.last_commit.trim().toLowerCase()
        : null,
    updated_at:
      typeof o.updated_at === "string" && o.updated_at.trim()
        ? o.updated_at.trim()
        : null,
    verifying_key_hex:
      typeof o.verifying_key_hex === "string" && o.verifying_key_hex.trim()
        ? o.verifying_key_hex.trim().toLowerCase()
        : null,
    identity_fingerprint:
      typeof o.identity_fingerprint === "string" &&
      o.identity_fingerprint.trim()
        ? o.identity_fingerprint.trim()
        : null,
  };
}

export function serializeRepoPagesMeta(meta: RepoPagesMeta): string {
  return JSON.stringify({
    enabled: meta.enabled,
    contract_key: meta.contract_key,
    branch: meta.branch,
    root_path: meta.root_path,
    last_commit: meta.last_commit,
    updated_at: meta.updated_at,
    verifying_key_hex: meta.verifying_key_hex ?? null,
    identity_fingerprint: meta.identity_fingerprint ?? null,
  });
}

/** Local-only autoSync preference (not on RepoState). */
export function pagesAutoSyncStorageKey(prefix: string): string {
  return `gitatlas.pages.autosync.${prefix}`;
}

export function loadPagesAutoSync(prefix: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(pagesAutoSyncStorageKey(prefix));
    if (raw == null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

export function savePagesAutoSync(prefix: string, autoSync: boolean): void {
  try {
    localStorage.setItem(
      pagesAutoSyncStorageKey(prefix),
      autoSync ? "1" : "0",
    );
  } catch {
    /* ignore quota */
  }
}

function pagesMetaStorageKey(prefix: string): string {
  return `gitatlas.pages.meta.${prefix}`;
}

/** Local mirror of RepoState pages (fallback until decode-wasm exposes `pages`). */
export function savePagesMetaLocal(prefix: string, meta: RepoPagesMeta): void {
  try {
    localStorage.setItem(pagesMetaStorageKey(prefix), serializeRepoPagesMeta(meta));
  } catch {
    /* ignore */
  }
}

export function loadPagesMetaLocal(prefix: string): RepoPagesMeta | null {
  try {
    const raw = localStorage.getItem(pagesMetaStorageKey(prefix));
    return parseRepoPagesMeta(raw);
  } catch {
    return null;
  }
}

export function websiteKeyNameFor(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 24) || "repo";
  return `hub-pages-${safe}`;
}

export function pagesSiteUrl(contractKey: string): string {
  const base =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: { VITE_FREENET_PAGES_BASE?: string } }).env
        ?.VITE_FREENET_PAGES_BASE) ||
    "http://127.0.0.1:7509/v1/contract/web";
  return `${base.replace(/\/$/, "")}/${contractKey}/`;
}
