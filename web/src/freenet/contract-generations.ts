/**
 * Contract / delegate generation registry for GitForge hub tools.
 *
 * Generation N is the current published WASM set after adaptive-contracts
 * foresight (profile v3, registry register.v2, ForgeRepoMeta v1).
 * Future WASM bumps add N+1; migrate = re-sign onto the current generation.
 * Multi-gen soft-GET is not required yet (clean break OK while sole user).
 *
 * Hashes in owner-constants.ts are the live build; this table records the
 * semantic generation id and schema domains.
 */

export const FORGE_CONTRACT_GENERATION = 1 as const;

export interface ContractGenerationRow {
  id: string;
  generation: number;
  schema_domain: string;
  params_prefix: string;
  notes: string;
}

/** Current generation catalogue (update when bumping WASM). */
export const CONTRACT_GENERATIONS: readonly ContractGenerationRow[] = [
  {
    id: "forge-registry",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "gitforge.register.v2",
    params_prefix: "gitforge-registry-v1",
    notes: "Discover + access; listing public_meta",
  },
  {
    id: "forge-profile",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "gitforge.profile.v3",
    params_prefix: "gitforge-profile-v1:",
    notes: "Public card + public_meta (status, pinned)",
  },
  {
    id: "forge-vault",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "gitforge.vault.v4",
    params_prefix: "gitforge-vault-v1:",
    notes: "Adaptive envelopes; settings reserved",
  },
  {
    id: "forge-stars",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "gitforge.stars.v1",
    params_prefix: "gitforge-stars-v1",
    notes: "Unchanged scope",
  },
  {
    id: "forge-repo",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "gitforge.repo-meta.*.v1",
    params_prefix: "gitforge-repo-v1:",
    notes: "Per-prefix settings + channels",
  },
  {
    id: "forge-identity",
    generation: FORGE_CONTRACT_GENERATION,
    schema_domain: "delegate Sign* v2/v3 + repo-meta",
    params_prefix: "(delegate)",
    notes: "SignRegister/SignProfile/SignRepoMeta*",
  },
] as const;
