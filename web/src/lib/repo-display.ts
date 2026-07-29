/** Slug used as freenet URL label (matches hub-identity CreateRepo / rename). */
export function slugRepoLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "repo";
  const slug = [...trimmed]
    .map((c) =>
      /[A-Za-z0-9._~-]/.test(c) ? c : "-",
    )
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "repo";
}

/** Prefer signed RepoState.name; fall back to URL label / registry label. */
export function repoDisplayName(
  name: string | null | undefined,
  fallbackLabel: string,
): string {
  const n = name?.trim();
  if (n) return n;
  return fallbackLabel;
}
