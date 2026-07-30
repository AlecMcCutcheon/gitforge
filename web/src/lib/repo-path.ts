/**
 * Hub SPA repo URLs.
 *
 * Repo id is one segment `prefix~label` (slash broke nested Code/tree routes).
 * Owner scope:
 *   - ForgeRegistry owner known → `/{fingerprint-words}/{prefix~label}`
 *   - Unregistered / unknown  → `/r/{prefix~label}`
 *
 * freenet-git remotes stay `freenet::prefix/label`.
 */
import {
  fingerprintWordsJoined,
  looksLikeWordSlug,
} from "../freenet/fingerprint-words";

export const REPO_ID_SEP = "~" as const;
/** Universal bucket when ForgeRegistry owner is unknown. */
export const UNREGISTERED_REPO_ROOT = "r" as const;

const RESERVED_TOP = new Set([
  "work",
  "people",
  "account",
  "identity",
  "new",
  UNREGISTERED_REPO_ROOT,
]);

export function formatRepoId(prefix: string, label: string): string {
  return `${prefix.trim()}${REPO_ID_SEP}${label.trim()}`;
}

export function parseRepoId(
  repoId: string,
): { prefix: string; label: string } | null {
  const raw = repoId.trim();
  if (!raw) return null;
  const i = raw.indexOf(REPO_ID_SEP);
  if (i <= 0 || i === raw.length - 1) return null;
  try {
    return {
      prefix: decodeURIComponent(raw.slice(0, i)),
      label: decodeURIComponent(raw.slice(i + REPO_ID_SEP.length)),
    };
  } catch {
    return {
      prefix: raw.slice(0, i),
      label: raw.slice(i + REPO_ID_SEP.length),
    };
  }
}

export function isReservedHubTopSegment(segment: string): boolean {
  return RESERVED_TOP.has(segment);
}

export interface RepoHrefOpts {
  /** ForgeRegistry owner fingerprint → words path. */
  ownerFingerprint?: string | null;
  /** Already-resolved words slug (when fingerprint not on hand). */
  ownerSlug?: string | null;
}

/** Hub SPA href: `/r/prefix~label` or `/words/prefix~label` (+ optional subpath). */
export function repoHref(
  prefix: string,
  label: string,
  subpath = "",
  opts?: RepoHrefOpts,
): string {
  const id = formatRepoId(prefix, label);
  const fp = opts?.ownerFingerprint?.trim();
  const slug = opts?.ownerSlug?.trim();
  const base = fp
    ? `/${fingerprintWordsJoined(fp)}/${id}`
    : slug
      ? `/${slug}/${id}`
      : `/${UNREGISTERED_REPO_ROOT}/${id}`;
  const clean = subpath.replace(/^\//, "");
  return clean ? `${base}/${clean}` : base;
}

/** Display form matching the address bar. */
export function repoPathDisplay(
  prefix: string,
  label: string,
  opts?: RepoHrefOpts,
): string {
  return repoHref(prefix, label, "", opts);
}

export interface ParsedRepoRoute {
  prefix: string;
  label: string;
  /** Owner fingerprint-words slug when URL is `/{words}/{repoId}`. */
  ownerSlug: string | null;
  /** True when under `/r/…`. */
  unregisteredBucket: boolean;
  /** Remaining path after repo id (tree/…, blob/…). */
  rest: string[];
  /** Legacy flat `/prefix~label` (no /r/ or owner). */
  legacyFlat: boolean;
}

/**
 * Parse pathname segments (no leading empty). Returns null if not a repo URL.
 */
export function parseRepoRouteParts(
  parts: string[],
): ParsedRepoRoute | null {
  if (parts.length < 1) return null;
  const [head, ...tail] = parts;
  if (!head) return null;

  // `/r/{repoId}/…`
  if (head === UNREGISTERED_REPO_ROOT) {
    const repoId = tail[0];
    if (!repoId) return null;
    const parsed = parseRepoId(repoId);
    if (!parsed) return null;
    return {
      ...parsed,
      ownerSlug: null,
      unregisteredBucket: true,
      rest: tail.slice(1),
      legacyFlat: false,
    };
  }

  if (isReservedHubTopSegment(head)) return null;

  // `/{fingerprint-words}/{repoId}/…`
  if (looksLikeWordSlug(head) && tail[0]) {
    const parsed = parseRepoId(tail[0]);
    if (parsed) {
      return {
        ...parsed,
        ownerSlug: head,
        unregisteredBucket: false,
        rest: tail.slice(1),
        legacyFlat: false,
      };
    }
  }

  // Legacy flat `/prefix~label/…`
  const flat = parseRepoId(head);
  if (flat) {
    return {
      ...flat,
      ownerSlug: null,
      unregisteredBucket: false,
      rest: tail,
      legacyFlat: true,
    };
  }

  // Very old `/prefix/label/…` (slash form, no tilde in either segment)
  if (
    tail.length >= 1 &&
    !looksLikeWordSlug(head) &&
    !head.includes(REPO_ID_SEP) &&
    !tail[0]!.includes(REPO_ID_SEP)
  ) {
    try {
      return {
        prefix: head,
        label: decodeURIComponent(tail[0]!),
        ownerSlug: null,
        unregisteredBucket: false,
        rest: tail.slice(1),
        legacyFlat: true,
      };
    } catch {
      return {
        prefix: head,
        label: tail[0]!,
        ownerSlug: null,
        unregisteredBucket: false,
        rest: tail.slice(1),
        legacyFlat: true,
      };
    }
  }

  return null;
}

/**
 * Parse paste/search: `freenet::prefix/label`, `/r/prefix~label`,
 * `/words/prefix~label`, `/prefix/label`, or `/prefix~label`.
 */
export function parseForgeRepoRef(
  input: string,
): { prefix: string; label: string; ownerFingerprint?: string } | null {
  const trimmed = input.trim();
  const freenet =
    /^(?:freenet::|freenet:)?([1-9A-HJ-NP-Za-km-z]{8,24})(?:[/~]([A-Za-z0-9._-]+))?$/.exec(
      trimmed,
    );
  if (freenet) {
    return { prefix: freenet[1]!, label: freenet[2] ?? "repo" };
  }

  const unreg =
    /^\/?r\/([1-9A-HJ-NP-Za-km-z]{8,24})~([A-Za-z0-9._-]+)\/?$/.exec(trimmed);
  if (unreg) {
    return { prefix: unreg[1]!, label: unreg[2]! };
  }

  const owned =
    /^\/?([a-z]+(?:-[a-z]+){2,5})\/([1-9A-HJ-NP-Za-km-z]{8,24})~([A-Za-z0-9._-]+)\/?$/i.exec(
      trimmed,
    );
  if (owned && looksLikeWordSlug(owned[1]!)) {
    return { prefix: owned[2]!, label: owned[3]! };
  }

  const hub = /^\/?([1-9A-HJ-NP-Za-km-z]{8,24})[/~]([A-Za-z0-9._-]+)\/?$/.exec(
    trimmed,
  );
  if (hub) {
    return { prefix: hub[1]!, label: hub[2]! };
  }
  return null;
}

/** Encode a repo-relative file/dir path for tree/blob URLs (GitHub-style). */
export function encodeRepoFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Decode splat param from `tree/:branch/*` or `blob/:branch/*`. */
export function decodeRepoFilePath(splat: string | undefined): string {
  if (!splat) return "";
  return splat
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .filter(Boolean)
    .join("/");
}

/** `/…/tree/{branch}` or `/…/tree/{branch}/{path}`. */
export function repoTreeHref(
  prefix: string,
  label: string,
  branch: string,
  filePath = "",
  opts?: RepoHrefOpts,
): string {
  const base = `tree/${encodeURIComponent(branch)}`;
  const encoded = encodeRepoFilePath(filePath);
  return repoHref(prefix, label, encoded ? `${base}/${encoded}` : base, opts);
}

/** `/…/blob/{branch}/{path}` — GitHub-style file URL. */
export function repoBlobHref(
  prefix: string,
  label: string,
  branch: string,
  filePath: string,
  opts?: RepoHrefOpts,
): string {
  const encoded = encodeRepoFilePath(filePath);
  return repoHref(
    prefix,
    label,
    `blob/${encodeURIComponent(branch)}/${encoded}`,
    opts,
  );
}

/** `/…/raw/{branch}/{path}` — GitHub-style plain-text file URL. */
export function repoRawHref(
  prefix: string,
  label: string,
  branch: string,
  filePath: string,
  opts?: RepoHrefOpts,
): string {
  const encoded = encodeRepoFilePath(filePath);
  return repoHref(
    prefix,
    label,
    `raw/${encodeURIComponent(branch)}/${encoded}`,
    opts,
  );
}
