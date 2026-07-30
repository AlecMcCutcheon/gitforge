/**
 * GitForge product brand — single source for display names, CLI name, and soft ID prefixes.
 *
 * Change values here for a future rebrand. Contract params / signing domains live in
 * owner-constants / vault-crypto / contracts (wire slug `gitforge`).
 */
export const brand = {
  displayName: "GitForge",
  cliName: "gitforge",
  registryName: "GitForge Registry",
  registryAbbrev: "GFR",
  about:
    "Git forge for Freenet — browse and publish freenet-git repos without a central server.",
  /** Protect grant_id prefix (`gitforge:repo:…`). */
  protectGrantPrefix: "gitforge",
  /** API key env vars (first wins). */
  envApiKey: ["GITFORGE_API_KEY", "GATK"] as const,
  /** Wire product slug in contract params. */
  wireProductSlug: "gitforge",
} as const;

export type Brand = typeof brand;

/** `GitForge Registry (GFR)` */
export function registryLabel(): string {
  return `${brand.registryName} (${brand.registryAbbrev})`;
}

/** Protect grant id helpers. */
export function protectIdentityGrantId(
  area: "profile" | "vault" | "website",
): string {
  return `${brand.protectGrantPrefix}:identity:${area}`;
}

export function protectRepoGrantId(prefix: string): string {
  return `${brand.protectGrantPrefix}:repo:${prefix}`;
}

export function protectLegacyGrantId(key: string): string {
  return `${brand.protectGrantPrefix}:legacy:${key}`;
}

/** Grant ids for an identity area (single current spelling). */
export function protectIdentityGrantIds(
  area: "profile" | "vault" | "website",
): string[] {
  return [`${brand.protectGrantPrefix}:identity:${area}`];
}

/** Grant ids for a repo prefix (single current spelling). */
export function protectRepoGrantIds(prefix: string): string[] {
  return [`${brand.protectGrantPrefix}:repo:${prefix}`];
}

/** True if grant_id uses the brand Protect prefix. */
export function isProtectGrantId(grantId: string): boolean {
  return grantId.startsWith(`${brand.protectGrantPrefix}:`);
}
