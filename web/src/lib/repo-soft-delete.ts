/**
 * Soft-delete / tombstone detection for freenet-git repos.
 * Order: extension `deleted` → tip root `DELETED` → description `[deleted]`.
 * See docs/13-repo-soft-delete.md.
 */

export interface SoftDeleteInfo {
  deleted: boolean;
  /** Why we believe it is deleted. */
  source: "extension" | "tip-file" | "description" | null;
  /** ISO timestamp from extension JSON when available. */
  at: string | null;
}

function parseDeletedAt(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { at?: unknown };
    return typeof j.at === "string" ? j.at : null;
  } catch {
    return null;
  }
}

export function softDeleteFromSummary(summary: {
  deleted?: string | null;
  description?: string | null;
}): SoftDeleteInfo {
  const ext = (summary.deleted ?? "").trim();
  if (ext) {
    return {
      deleted: true,
      source: "extension",
      at: parseDeletedAt(ext),
    };
  }
  const desc = (summary.description ?? "").trim();
  if (desc.toLowerCase().startsWith("[deleted]")) {
    return { deleted: true, source: "description", at: null };
  }
  return { deleted: false, source: null, at: null };
}

export function softDeleteFromTipFile(hasDeletedFile: boolean): SoftDeleteInfo {
  if (!hasDeletedFile) {
    return { deleted: false, source: null, at: null };
  }
  return { deleted: true, source: "tip-file", at: null };
}

/** Merge detection results; prefer stronger signals. */
export function mergeSoftDelete(
  a: SoftDeleteInfo,
  b: SoftDeleteInfo,
): SoftDeleteInfo {
  if (!a.deleted && !b.deleted) return a;
  const rank = (s: SoftDeleteInfo["source"]) =>
    s === "extension" ? 3 : s === "tip-file" ? 2 : s === "description" ? 1 : 0;
  return rank(a.source) >= rank(b.source) ? a : b;
}
