/** Shared ForgeRegistry listing shape (bridge JSON + WASM contract). */

export type HubAttestation = "local-bundle-v1" | "dual-sig-v1";

export interface ForgeRegistryEntry {
  schema_version: number;
  repo_prefix: string;
  label: string;
  name: string | null;
  description: string | null;
  /** Project / homepage URL (About). */
  website?: string | null;
  /** Custom tags (About / future Discover search). */
  topics?: string[];
  /** Adaptive Discover flags (SPA conventions). */
  public_meta?: Record<string, string>;
  identity_fingerprint: string;
  /** Unused for display (always empty on dual-sig listings). Use ForgeProfile. */
  identity_name: string;
  identity_email: string | null;
  /** Base58 repo owner VK — required for dual-sig-v1. */
  repo_owner_vk?: string | null;
  attestation: HubAttestation;
  /** Present when attestation is dual-sig-v1 (hex). */
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

/** Dual-signed soft-unregister (Discover drop). */
export interface ForgeRegistryRemove {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: HubAttestation;
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

/** Dual-signed contributor grant (accept invite → write self). */
export interface ForgeRegistryContributor {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: HubAttestation;
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

/** Pending collaborator invite (repo-level). */
export interface ForgeRegistryPendingInvite {
  schema_version: number;
  repo_prefix: string;
  /** Invitee fingerprint. */
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: HubAttestation | "invitee-decline-v1";
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

export interface ForgeRegistryState {
  schema_version: number;
  /** Keyed by repo_prefix */
  repos: Record<string, ForgeRegistryEntry>;
  /** Soft-delete tombstones keyed by repo_prefix */
  removed?: Record<string, ForgeRegistryRemove>;
  /** Accepted contributors: prefix → fingerprint → grant */
  contributors?: Record<string, Record<string, ForgeRegistryContributor>>;
  /** Outstanding invites: prefix → invitee fingerprint → invite */
  pending_invites?: Record<string, Record<string, ForgeRegistryPendingInvite>>;
}
