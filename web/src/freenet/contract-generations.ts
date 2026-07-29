/**
 * Contract / delegate generation registry for GitAtlas hub tools.
 *
 * Generation N is the current published WASM set after adaptive-contracts
 * foresight (profile v3, registry register.v2, HubRepoMeta v1).
 * Future WASM bumps add N+1; migrate = re-sign onto the current generation.
 * Multi-gen soft-GET is not required yet (clean break OK while sole user).
 *
 * Hashes in owner-constants.ts are the live build; this table records the
 * semantic generation id and schema domains.
 */

export const HUB_CONTRACT_GENERATION = 1 as const;

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
    id: "hub-registry",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "gitatlas.register.v2",
    params_prefix: "gitatlas-registry-v1",
    notes: "Discover + access; listing public_meta",
  },
  {
    id: "hub-profile",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "gitatlas.profile.v3",
    params_prefix: "gitatlas-profile-v1:",
    notes: "Public card + public_meta (status, pinned)",
  },
  {
    id: "hub-vault",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "gitatlas.vault.v4",
    params_prefix: "gitatlas-vault-v1:",
    notes: "Adaptive envelopes; settings reserved",
  },
  {
    id: "hub-stars",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "gitatlas.stars.v1",
    params_prefix: "gitatlas-stars-v1",
    notes: "Unchanged scope",
  },
  {
    id: "hub-repo",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "gitatlas.repo-meta.*.v1",
    params_prefix: "gitatlas-repo-v1:",
    notes: "Per-prefix settings + channels",
  },
  {
    id: "hub-identity",
    generation: HUB_CONTRACT_GENERATION,
    schema_domain: "delegate Sign* v2/v3 + repo-meta",
    params_prefix: "(delegate)",
    notes: "SignRegister/SignProfile/SignRepoMeta*",
  },
] as const;
