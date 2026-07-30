/**
 * ForgeRegistry public_meta keys for cached primary language (Discover / pins).
 * Owner dual-sig upsert only — not visitor-writable.
 */
export const REGISTRY_META_LANG = "lang";
export const REGISTRY_META_LANG_COLOR = "lang_color";
export const REGISTRY_META_LANG_TIP = "lang_tip";
export const REGISTRY_META_LANG_AT = "lang_at";

export interface RegistryLanguageMeta {
  name: string;
  color: string;
  tip: string;
  at: string;
}

export function parseRegistryLanguage(
  meta: Record<string, string> | undefined | null,
): RegistryLanguageMeta | null {
  const name = (meta?.[REGISTRY_META_LANG] ?? "").trim();
  if (!name) return null;
  return {
    name: name.slice(0, 64),
    color: (meta?.[REGISTRY_META_LANG_COLOR] ?? "#858585").trim() || "#858585",
    tip: (meta?.[REGISTRY_META_LANG_TIP] ?? "").trim(),
    at: (meta?.[REGISTRY_META_LANG_AT] ?? "").trim(),
  };
}

export function applyLanguageToPublicMeta(
  meta: Record<string, string> | undefined | null,
  primary: { name: string; color: string | null },
  tipCommit: string,
): Record<string, string> {
  const next: Record<string, string> = { ...(meta ?? {}) };
  next[REGISTRY_META_LANG] = primary.name.trim().slice(0, 64);
  next[REGISTRY_META_LANG_COLOR] = (
    primary.color?.trim() || "#858585"
  ).slice(0, 32);
  next[REGISTRY_META_LANG_TIP] = tipCommit.trim().slice(0, 64);
  next[REGISTRY_META_LANG_AT] = new Date().toISOString();
  return next;
}

/** True when listing already has the same primary language for this tip. */
export function registryLanguageIsCurrent(
  meta: Record<string, string> | undefined | null,
  primaryName: string,
  tipCommit: string,
): boolean {
  const cur = parseRegistryLanguage(meta);
  if (!cur) return false;
  return (
    cur.name === primaryName.trim() &&
    cur.tip === tipCommit.trim() &&
    Boolean(cur.tip)
  );
}
