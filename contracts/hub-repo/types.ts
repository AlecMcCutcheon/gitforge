/** Shared HubRepoMeta types (SPA + docs). */

export interface HubRepoSealedBlob {
  alg: string;
  nonce_b64: string;
  blob_b64: string;
}

export interface HubRepoChannelMessage {
  id: string;
  body_b64?: string | null;
  ciphertext_b64?: string | null;
  created_at: string;
  sender_vk: string;
  sender_sig: string;
  thread_id?: string | null;
}

export interface HubRepoMetaState {
  schema_version: number;
  repo_prefix: string;
  repo_owner_vk: string;
  seal_pk?: string;
  public_settings?: Record<string, string>;
  sealed_settings?: HubRepoSealedBlob | null;
  channels?: {
    public?: HubRepoChannelMessage[];
    private?: HubRepoChannelMessage[];
  };
  identity_fingerprint: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}
