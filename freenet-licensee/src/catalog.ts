import licensesJson from "./generated/licenses.json";
import type { LicenseMeta, LicensesCatalog } from "./types";

export const catalog = licensesJson as LicensesCatalog;

const bySpdx = new Map<string, LicenseMeta>();
for (const lic of Object.values(catalog.licenses)) {
  if (lic.spdx_id) bySpdx.set(lic.spdx_id.toLowerCase(), lic);
}

export function getLicense(keyOrSpdx: string): LicenseMeta | null {
  const k = keyOrSpdx.trim().toLowerCase();
  if (catalog.licenses[k]) return catalog.licenses[k]!;
  // keys may be mit vs MIT
  for (const [key, lic] of Object.entries(catalog.licenses)) {
    if (key.toLowerCase() === k) return lic;
  }
  return bySpdx.get(k) ?? null;
}

export function listLicenses(opts?: {
  featured?: boolean;
  includeHidden?: boolean;
}): LicenseMeta[] {
  let rows = Object.values(catalog.licenses);
  if (!opts?.includeHidden) rows = rows.filter((l) => !l.hidden);
  if (opts?.featured) rows = rows.filter((l) => l.featured);
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}
