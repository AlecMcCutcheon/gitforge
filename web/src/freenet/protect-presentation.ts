/**
 * Build Freenet shell Pin presentation (ProtectPresentation) + GitForge custom_css.
 */

import { brandLogoDataUrl } from "../components/BrandLogo";
import { vaultIdenticonDataUrl } from "../components/VaultIdenticon";
import { normalizeProfileAvatar } from "../lib/avatar-image";
import { brand } from "../lib/brand";
import { getCachedIdentity, getCachedProfile } from "./auth-api";
import { FORGE_WEBSITE_CONTRACT_KEY } from "./website-constants";
import type { ProtectPresentation, ProtectScopeItem } from "./local-protect";

/** @deprecated Prefer brandLogoDataUrl() — kept for any stale imports. */
export const FORGE_APP_LOGO_DATA_URL = brandLogoDataUrl();

/**
 * GitForge-tinted OAuth chrome (no url/@import — server rejects those).
 * Distinct from Freenet default blue-gray so Authorize cards read as this app.
 */
export const FORGE_PROTECT_OVERLAY_CSS = `
#__freenet_perm_overlay .fn-oauth.fn-card{
  border-radius:12px;
  border-color:#d0d7de;
}
#__freenet_perm_overlay .fn-oauth .fn-oauth-title{
  letter-spacing:-0.02em;
  font-weight:700;
  color:#1f2328;
}
#__freenet_perm_overlay .fn-oauth .fn-oauth-sub{color:#656d76;}
#__freenet_perm_overlay .fn-oauth .fn-oauth-logo{
  border:1px solid #d0d7de;
  background:#ffffff;
}
#__freenet_perm_overlay .fn-oauth .fn-oauth-scopes{
  border-radius:8px;
  border-color:#d0d7de;
  background:#f6f8fa;
}
#__freenet_perm_overlay .fn-oauth .fn-oauth-scope-label{color:#1f2328;}
#__freenet_perm_overlay .fn-oauth .fn-btn.primary{
  background:#1f6feb;
  border-color:#1f6feb;
  border-radius:6px;
  font-weight:600;
}
#__freenet_perm_overlay .fn-oauth .fn-btn:not(.primary){
  border-radius:6px;
  background:#f6f8fa;
  border-color:#d0d7de;
}
#__freenet_perm_overlay .fn-oauth .fn-oauth-footer{
  background:#f6f8fa;
  border:1px solid #d0d7de;
  color:#656d76;
}
@media (prefers-color-scheme: dark){
  #__freenet_perm_overlay .fn-oauth.fn-card{border-color:#30363d;}
  #__freenet_perm_overlay .fn-oauth .fn-oauth-title{color:#e6edf3;}
  #__freenet_perm_overlay .fn-oauth .fn-oauth-sub{color:#8b949e;}
  #__freenet_perm_overlay .fn-oauth .fn-oauth-logo{
    border-color:#30363d;
    background:#0d1117;
  }
  #__freenet_perm_overlay .fn-oauth .fn-oauth-scopes{
    border-color:#30363d;
    background:#161b22;
  }
  #__freenet_perm_overlay .fn-oauth .fn-oauth-scope-label{color:#e6edf3;}
  #__freenet_perm_overlay .fn-oauth .fn-btn:not(.primary){
    background:#21262d;
    border-color:#30363d;
    color:#e6edf3;
  }
  #__freenet_perm_overlay .fn-oauth .fn-oauth-footer{
    background:#161b22;
    border-color:#30363d;
    color:#8b949e;
  }
}
`;

export interface BuildPresentationOpts {
  title: string;
  subtitle?: string;
  appName?: string;
  contractId?: string;
  userAvatarDataUrl?: string | null;
  fingerprint?: string | null;
  scopes: ProtectScopeItem[];
  redirectHint?: string;
  includeCustomCss?: boolean;
}

/** Prefer custom Hub avatar; else fingerprint identicon (same as ProfileAvatar). */
export function resolveProtectAvatarDataUrl(
  avatarUrl?: string | null,
  fingerprint?: string | null,
): string | undefined {
  const custom = normalizeProfileAvatar(avatarUrl);
  if (custom) return custom;
  const fp =
    (fingerprint ?? "").trim() ||
    getCachedIdentity()?.fingerprint?.trim() ||
    "";
  if (fp) return vaultIdenticonDataUrl(fp);
  return undefined;
}

/** Resolve avatar from explicit args or signed-in cache. */
export function currentProtectAvatarDataUrl(
  overrideAvatar?: string | null,
  overrideFingerprint?: string | null,
): string | undefined {
  const avatar =
    overrideAvatar ?? getCachedProfile()?.avatar ?? null;
  const fp =
    overrideFingerprint ?? getCachedIdentity()?.fingerprint ?? null;
  return resolveProtectAvatarDataUrl(avatar, fp);
}

export function buildProtectPresentation(
  opts: BuildPresentationOpts,
): ProtectPresentation {
  return {
    title: opts.title,
    subtitle: opts.subtitle,
    app_name: opts.appName ?? brand.displayName,
    app_logo_b64: brandLogoDataUrl(),
    user_avatar_b64: currentProtectAvatarDataUrl(
      opts.userAvatarDataUrl,
      opts.fingerprint,
    ),
    contract_id: opts.contractId ?? FORGE_WEBSITE_CONTRACT_KEY,
    scopes: opts.scopes,
    custom_css:
      opts.includeCustomCss === false
        ? undefined
        : FORGE_PROTECT_OVERLAY_CSS.trim(),
    redirect_hint: opts.redirectHint,
  };
}

export function layerAPresentation(
  userAvatarDataUrl?: string | null,
  fingerprint?: string | null,
): ProtectPresentation {
  return buildProtectPresentation({
    title: `Authorize ${brand.displayName}`,
    subtitle: "wants to use pinning on this Freenet node",
    userAvatarDataUrl,
    fingerprint,
    scopes: [
      {
        id: "protect_api",
        label: "Pin APIs",
        access: "capability",
        detail:
          "Request scoped pin grants you approve. Does not pin contracts by itself.",
      },
      {
        id: "scopes",
        label: "Scoped grants",
        access: "request",
        detail:
          "Profile, vault, site files, and repositories — each needs its own Authorize.",
      },
    ],
    redirectHint: "Authorizing enables Pin scope requests for this site.",
  });
}

export function identityScopePresentation(
  area: "profile" | "vault" | "website",
  anchorKey: string,
  userAvatarDataUrl?: string | null,
  fingerprint?: string | null,
): ProtectPresentation {
  const labels = {
    profile: "Public profile",
    vault: "Account vault",
    website: `${brand.displayName} site files`,
  } as const;
  return buildProtectPresentation({
    title: `Authorize ${labels[area]}`,
    subtitle: "Pin scope on this node",
    contractId: anchorKey,
    userAvatarDataUrl,
    fingerprint,
    scopes: [
      {
        id: area,
        label: labels[area],
        access: "pin",
        detail: `Keep the ${labels[area].toLowerCase()} contract warm on this node (single-anchor scope).`,
      },
    ],
  });
}

export function repoScopePresentation(
  repoLabel: string,
  anchorKey: string,
  retention: string,
  userAvatarDataUrl?: string | null,
  fingerprint?: string | null,
): ProtectPresentation {
  return buildProtectPresentation({
    title: `Authorize pinning for ${repoLabel}`,
    subtitle: "Repository scope + tip-pack membership",
    contractId: anchorKey,
    userAvatarDataUrl,
    fingerprint,
    scopes: [
      {
        id: "repo_anchor",
        label: "Repository contract",
        access: "pin",
        detail: "Keep the repo state contract warm on this node.",
      },
      {
        id: "tip_packs",
        label: "Tip packs",
        access: "sync members",
        detail: `Auto pin/unpin tip packs that make up the live tip graph on parent state (retention: ${retention}). Chronologically older packs stay pinned while still in use.`,
      },
    ],
    redirectHint: "New tips re-sync under this scope without asking again.",
  });
}
