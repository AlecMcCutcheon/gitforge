/**
 * When Pages is disabled, clear ForgeRegistry About.website if it still points
 * at this repo’s Pages site URL (owner opted in via “Use the same as Pages”).
 */
import type { ForgePagesConfig } from "../api";

function normalizeWebsiteUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

export function websitesMatchPagesUrl(
  website: string | null | undefined,
  pagesSiteUrl: string | null | undefined,
): boolean {
  const a = normalizeWebsiteUrl(website ?? "");
  const b = normalizeWebsiteUrl(pagesSiteUrl ?? "");
  if (!a || !b) return false;
  return a === b;
}

/**
 * Best-effort: after Pages disable, drop About website when it matches the
 * Pages URL. Does not throw — disable already succeeded.
 */
export async function clearAboutWebsiteIfMatchesPages(
  prefix: string,
  label: string,
  pagesCfg: ForgePagesConfig,
): Promise<void> {
  const pagesUrl = pagesCfg.siteUrl;
  if (!pagesUrl) return;
  try {
    const { fetchForgeRegistry } = await import("./forge-registry");
    const { loadRegistryCached } = await import("./discover-cache");
    const repos = await loadRegistryCached(() => fetchForgeRegistry());
    const hit = repos.find((r) => r.repo_prefix === prefix);
    if (!hit || !websitesMatchPagesUrl(hit.website, pagesUrl)) return;
    const { nativeUpdateRepoAbout } = await import("./owner-api");
    await nativeUpdateRepoAbout({
      prefix,
      label: label || hit.label,
      name: hit.name,
      description: hit.description ?? "",
      website: null,
      topics: hit.topics ?? [],
    });
  } catch (err) {
    console.warn(
      "[pages] clear About website after disable failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
