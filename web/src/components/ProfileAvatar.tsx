import { VaultIdenticon } from "./VaultIdenticon";
import { normalizeProfileAvatar } from "../lib/avatar-image";

interface ProfileAvatarProps {
  /** Canonical freenet:id:… fingerprint — identicon seed (not username). */
  fingerprint?: string | null;
  /** @deprecated Prefer fingerprint; kept for vault-id fallback. */
  vaultId?: string;
  /**
   * ForgeProfile avatar field. Only user-uploaded raster data-URLs are shown;
   * empty / SVG / anything else → live fingerprint identicon.
   */
  avatarUrl?: string | null;
  size?: number;
  className?: string;
  title?: string;
}

/**
 * Custom uploaded photo, or GitHub-style identicon from fingerprint
 * (joric/identicons). Procedural icons are never stored on ForgeProfile.
 */
export function ProfileAvatar({
  fingerprint,
  vaultId,
  avatarUrl,
  size = 32,
  className,
  title,
}: ProfileAvatarProps) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (avatarUrl) { return <img src={avatarUrl} … /> }
  // NEW CODE - TESTING: ignore non-upload avatar values so generator stays live
  const custom = normalizeProfileAvatar(avatarUrl);
  if (custom) {
    return (
      <img
        src={custom}
        alt={title ?? "Profile"}
        width={size}
        height={size}
        className={className}
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // style={{ width: size, height: size, objectFit: "cover" }}
        // — inline px overrode CSS (.settings-avatar-img 200px, .profile-avatar
        // 120px) while VaultIdenticon respected the class → upload looked smaller.
        // NEW CODE - TESTING: attributes + object-fit only; CSS class owns display size
        style={{ objectFit: "cover" }}
      />
    );
  }
  const seed = (fingerprint || vaultId || "").trim();
  if (!seed) {
    return (
      <span className={className} style={{ width: size, height: size }} />
    );
  }
  return (
    <VaultIdenticon
      seed={seed}
      size={size}
      className={className}
      title={title}
    />
  );
}
