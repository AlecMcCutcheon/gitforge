//! GitForge identity / repo-owner delegate.
//!
//! Holds ed25519 secrets in the node; signs ForgeRegistry dual-sig listings and
//! builds initial freenet-git `RepoState` for empty create. Never returns
//! long-lived secret keys to the SPA except on explicit ExportIdentity.

#![allow(unexpected_cfgs)]

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use freenet_git_types::signing::{
    sign_acl_field, sign_bundle_record, sign_bundle_tip_extension, sign_extension,
    sign_optional_repo_key_field, sign_ref_entry, sign_ref_list_field, sign_string_field,
    DELETED_EXTENSION_KEY,
};
use freenet_git_types::{
    limits, pubkey_prefix, update_state, AclState, ObjectBundle, RepoParams, RepoState,
};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[cfg(all(target_arch = "wasm32", not(test)))]
use getrandom::register_custom_getrandom;

#[cfg(all(target_arch = "wasm32", not(test)))]
fn freenet_getrandom(dest: &mut [u8]) -> Result<(), getrandom::Error> {
    let bytes = freenet_stdlib::rand::rand_bytes(dest.len() as u32);
    dest.copy_from_slice(&bytes[..dest.len()]);
    Ok(())
}

#[cfg(all(target_arch = "wasm32", not(test)))]
register_custom_getrandom!(freenet_getrandom);

const SECRET_ID_SK: &[u8] = b"id_sk";
const SECRET_ID_NAME: &[u8] = b"id_name";
const SECRET_ID_EMAIL: &[u8] = b"id_email";
const SECRET_REPOS: &[u8] = b"repos_json";
// NEW CODE - TESTING: durable repo backup pin index (Freenet sandbox has no IDB)
const SECRET_REPO_BACKUPS: &[u8] = b"repo_backups_json";
// NEW CODE - TESTING: tip pack bytes (content-addressed secrets + hash index)
const SECRET_BACKUP_BLOB_INDEX: &[u8] = b"backup_blob_index_json";
const BACKUP_BLOB_SECRET_PREFIX: &[u8] = b"backup_blob:";
/// Soft ceiling so one Upsert cannot balloon the secret store.
const MAX_BACKUP_BLOB_BYTES: usize = 8 * 1024 * 1024;

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const SIGN_DOMAIN: &[u8] = b"gitforge.register.v1\0";
// const UNREGISTER_DOMAIN: &[u8] = b"gitforge.unregister.v1\0";
// const VAULT_SIGN_DOMAIN: &[u8] = b"gitforge.vault.v3\0";
// const PROFILE_SIGN_DOMAIN: &[u8] = b"gitforge.profile.v1\0";
// const STAR_DOMAIN: &[u8] = b"gitforge.star.v1\0";
// const UNSTAR_DOMAIN: &[u8] = b"gitforge.unstar.v1\0";
// NEW CODE - TESTING: GitForge domains (clean break)
const SIGN_DOMAIN: &[u8] = b"gitforge.register.v2\0";
const UNREGISTER_DOMAIN: &[u8] = b"gitforge.unregister.v1\0";
const CONTRIBUTOR_ADD_DOMAIN: &[u8] = b"gitforge.contributor.add.v1\0";
const CONTRIBUTOR_REMOVE_DOMAIN: &[u8] = b"gitforge.contributor.remove.v1\0";
const PENDING_INVITE_ADD_DOMAIN: &[u8] = b"gitforge.pending-invite.add.v1\0";
const PENDING_INVITE_REMOVE_DOMAIN: &[u8] = b"gitforge.pending-invite.remove.v1\0";
const INBOX_APPEND_DOMAIN: &[u8] = b"gitforge.profile.inbox-append.v1\0";
const VAULT_SIGN_DOMAIN: &[u8] = b"gitforge.vault.v4\0";

fn default_sig_kind_owner() -> String {
    "owner".into()
}
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const PROFILE_SIGN_DOMAIN: &[u8] = b"gitforge.profile.v2\0";
// NEW CODE - TESTING: profile v3 + public_meta
const PROFILE_SIGN_DOMAIN: &[u8] = b"gitforge.profile.v3\0";
const REPO_META_UPSERT_DOMAIN: &[u8] = b"gitforge.repo-meta.upsert.v1\0";
const REPO_META_APPEND_PUBLIC_DOMAIN: &[u8] = b"gitforge.repo-meta.append-public.v1\0";
const REPO_META_APPEND_PRIVATE_DOMAIN: &[u8] = b"gitforge.repo-meta.append-private.v1\0";
const STAR_DOMAIN: &[u8] = b"gitforge.star.v1\0";
const UNSTAR_DOMAIN: &[u8] = b"gitforge.unstar.v1\0";

struct ForgeIdentityDelegate;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Request {
    CreateIdentity {
        name: String,
        email: String,
    },
    GetIdentity,
    ImportIdentity {
        secret_key: String,
        name: String,
        email: String,
    },
    ExportIdentity,
    ExportRepos,
    ImportRepoKey {
        prefix: String,
        secret_key: String,
        #[serde(default)]
        label: String,
    },
    /// Drop a repo owner key from this node after soft-delete is confirmed.
    RemoveRepoKey {
        prefix: String,
    },
    ListRepos,
    SignRegister {
        nonce: String,
        prefix: String,
        label: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        // NEW CODE - TESTING: About website + topics on ForgeRegistry
        #[serde(default)]
        website: Option<String>,
        #[serde(default)]
        topics: Vec<String>,
        /// Compact JSON object for public_meta (use `{}` when empty).
        #[serde(default)]
        public_meta_json: String,
        seq: u64,
        updated_at: String,
    },
    /// Soft-unregister from ForgeRegistry Discover.
    SignUnregister {
        nonce: String,
        prefix: String,
        seq: u64,
        updated_at: String,
    },
    /// Dual-sign ForgeRegistry contributor grant (after ImportRepoKey / legacy).
    SignContributorAdd {
        nonce: String,
        prefix: String,
        seq: u64,
        updated_at: String,
    },
    /// Owner: site-key-sign a contributor invite coupon for a fixed invitee.
    SignContributorInvite {
        nonce: String,
        prefix: String,
        /// Invitee `freenet:id:…` baked into the signed grant payload.
        invitee_fingerprint: String,
        seq: u64,
        updated_at: String,
    },
    /// Invitee: identity-sign an owner coupon (no site key required yet).
    SignContributorAcceptCoupon {
        nonce: String,
        prefix: String,
        invitee_fingerprint: String,
        repo_owner_vk: String,
        repo_owner_sig: String,
        seq: u64,
        updated_at: String,
    },
    /// Dual-sign ForgeRegistry contributor remove (self-leave or owner revoke).
    SignContributorRemove {
        nonce: String,
        prefix: String,
        /// Contributor fingerprint to remove (defaults to self when omitted).
        #[serde(default)]
        contributor_fingerprint: Option<String>,
        seq: u64,
        updated_at: String,
    },
    /// Owner: dual-sign ForgeRegistry pending invite (repo-level invite row).
    SignPendingInviteAdd {
        nonce: String,
        prefix: String,
        invitee_fingerprint: String,
        seq: u64,
        updated_at: String,
    },
    /// Owner: dual-sign cancel of a pending invite.
    SignPendingInviteCancel {
        nonce: String,
        prefix: String,
        invitee_fingerprint: String,
        seq: u64,
        updated_at: String,
    },
    /// Invitee: identity-sign decline (no site key required).
    SignPendingInviteDecline {
        nonce: String,
        prefix: String,
        invitee_fingerprint: String,
        repo_owner_vk: String,
        seq: u64,
        updated_at: String,
    },
    /// Sign a ForgeProfile inbox append (proves sender holds this identity).
    SignInboxAppend {
        nonce: String,
        recipient_fingerprint: String,
        id: String,
        ciphertext_b64: String,
        created_at: String,
    },
    /// Soft-delete: sign RepoState delta with `deleted` extension + `[deleted]` description.
    SignRepoTombstone {
        nonce: String,
        prefix: String,
        /// Current RepoState bytes (hex).
        state_hex: String,
        deleted_at: String,
    },
    /// Rename: sign RepoState.name delta + update local StoredRepos label.
    SignRepoRename {
        nonce: String,
        prefix: String,
        /// Current RepoState bytes (hex).
        state_hex: String,
        /// New display name (also becomes the URL label after slugify).
        name: String,
    },
    // NEW CODE - TESTING: About description only (does not change name/label)
    SignRepoDescription {
        nonce: String,
        prefix: String,
        /// Current RepoState bytes (hex).
        state_hex: String,
        /// Short About blurb (max 350 bytes).
        description: String,
    },
    /// Sign RepoState `pages` extension (GitForge Pages public metadata).
    SignRepoPages {
        nonce: String,
        prefix: String,
        /// Current RepoState bytes (hex).
        state_hex: String,
        /// UTF-8 JSON for extension key `pages`.
        pages_json: String,
    },
    /// First / incremental tip push: sign SinglePack or ChunkedPack + ref + bundle-tip.
    /// SPA Puts pack/chunks first; when `manifest_hash_hex` is set, signs
    /// `ObjectBundle::ChunkedPack` (`size_bytes` = total_size).
    SignPush {
        nonce: String,
        prefix: String,
        /// Current RepoState bytes (hex).
        state_hex: String,
        /// BLAKE3-32 of SinglePack bytes (64 hex). Unused when chunked.
        #[serde(default)]
        pack_hash_hex: String,
        /// SinglePack size_bytes, or ChunkedPack total_size when chunked.
        size_bytes: u64,
        /// e.g. refs/heads/main
        ref_name: String,
        /// Tip object SHA-1 (40 hex).
        tip_hex: String,
        /// When set, sign ChunkedPack instead of SinglePack.
        #[serde(default)]
        manifest_hash_hex: Option<String>,
        /// Required with manifest_hash_hex.
        #[serde(default)]
        chunk_count: Option<u32>,
    },
    CreateRepo {
        nonce: String,
        name: String,
        #[serde(default)]
        description: String,
        #[serde(default = "default_branch")]
        default_branch: String,
    },
    /// Clear identity + repo secrets on this node (SPA logout).
    Logout,
    /// Sign GitForge vault public state (passwordless v4 — SPA builds ciphertext).
    SignVault {
        vault_id: String,
        username: String,
        identity_fingerprint: String,
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // identity_kdf_json: String,
        // identity_cipher_json: String,
        envelopes_json: String,
        /// Compact JSON object for identity_dek_wrap.
        identity_dek_wrap_json: String,
        /// Compact JSON array (use `[]` when empty).
        #[serde(default)]
        api_key_wraps_json: String,
        /// Compact JSON array (use `[]` when empty).
        #[serde(default)]
        authorized_ops_json: String,
        seq: u64,
        updated_at: String,
        /// `owner` or `ops` — included in signing payload.
        #[serde(default = "default_sig_kind_owner")]
        sig_kind: String,
    },
    /// Sign GitForge profile public state (bio / avatar / url / inbox / public_meta).
    SignProfile {
        username: String,
        #[serde(default)]
        public_email: String,
        #[serde(default)]
        bio: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        avatar: String,
        /// X25519 seal public key (hex).
        #[serde(default)]
        inbox_pk_hex: String,
        /// Compact JSON array of opaque inbox messages (use `[]` when empty).
        #[serde(default)]
        inbox_messages_json: String,
        /// Compact JSON object for public_meta (use `{}` when empty).
        #[serde(default)]
        public_meta_json: String,
        seq: u64,
        updated_at: String,
    },
    /// Dual-sign ForgeRepoMeta upsert (settings + seal_pk).
    SignRepoMetaUpsert {
        nonce: String,
        prefix: String,
        #[serde(default)]
        seal_pk: String,
        #[serde(default)]
        public_settings_json: String,
        #[serde(default)]
        sealed_settings_json: String,
        seq: u64,
        updated_at: String,
    },
    /// Identity-sign public channel append on ForgeRepoMeta.
    SignRepoMetaAppendPublic {
        nonce: String,
        prefix: String,
        id: String,
        body_b64: String,
        created_at: String,
        #[serde(default)]
        thread_id: String,
    },
    /// Identity-sign private channel append on ForgeRepoMeta.
    SignRepoMetaAppendPrivate {
        nonce: String,
        prefix: String,
        id: String,
        ciphertext_b64: String,
        created_at: String,
        #[serde(default)]
        thread_id: String,
    },
    SignStar {
        repo_prefix: String,
        #[serde(default)]
        label: Option<String>,
        starred_at: String,
    },
    SignUnstar {
        repo_prefix: String,
        starred_at: String,
    },
    /// Persist a local repo-backup pin (tip hashes + Hub snapshots) on this node.
    UpsertRepoBackupPin {
        /// Full `RepoBackupPin` JSON from the SPA (pack bytes live in UpsertRepoBackupBlob).
        pin_json: String,
    },
    /// Drop a backup reason, or the whole pin when `reason` is null/empty.
    RemoveRepoBackupPin {
        prefix: String,
        #[serde(default)]
        reason: Option<String>,
    },
    ListRepoBackupPins,
    /// Store tip-pack / chunk bytes under a content hash (survives sandbox IDB wipe).
    UpsertRepoBackupBlob {
        hash_hex: String,
        /// Raw pack bytes as lowercase hex (SPA verifies BLAKE3 before send).
        bytes_hex: String,
    },
    GetRepoBackupBlob {
        hash_hex: String,
    },
    /// Drop one CA blob (GC after pin clear / tip advance).
    RemoveRepoBackupBlob {
        hash_hex: String,
    },
    ListRepoBackupBlobHashes,
}

fn default_branch() -> String {
    "refs/heads/main".into()
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Response {
    Identity {
        fingerprint: String,
        name: String,
        email: String,
        public_key_b58: String,
    },
    ExportedIdentity {
        secret_key: String,
        fingerprint: String,
        name: String,
        email: String,
    },
    ExportedRepos {
        repos: Vec<ExportedRepo>,
    },
    RepoList {
        repos: Vec<RepoListEntry>,
    },
    SignedRegister {
        nonce: String,
        entry: RegisterEntry,
    },
    SignedUnregister {
        nonce: String,
        op: UnregisterOp,
    },
    SignedContributorAdd {
        nonce: String,
        entry: ContributorEntry,
    },
    /// Owner coupon: site-key sig only (invitee fills identity_sig on accept).
    SignedContributorInvite {
        nonce: String,
        coupon: ContributorInviteCoupon,
    },
    SignedContributorAcceptCoupon {
        nonce: String,
        entry: ContributorEntry,
    },
    SignedContributorRemove {
        nonce: String,
        entry: ContributorEntry,
    },
    SignedPendingInviteAdd {
        nonce: String,
        entry: PendingInviteEntry,
    },
    SignedPendingInviteCancel {
        nonce: String,
        entry: PendingInviteEntry,
    },
    SignedPendingInviteDecline {
        nonce: String,
        entry: PendingInviteEntry,
    },
    SignedInboxAppend {
        nonce: String,
        sender_vk: String,
        sender_sig: String,
    },
    SignedRepoTombstone {
        nonce: String,
        /// Partial RepoState (bincode hex) for contract Update fallback.
        delta_hex: String,
        /// Full post-merge RepoState (bincode hex) for Put-prefer path.
        state_hex: String,
    },
    SignedRepoRename {
        nonce: String,
        /// Partial RepoState (bincode hex) for contract Update fallback.
        delta_hex: String,
        /// Full post-merge RepoState (bincode hex) for Put-prefer path.
        state_hex: String,
        /// Slugified URL label (matches freenet-git create convention).
        label: String,
        /// Signed display name written to RepoState.
        name: String,
    },
    // NEW CODE - TESTING
    SignedRepoDescription {
        nonce: String,
        delta_hex: String,
        state_hex: String,
        description: String,
    },
    SignedRepoPages {
        nonce: String,
        delta_hex: String,
        state_hex: String,
        pages_json: String,
    },
    SignedPush {
        nonce: String,
        /// Partial RepoState (bincode hex) for Update fallback.
        delta_hex: String,
        /// Full post-merge RepoState (bincode hex) for Put-prefer path.
        state_hex: String,
    },
    CreatedRepo {
        nonce: String,
        prefix: String,
        label: String,
        url: String,
        params_hex: String,
        state_hex: String,
        repo_owner_vk_b58: String,
    },
    LoggedOut,
    SignedVault {
        owner_sig: String,
    },
    SignedProfile {
        identity_fingerprint: String,
        username: String,
        public_email: String,
        bio: String,
        url: String,
        avatar: String,
        inbox_pk_hex: String,
        inbox_messages_json: String,
        public_meta_json: String,
        seq: u64,
        updated_at: String,
        owner_sig: String,
    },
    SignedRepoMetaUpsert {
        nonce: String,
        entry: RepoMetaUpsertEntry,
    },
    SignedRepoMetaAppend {
        nonce: String,
        kind: String,
        message: RepoMetaChannelMessage,
    },
    SignedStar {
        fingerprint: String,
        repo_prefix: String,
        label: Option<String>,
        starred_at: String,
        sig: String,
    },
    SignedUnstar {
        fingerprint: String,
        repo_prefix: String,
        starred_at: String,
        sig: String,
    },
    /// NEW CODE - TESTING: durable Stars/Repos backup pins (node secret store)
    RepoBackupPins {
        pins_json: String,
    },
    RepoBackupOk {
        prefix: String,
    },
    /// NEW CODE - TESTING: durable tip-pack blob stored / removed
    RepoBackupBlobOk {
        hash_hex: String,
    },
    RepoBackupBlob {
        hash_hex: String,
        bytes_hex: String,
    },
    RepoBackupBlobMissing {
        hash_hex: String,
    },
    RepoBackupBlobHashes {
        hashes: Vec<String>,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone)]
struct RepoListEntry {
    prefix: String,
    label: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ExportedRepo {
    prefix: String,
    label: String,
    secret_hex: String,
}

#[derive(Serialize, Deserialize)]
struct RegisterEntry {
    schema_version: u32,
    repo_prefix: String,
    label: String,
    name: Option<String>,
    description: Option<String>,
    // NEW CODE - TESTING
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    public_meta: BTreeMap<String, String>,
    identity_fingerprint: String,
    identity_name: String,
    identity_email: Option<String>,
    repo_owner_vk: String,
    attestation: String,
    identity_sig: String,
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct UnregisterOp {
    schema_version: u32,
    repo_prefix: String,
    identity_fingerprint: String,
    repo_owner_vk: String,
    attestation: String,
    identity_sig: String,
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct ContributorEntry {
    schema_version: u32,
    repo_prefix: String,
    identity_fingerprint: String,
    repo_owner_vk: String,
    attestation: String,
    identity_sig: String,
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

/// Owner-issued invite coupon (sealed into inbox with site key secret).
#[derive(Serialize, Deserialize)]
struct ContributorInviteCoupon {
    schema_version: u32,
    repo_prefix: String,
    identity_fingerprint: String,
    repo_owner_vk: String,
    attestation: String,
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

/// ForgeRegistry pending invite row (add / cancel / decline).
#[derive(Serialize, Deserialize)]
struct PendingInviteEntry {
    schema_version: u32,
    repo_prefix: String,
    identity_fingerprint: String,
    repo_owner_vk: String,
    attestation: String,
    identity_sig: String,
    #[serde(default)]
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct RepoMetaUpsertEntry {
    schema_version: u32,
    repo_prefix: String,
    repo_owner_vk: String,
    seal_pk: String,
    public_settings: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed_settings: Option<RepoMetaSealedBlob>,
    identity_fingerprint: String,
    attestation: String,
    identity_sig: String,
    repo_owner_sig: String,
    seq: u64,
    updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RepoMetaSealedBlob {
    alg: String,
    nonce_b64: String,
    blob_b64: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RepoMetaChannelMessage {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ciphertext_b64: Option<String>,
    created_at: String,
    sender_vk: String,
    sender_sig: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct StoredRepos {
    /// prefix -> { secret_hex, label }
    repos: BTreeMap<String, StoredRepo>,
}

#[derive(Serialize, Deserialize)]
struct StoredRepo {
    secret_hex: String,
    label: String,
}

fn random_sk_bytes() -> [u8; 32] {
    let bytes = freenet_stdlib::rand::rand_bytes(32);
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[..32]);
    out
}

fn fingerprint_of(vk: &VerifyingKey) -> String {
    format!(
        "freenet:id:{}",
        bs58::encode(vk.as_bytes()).into_string()
    )
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

/// Canonical topics string for signing: lowercased, sorted, comma-joined.
fn topics_canonical(topics: &[String]) -> String {
    let mut cleaned: Vec<String> = topics
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    cleaned.sort();
    cleaned.dedup();
    cleaned.join(",")
}

/// GitHub-style About description length (stricter than freenet-git 4096).
const ABOUT_DESCRIPTION_MAX: usize = 350;

fn signing_payload(
    repo_prefix: &str,
    label: &str,
    name: Option<&str>,
    description: Option<&str>,
    website: Option<&str>,
    topics: &[String],
    identity_fingerprint: &str,
    identity_name: &str,
    identity_email: Option<&str>,
    repo_owner_vk: &str,
    public_meta_json: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(SIGN_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, label.as_bytes());
    push_field(&mut out, name.unwrap_or("").as_bytes());
    push_field(&mut out, description.unwrap_or("").as_bytes());
    // NEW CODE - TESTING: website + topics after description
    push_field(&mut out, website.unwrap_or("").as_bytes());
    push_field(&mut out, topics_canonical(topics).as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, identity_name.as_bytes());
    push_field(&mut out, identity_email.unwrap_or("").as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    // NEW CODE - TESTING: public_meta (register.v2)
    push_field(&mut out, public_meta_json.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn load_id_sk(ctx: &DelegateCtx) -> Result<SigningKey, Response> {
    let Some(bytes) = ctx.get_secret(SECRET_ID_SK) else {
        return Err(Response::Error {
            message: "no identity — call CreateIdentity first".into(),
            nonce: None,
        });
    };
    let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| Response::Error {
        message: "stored identity key has wrong length".into(),
        nonce: None,
    })?;
    Ok(SigningKey::from_bytes(&arr))
}

fn id_name(ctx: &DelegateCtx) -> String {
    ctx.get_secret(SECRET_ID_NAME)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn id_email(ctx: &DelegateCtx) -> String {
    ctx.get_secret(SECRET_ID_EMAIL)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn load_repos(ctx: &DelegateCtx) -> StoredRepos {
    match ctx.get_secret(SECRET_REPOS) {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => StoredRepos::default(),
    }
}

fn save_repos(ctx: &mut DelegateCtx, repos: &StoredRepos) {
    if let Ok(bytes) = serde_json::to_vec(repos) {
        ctx.set_secret(SECRET_REPOS, &bytes);
    }
}

#[derive(Serialize, Deserialize, Default)]
struct StoredRepoBackups {
    #[serde(default)]
    pins: BTreeMap<String, serde_json::Value>,
}

fn load_repo_backups(ctx: &DelegateCtx) -> StoredRepoBackups {
    match ctx.get_secret(SECRET_REPO_BACKUPS) {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => StoredRepoBackups::default(),
    }
}

fn save_repo_backups(ctx: &mut DelegateCtx, stored: &StoredRepoBackups) {
    if let Ok(bytes) = serde_json::to_vec(stored) {
        ctx.set_secret(SECRET_REPO_BACKUPS, &bytes);
    }
}

fn upsert_repo_backup_pin(ctx: &mut DelegateCtx, pin_json: &str) -> Response {
    let value: serde_json::Value = match serde_json::from_str(pin_json) {
        Ok(v) => v,
        Err(e) => {
            return Response::Error {
                message: format!("invalid backup pin JSON: {e}"),
                nonce: None,
            };
        }
    };
    let prefix = value
        .get("prefix")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    if prefix.is_empty() {
        return Response::Error {
            message: "backup pin missing prefix".into(),
            nonce: None,
        };
    }
    let mut stored = load_repo_backups(ctx);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // merge reasons on upsert (could resurrect removed reasons)
    // NEW CODE - TESTING: SPA owns merge; delegate replaces pin wholesale
    stored.pins.insert(prefix.clone(), value);
    save_repo_backups(ctx, &stored);
    Response::RepoBackupOk { prefix }
}

fn remove_repo_backup_pin(
    ctx: &mut DelegateCtx,
    prefix: &str,
    reason: Option<&str>,
) -> Response {
    let mut stored = load_repo_backups(ctx);
    let Some(existing) = stored.pins.get(prefix).cloned() else {
        return Response::RepoBackupOk {
            prefix: prefix.to_string(),
        };
    };
    let reason = reason.map(str::trim).filter(|r| !r.is_empty());
    if let Some(reason) = reason {
        let mut next = existing;
        if let Some(obj) = next.as_object_mut() {
            if let Some(serde_json::Value::Array(reasons)) = obj.get_mut("reasons") {
                reasons.retain(|r| r.as_str() != Some(reason));
                if reasons.is_empty() {
                    stored.pins.remove(prefix);
                } else {
                    stored.pins.insert(prefix.to_string(), next);
                }
            } else {
                stored.pins.remove(prefix);
            }
        }
    } else {
        stored.pins.remove(prefix);
    }
    save_repo_backups(ctx, &stored);
    Response::RepoBackupOk {
        prefix: prefix.to_string(),
    }
}

fn list_repo_backup_pins(ctx: &DelegateCtx) -> Response {
    let stored = load_repo_backups(ctx);
    let pins: Vec<serde_json::Value> = stored.pins.into_values().collect();
    let pins_json = serde_json::to_string(&pins).unwrap_or_else(|_| "[]".into());
    Response::RepoBackupPins { pins_json }
}

fn normalize_backup_hash(hash_hex: &str) -> Result<String, Response> {
    let h = hash_hex.trim().to_ascii_lowercase();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Response::Error {
            message: "backup blob hash_hex must be 64 hex chars".into(),
            nonce: None,
        });
    }
    Ok(h)
}

fn backup_blob_secret_key(hash_hex: &str) -> Vec<u8> {
    let mut key = BACKUP_BLOB_SECRET_PREFIX.to_vec();
    key.extend_from_slice(hash_hex.as_bytes());
    key
}

#[derive(Serialize, Deserialize, Default)]
struct StoredBackupBlobIndex {
    #[serde(default)]
    hashes: Vec<String>,
}

fn load_backup_blob_index(ctx: &DelegateCtx) -> StoredBackupBlobIndex {
    match ctx.get_secret(SECRET_BACKUP_BLOB_INDEX) {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => StoredBackupBlobIndex::default(),
    }
}

fn save_backup_blob_index(ctx: &mut DelegateCtx, index: &StoredBackupBlobIndex) {
    if let Ok(bytes) = serde_json::to_vec(index) {
        ctx.set_secret(SECRET_BACKUP_BLOB_INDEX, &bytes);
    }
}

fn index_add_backup_blob(ctx: &mut DelegateCtx, hash_hex: &str) {
    let mut index = load_backup_blob_index(ctx);
    if !index.hashes.iter().any(|h| h == hash_hex) {
        index.hashes.push(hash_hex.to_string());
        index.hashes.sort();
        save_backup_blob_index(ctx, &index);
    }
}

fn index_remove_backup_blob(ctx: &mut DelegateCtx, hash_hex: &str) {
    let mut index = load_backup_blob_index(ctx);
    let before = index.hashes.len();
    index.hashes.retain(|h| h != hash_hex);
    if index.hashes.len() != before {
        save_backup_blob_index(ctx, &index);
    }
}

fn upsert_repo_backup_blob(ctx: &mut DelegateCtx, hash_hex: &str, bytes_hex: &str) -> Response {
    let hash = match normalize_backup_hash(hash_hex) {
        Ok(h) => h,
        Err(e) => return e,
    };
    let bytes = match hex::decode(bytes_hex.trim()) {
        Ok(b) => b,
        Err(e) => {
            return Response::Error {
                message: format!("invalid backup blob hex: {e}"),
                nonce: None,
            };
        }
    };
    if bytes.is_empty() {
        return Response::Error {
            message: "backup blob bytes empty".into(),
            nonce: None,
        };
    }
    if bytes.len() > MAX_BACKUP_BLOB_BYTES {
        return Response::Error {
            message: format!(
                "backup blob too large ({} > {} bytes)",
                bytes.len(),
                MAX_BACKUP_BLOB_BYTES
            ),
            nonce: None,
        };
    }
    let key = backup_blob_secret_key(&hash);
    ctx.set_secret(&key, &bytes);
    index_add_backup_blob(ctx, &hash);
    Response::RepoBackupBlobOk { hash_hex: hash }
}

fn get_repo_backup_blob(ctx: &DelegateCtx, hash_hex: &str) -> Response {
    let hash = match normalize_backup_hash(hash_hex) {
        Ok(h) => h,
        Err(e) => return e,
    };
    let key = backup_blob_secret_key(&hash);
    match ctx.get_secret(&key) {
        Some(bytes) if !bytes.is_empty() => Response::RepoBackupBlob {
            hash_hex: hash,
            bytes_hex: hex::encode(bytes),
        },
        _ => Response::RepoBackupBlobMissing { hash_hex: hash },
    }
}

fn remove_repo_backup_blob(ctx: &mut DelegateCtx, hash_hex: &str) -> Response {
    let hash = match normalize_backup_hash(hash_hex) {
        Ok(h) => h,
        Err(e) => return e,
    };
    let key = backup_blob_secret_key(&hash);
    let _ = ctx.remove_secret(&key);
    index_remove_backup_blob(ctx, &hash);
    Response::RepoBackupBlobOk { hash_hex: hash }
}

fn list_repo_backup_blob_hashes(ctx: &DelegateCtx) -> Response {
    let index = load_backup_blob_index(ctx);
    Response::RepoBackupBlobHashes {
        hashes: index.hashes,
    }
}

/// Drop every content-addressed backup blob + index (logout / full wipe).
fn clear_all_backup_blobs(ctx: &mut DelegateCtx) {
    let index = load_backup_blob_index(ctx);
    for hash in &index.hashes {
        let key = backup_blob_secret_key(hash);
        let _ = ctx.remove_secret(&key);
    }
    let _ = ctx.remove_secret(SECRET_BACKUP_BLOB_INDEX);
}

fn initial_repo_state(
    params: &RepoParams,
    owner: &SigningKey,
    name: &str,
    description: &str,
    default_branch: &str,
) -> RepoState {
    let mut state = RepoState::default();
    state.owner = owner.verifying_key().to_bytes();
    state.name = Some(sign_string_field(
        params,
        owner,
        "name",
        name.to_string(),
        1,
    ));
    state.description = Some(sign_string_field(
        params,
        owner,
        "description",
        description.to_string(),
        1,
    ));
    state.default_branch = Some(sign_string_field(
        params,
        owner,
        "default_branch",
        default_branch.to_string(),
        1,
    ));
    state.force_push_allowed = Some(sign_ref_list_field(
        params,
        owner,
        "force_push_allowed",
        vec![],
        1,
    ));
    state.acl = Some(sign_acl_field(
        params,
        owner,
        "acl",
        AclState {
            epoch: 0,
            grants: BTreeMap::new(),
        },
        1,
    ));
    state.upgrade = Some(sign_optional_repo_key_field(
        params, owner, "upgrade", None, 1,
    ));
    state
}

fn create_identity(ctx: &mut DelegateCtx, name: &str, email: &str) -> Response {
    let sk_bytes = random_sk_bytes();
    let sk = SigningKey::from_bytes(&sk_bytes);
    let vk = sk.verifying_key();
    ctx.set_secret(SECRET_ID_SK, &sk_bytes);
    ctx.set_secret(SECRET_ID_NAME, name.as_bytes());
    ctx.set_secret(SECRET_ID_EMAIL, email.as_bytes());
    Response::Identity {
        fingerprint: fingerprint_of(&vk),
        name: name.to_string(),
        email: email.to_string(),
        public_key_b58: bs58::encode(vk.as_bytes()).into_string(),
    }
}

fn get_identity(ctx: &DelegateCtx) -> Response {
    match load_id_sk(ctx) {
        Ok(sk) => {
            let vk = sk.verifying_key();
            Response::Identity {
                fingerprint: fingerprint_of(&vk),
                name: id_name(ctx),
                email: id_email(ctx),
                public_key_b58: bs58::encode(vk.as_bytes()).into_string(),
            }
        }
        Err(e) => e,
    }
}

fn import_identity(ctx: &mut DelegateCtx, secret_hex: &str, name: &str, email: &str) -> Response {
    let bytes = match hex::decode(secret_hex.trim()) {
        Ok(b) => b,
        Err(e) => {
            return Response::Error {
                message: format!("bad secret hex: {e}"),
                nonce: None,
            };
        }
    };
    let arr: [u8; 32] = match bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            return Response::Error {
                message: "secret must be 32 bytes".into(),
                nonce: None,
            };
        }
    };
    let sk = SigningKey::from_bytes(&arr);
    let vk = sk.verifying_key();
    ctx.set_secret(SECRET_ID_SK, &arr);
    ctx.set_secret(SECRET_ID_NAME, name.as_bytes());
    ctx.set_secret(SECRET_ID_EMAIL, email.as_bytes());
    Response::Identity {
        fingerprint: fingerprint_of(&vk),
        name: name.to_string(),
        email: email.to_string(),
        public_key_b58: bs58::encode(vk.as_bytes()).into_string(),
    }
}

fn export_identity(ctx: &DelegateCtx) -> Response {
    match load_id_sk(ctx) {
        Ok(sk) => Response::ExportedIdentity {
            secret_key: hex::encode(sk.to_bytes()),
            fingerprint: fingerprint_of(&sk.verifying_key()),
            name: id_name(ctx),
            email: id_email(ctx),
        },
        Err(e) => e,
    }
}

fn export_repos(ctx: &DelegateCtx) -> Response {
    let repos = load_repos(ctx);
    Response::ExportedRepos {
        repos: repos
            .repos
            .iter()
            .map(|(p, r)| ExportedRepo {
                prefix: p.clone(),
                label: r.label.clone(),
                secret_hex: r.secret_hex.clone(),
            })
            .collect(),
    }
}

fn import_repo_key(ctx: &mut DelegateCtx, prefix: &str, secret_hex: &str, label: &str) -> Response {
    let bytes = match hex::decode(secret_hex.trim()) {
        Ok(b) => b,
        Err(e) => {
            return Response::Error {
                message: format!("bad secret hex: {e}"),
                nonce: None,
            };
        }
    };
    let arr: [u8; 32] = match bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            return Response::Error {
                message: "repo secret must be 32 bytes".into(),
                nonce: None,
            };
        }
    };
    let sk = SigningKey::from_bytes(&arr);
    let vk = sk.verifying_key().to_bytes();
    let derived = pubkey_prefix(&vk, limits::DEFAULT_PREFIX_LEN);
    let use_prefix = if prefix.is_empty() {
        derived
    } else if pubkey_prefix(&vk, prefix.len()) == prefix {
        prefix.to_string()
    } else {
        return Response::Error {
            message: format!("secret does not match prefix {prefix} (got {derived})"),
            nonce: None,
        };
    };
    let mut repos = load_repos(ctx);
    repos.repos.insert(
        use_prefix,
        StoredRepo {
            secret_hex: hex::encode(arr),
            label: if label.is_empty() {
                "repo".into()
            } else {
                label.to_string()
            },
        },
    );
    save_repos(ctx, &repos);
    Response::RepoList {
        repos: repos
            .repos
            .iter()
            .map(|(p, r)| RepoListEntry {
                prefix: p.clone(),
                label: r.label.clone(),
            })
            .collect(),
    }
}

fn remove_repo_key(ctx: &mut DelegateCtx, prefix: &str) -> Response {
    let trimmed = prefix.trim();
    if trimmed.is_empty() {
        return Response::Error {
            message: "prefix required".into(),
            nonce: None,
        };
    }
    let mut repos = load_repos(ctx);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // (no RemoveRepoKey — soft-delete left owner keys on the node)
    // NEW CODE - TESTING
    let removed = repos.repos.remove(trimmed).is_some();
    if !removed {
        // Idempotent: already gone is OK after a retry.
        return Response::RepoList {
            repos: repos
                .repos
                .iter()
                .map(|(p, r)| RepoListEntry {
                    prefix: p.clone(),
                    label: r.label.clone(),
                })
                .collect(),
        };
    }
    save_repos(ctx, &repos);
    Response::RepoList {
        repos: repos
            .repos
            .iter()
            .map(|(p, r)| RepoListEntry {
                prefix: p.clone(),
                label: r.label.clone(),
            })
            .collect(),
    }
}

fn list_repos(ctx: &DelegateCtx) -> Response {
    let repos = load_repos(ctx);
    Response::RepoList {
        repos: repos
            .repos
            .iter()
            .map(|(p, r)| RepoListEntry {
                prefix: p.clone(),
                label: r.label.clone(),
            })
            .collect(),
    }
}

fn unregister_signing_payload(
    repo_prefix: &str,
    identity_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(UNREGISTER_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn contributor_add_signing_payload(
    repo_prefix: &str,
    identity_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(CONTRIBUTOR_ADD_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn contributor_remove_signing_payload(
    repo_prefix: &str,
    identity_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(CONTRIBUTOR_REMOVE_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn pending_invite_add_signing_payload(
    repo_prefix: &str,
    identity_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(PENDING_INVITE_ADD_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn pending_invite_remove_signing_payload(
    repo_prefix: &str,
    identity_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(PENDING_INVITE_REMOVE_DOMAIN);
    push_field(&mut out, repo_prefix.as_bytes());
    push_field(&mut out, identity_fingerprint.as_bytes());
    push_field(&mut out, repo_owner_vk.as_bytes());
    out.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut out, updated_at.as_bytes());
    out
}

fn inbox_append_signing_payload(
    recipient_fingerprint: &str,
    id: &str,
    ciphertext_b64: &str,
    created_at: &str,
    sender_vk: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(INBOX_APPEND_DOMAIN);
    push_field(&mut out, recipient_fingerprint.as_bytes());
    push_field(&mut out, id.as_bytes());
    push_field(&mut out, ciphertext_b64.as_bytes());
    push_field(&mut out, created_at.as_bytes());
    push_field(&mut out, sender_vk.as_bytes());
    out
}

fn load_repo_sk(ctx: &DelegateCtx, prefix: &str, nonce: &str) -> Result<(SigningKey, String), Response> {
    let repos = load_repos(ctx);
    let Some(stored) = repos.repos.get(prefix) else {
        return Err(Response::Error {
            message: format!(
                "no repo key for prefix {prefix} — CreateRepo or ImportRepoKey first"
            ),
            nonce: Some(nonce.to_string()),
        });
    };
    let repo_bytes = hex::decode(&stored.secret_hex).map_err(|_| Response::Error {
        message: "corrupt stored repo key".into(),
        nonce: Some(nonce.to_string()),
    })?;
    let arr: [u8; 32] = repo_bytes.as_slice().try_into().map_err(|_| Response::Error {
        message: "corrupt stored repo key length".into(),
        nonce: Some(nonce.to_string()),
    })?;
    let repo_sk = SigningKey::from_bytes(&arr);
    let repo_vk = repo_sk.verifying_key();
    if pubkey_prefix(repo_vk.as_bytes(), prefix.len()) != prefix {
        return Err(Response::Error {
            message: "stored repo key does not match prefix".into(),
            nonce: Some(nonce.to_string()),
        });
    }
    Ok((repo_sk, bs58::encode(repo_vk.as_bytes()).into_string()))
}

fn sign_register(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    label: &str,
    name: Option<String>,
    description: Option<String>,
    website: Option<String>,
    topics: Vec<String>,
    public_meta_json: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let id_vk = id_sk.verifying_key();
    let fp = fingerprint_of(&id_vk);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // let name_str = id_name(ctx);
    // let email_str = id_email(ctx);
    // let email_opt = if email_str.is_empty() { None } else { Some(email_str.as_str()) };
    // identity_name: name_str — username on registry goes stale when profile renames
    // NEW CODE - TESTING: ForgeRegistry identity fields are fingerprint-only;
    // username/email for display come from ForgeProfile. Signing field stays empty.
    let _ = (id_name(ctx), id_email(ctx));
    let name_str = String::new();
    let email_opt: Option<&str> = None;
    // Normalize topics for storage + signing (sorted lowercase).
    let topics_norm: Vec<String> = {
        let mut cleaned: Vec<String> = topics
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        cleaned.sort();
        cleaned.dedup();
        cleaned
    };
    let website_norm = website
        .as_ref()
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty());
    let public_meta: BTreeMap<String, String> = if public_meta_json.trim().is_empty() {
        BTreeMap::new()
    } else {
        match serde_json::from_str(public_meta_json.trim()) {
            Ok(m) => m,
            Err(e) => {
                return Response::Error {
                    message: format!("public_meta_json: {e}"),
                    nonce: Some(nonce.to_string()),
                };
            }
        }
    };
    let meta_json = serde_json::to_string(&public_meta).unwrap_or_else(|_| "{}".into());
    let payload = signing_payload(
        prefix,
        label,
        name.as_deref(),
        description.as_deref(),
        website_norm.as_deref(),
        &topics_norm,
        &fp,
        &name_str,
        email_opt,
        &repo_owner_vk,
        &meta_json,
        seq,
        updated_at,
    );
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedRegister {
        nonce: nonce.to_string(),
        entry: RegisterEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            label: label.to_string(),
            name,
            description,
            website: website_norm,
            topics: topics_norm,
            public_meta,
            identity_fingerprint: fp,
            identity_name: name_str,
            identity_email: None,
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_unregister(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let fp = fingerprint_of(&id_sk.verifying_key());
    let payload = unregister_signing_payload(prefix, &fp, &repo_owner_vk, seq, updated_at);
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedUnregister {
        nonce: nonce.to_string(),
        op: UnregisterOp {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: fp,
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_contributor_add(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let fp = fingerprint_of(&id_sk.verifying_key());
    let payload =
        contributor_add_signing_payload(prefix, &fp, &repo_owner_vk, seq, updated_at);
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedContributorAdd {
        nonce: nonce.to_string(),
        entry: ContributorEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: fp,
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

/// Owner pre-signs site-key half of contributor grant for a fixed invitee.
fn sign_contributor_invite(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    invitee_fingerprint: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    if !invitee_fingerprint.starts_with("freenet:id:") || invitee_fingerprint.len() < 20 {
        return Response::Error {
            message: "invitee_fingerprint must be freenet:id:…".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let self_fp = fingerprint_of(&id_sk.verifying_key());
    if invitee_fingerprint == self_fp {
        return Response::Error {
            message: "cannot invite yourself as a contributor".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let payload = contributor_add_signing_payload(
        prefix,
        invitee_fingerprint,
        &repo_owner_vk,
        seq,
        updated_at,
    );
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedContributorInvite {
        nonce: nonce.to_string(),
        coupon: ContributorInviteCoupon {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: invitee_fingerprint.to_string(),
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

/// Invitee completes coupon: identity_sig only (site key not required yet).
fn sign_contributor_accept_coupon(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    invitee_fingerprint: &str,
    repo_owner_vk: &str,
    repo_owner_sig: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let self_fp = fingerprint_of(&id_sk.verifying_key());
    if self_fp != invitee_fingerprint {
        return Response::Error {
            message: "coupon invitee_fingerprint does not match signed-in identity".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    if prefix.is_empty() || repo_owner_vk.is_empty() || repo_owner_sig.is_empty() {
        return Response::Error {
            message: "incomplete contributor invite coupon".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let payload = contributor_add_signing_payload(
        prefix,
        invitee_fingerprint,
        repo_owner_vk,
        seq,
        updated_at,
    );
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    Response::SignedContributorAcceptCoupon {
        nonce: nonce.to_string(),
        entry: ContributorEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: invitee_fingerprint.to_string(),
            repo_owner_vk: repo_owner_vk.to_string(),
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig: repo_owner_sig.to_string(),
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_contributor_remove(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    contributor_fingerprint: Option<String>,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let self_fp = fingerprint_of(&id_sk.verifying_key());
    let target_fp = contributor_fingerprint
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| self_fp.clone());
    let payload =
        contributor_remove_signing_payload(prefix, &target_fp, &repo_owner_vk, seq, updated_at);
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedContributorRemove {
        nonce: nonce.to_string(),
        entry: ContributorEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: target_fp,
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_pending_invite_add(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    invitee_fingerprint: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    if !invitee_fingerprint.starts_with("freenet:id:") || invitee_fingerprint.len() < 20 {
        return Response::Error {
            message: "invitee_fingerprint must be freenet:id:…".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let self_fp = fingerprint_of(&id_sk.verifying_key());
    if invitee_fingerprint == self_fp {
        return Response::Error {
            message: "cannot invite yourself".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let payload = pending_invite_add_signing_payload(
        prefix,
        invitee_fingerprint,
        &repo_owner_vk,
        seq,
        updated_at,
    );
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedPendingInviteAdd {
        nonce: nonce.to_string(),
        entry: PendingInviteEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: invitee_fingerprint.to_string(),
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_pending_invite_cancel(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    invitee_fingerprint: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let payload = pending_invite_remove_signing_payload(
        prefix,
        invitee_fingerprint,
        &repo_owner_vk,
        seq,
        updated_at,
    );
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    let repo_owner_sig = hex::encode(repo_sk.sign(&payload).to_bytes());
    Response::SignedPendingInviteCancel {
        nonce: nonce.to_string(),
        entry: PendingInviteEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: invitee_fingerprint.to_string(),
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig,
            repo_owner_sig,
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_pending_invite_decline(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    invitee_fingerprint: &str,
    repo_owner_vk: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let self_fp = fingerprint_of(&id_sk.verifying_key());
    if self_fp != invitee_fingerprint {
        return Response::Error {
            message: "decline fingerprint does not match signed-in identity".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    if prefix.is_empty() || repo_owner_vk.is_empty() {
        return Response::Error {
            message: "incomplete pending invite decline".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let payload = pending_invite_remove_signing_payload(
        prefix,
        invitee_fingerprint,
        repo_owner_vk,
        seq,
        updated_at,
    );
    let identity_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    Response::SignedPendingInviteDecline {
        nonce: nonce.to_string(),
        entry: PendingInviteEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            identity_fingerprint: invitee_fingerprint.to_string(),
            repo_owner_vk: repo_owner_vk.to_string(),
            attestation: "invitee-decline-v1".into(),
            identity_sig,
            repo_owner_sig: String::new(),
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_inbox_append(
    ctx: &DelegateCtx,
    nonce: &str,
    recipient_fingerprint: &str,
    id: &str,
    ciphertext_b64: &str,
    created_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let sender_vk = bs58::encode(id_sk.verifying_key().as_bytes()).into_string();
    let payload = inbox_append_signing_payload(
        recipient_fingerprint,
        id,
        ciphertext_b64,
        created_at,
        &sender_vk,
    );
    let sender_sig = hex::encode(id_sk.sign(&payload).to_bytes());
    Response::SignedInboxAppend {
        nonce: nonce.to_string(),
        sender_vk,
        sender_sig,
    }
}

fn sign_repo_tombstone(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    state_hex: &str,
    deleted_at: &str,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, _) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let state_bytes = match hex::decode(state_hex) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "state_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let current = match RepoState::from_bytes(&state_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("decode RepoState: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let owner_vk = repo_sk.verifying_key().to_bytes();
    if current.owner != owner_vk {
        return Response::Error {
            message: "repo key does not own this RepoState".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let desc_seq = current
        .description
        .as_ref()
        .map(|f| f.update_seq + 1)
        .unwrap_or(1);
    let ext_seq = current
        .extensions
        .get(DELETED_EXTENSION_KEY)
        .map(|e| e.update_seq + 1)
        .unwrap_or(1);
    let desc_value = format!("[deleted] Soft-deleted at {deleted_at}");
    let ext_value = format!(r#"{{"at":"{deleted_at}"}}"#).into_bytes();

    let mut delta = RepoState::default();
    delta.owner = owner_vk;
    delta.description = Some(sign_string_field(
        &params,
        &repo_sk,
        "description",
        desc_value,
        desc_seq,
    ));
    let ext = sign_extension(
        &params,
        &repo_sk,
        DELETED_EXTENSION_KEY,
        ext_value,
        ext_seq,
    );
    delta
        .extensions
        .insert(DELETED_EXTENSION_KEY.to_string(), ext);

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Response::SignedRepoTombstone { nonce, delta_hex only }
    // NEW CODE - TESTING: merge for Put-prefer (Update alone hits Request timeout)
    let merged = match update_state(&params, &current, &delta) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("merge tombstone delta: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };

    Response::SignedRepoTombstone {
        nonce: nonce.to_string(),
        delta_hex: hex::encode(delta.to_bytes()),
        state_hex: hex::encode(merged.to_bytes()),
    }
}

fn slug_repo_label(name: &str) -> String {
    if name.is_empty() {
        return "repo".to_string();
    }
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '~' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
}

fn sign_repo_rename(
    ctx: &mut DelegateCtx,
    nonce: &str,
    prefix: &str,
    state_hex: &str,
    name: &str,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let name = name.trim();
    if name.is_empty() {
        return Response::Error {
            message: "name must not be empty".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    if name.len() > limits::MAX_NAME_BYTES {
        return Response::Error {
            message: format!(
                "name exceeds {} bytes (got {})",
                limits::MAX_NAME_BYTES,
                name.len()
            ),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, _) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let state_bytes = match hex::decode(state_hex) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "state_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let current = match RepoState::from_bytes(&state_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("decode RepoState: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let owner_vk = repo_sk.verifying_key().to_bytes();
    if current.owner != owner_vk {
        return Response::Error {
            message: "repo key does not own this RepoState".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let name_seq = current
        .name
        .as_ref()
        .map(|f| f.update_seq + 1)
        .unwrap_or(1);

    let mut delta = RepoState::default();
    delta.owner = owner_vk;
    delta.name = Some(sign_string_field(
        &params,
        &repo_sk,
        "name",
        name.to_string(),
        name_seq,
    ));

    // NEW CODE - TESTING: merge for Put-prefer (Update alone hits Request timeout)
    let merged = match update_state(&params, &current, &delta) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("merge rename delta: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };

    let label = slug_repo_label(name);
    let mut repos = load_repos(ctx);
    if let Some(entry) = repos.repos.get_mut(prefix) {
        entry.label = label.clone();
        save_repos(ctx, &repos);
    } else {
        return Response::Error {
            message: format!("no local repo key for prefix {prefix}"),
            nonce: Some(nonce.to_string()),
        };
    }

    Response::SignedRepoRename {
        nonce: nonce.to_string(),
        delta_hex: hex::encode(delta.to_bytes()),
        state_hex: hex::encode(merged.to_bytes()),
        label,
        name: name.to_string(),
    }
}

// NEW CODE - TESTING: About description write (RepoState.description only)
fn sign_repo_description(
    ctx: &mut DelegateCtx,
    nonce: &str,
    prefix: &str,
    state_hex: &str,
    description: &str,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let description = description.trim();
    if description.len() > ABOUT_DESCRIPTION_MAX {
        return Response::Error {
            message: format!(
                "description exceeds {} characters (got {})",
                ABOUT_DESCRIPTION_MAX,
                description.len()
            ),
            nonce: Some(nonce.to_string()),
        };
    }
    if description.len() > limits::MAX_DESCRIPTION_BYTES {
        return Response::Error {
            message: format!(
                "description exceeds {} bytes (got {})",
                limits::MAX_DESCRIPTION_BYTES,
                description.len()
            ),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, _) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let state_bytes = match hex::decode(state_hex) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "state_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let current = match RepoState::from_bytes(&state_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("decode RepoState: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let owner_vk = repo_sk.verifying_key().to_bytes();
    if current.owner != owner_vk {
        return Response::Error {
            message: "repo key does not own this RepoState".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let desc_seq = current
        .description
        .as_ref()
        .map(|f| f.update_seq + 1)
        .unwrap_or(1);

    let mut delta = RepoState::default();
    delta.owner = owner_vk;
    delta.description = Some(sign_string_field(
        &params,
        &repo_sk,
        "description",
        description.to_string(),
        desc_seq,
    ));

    let merged = match update_state(&params, &current, &delta) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("merge description delta: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };

    Response::SignedRepoDescription {
        nonce: nonce.to_string(),
        delta_hex: hex::encode(delta.to_bytes()),
        state_hex: hex::encode(merged.to_bytes()),
        description: description.to_string(),
    }
}

const PAGES_EXTENSION_KEY: &str = "pages";
const PAGES_JSON_MAX: usize = 8_192;

// NEW CODE - TESTING: Pages meta on RepoState.extensions["pages"]
fn sign_repo_pages(
    ctx: &mut DelegateCtx,
    nonce: &str,
    prefix: &str,
    state_hex: &str,
    pages_json: &str,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let pages_json = pages_json.trim();
    if pages_json.is_empty() {
        return Response::Error {
            message: "pages_json required".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    if pages_json.len() > PAGES_JSON_MAX {
        return Response::Error {
            message: format!(
                "pages_json exceeds {} bytes (got {})",
                PAGES_JSON_MAX,
                pages_json.len()
            ),
            nonce: Some(nonce.to_string()),
        };
    }
    if serde_json::from_str::<serde_json::Value>(pages_json).is_err() {
        return Response::Error {
            message: "pages_json is not valid JSON".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, _) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let state_bytes = match hex::decode(state_hex) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "state_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let current = match RepoState::from_bytes(&state_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("decode RepoState: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let owner_vk = repo_sk.verifying_key().to_bytes();
    if current.owner != owner_vk {
        return Response::Error {
            message: "repo key does not own this RepoState".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let ext_seq = current
        .extensions
        .get(PAGES_EXTENSION_KEY)
        .map(|e| e.update_seq + 1)
        .unwrap_or(1);

    let mut delta = RepoState::default();
    delta.owner = owner_vk;
    let ext = sign_extension(
        &params,
        &repo_sk,
        PAGES_EXTENSION_KEY,
        pages_json.as_bytes().to_vec(),
        ext_seq,
    );
    delta
        .extensions
        .insert(PAGES_EXTENSION_KEY.to_string(), ext);

    let merged = match update_state(&params, &current, &delta) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("merge pages delta: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };

    Response::SignedRepoPages {
        nonce: nonce.to_string(),
        delta_hex: hex::encode(delta.to_bytes()),
        state_hex: hex::encode(merged.to_bytes()),
        pages_json: pages_json.to_string(),
    }
}

fn sign_push(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    state_hex: &str,
    pack_hash_hex: &str,
    size_bytes: u64,
    ref_name: &str,
    tip_hex: &str,
    manifest_hash_hex: Option<&str>,
    chunk_count: Option<u32>,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let (repo_sk, _) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let state_bytes = match hex::decode(state_hex) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "state_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let current = match RepoState::from_bytes(&state_bytes) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("decode RepoState: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let owner_vk = repo_sk.verifying_key().to_bytes();
    if current.owner != owner_vk {
        return Response::Error {
            message: "repo key does not own this RepoState".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let tip_raw = match hex::decode(tip_hex.trim()) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "tip_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let tip: [u8; 20] = match tip_raw.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            return Response::Error {
                message: "tip must be 20-byte SHA-1".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    let ref_name = ref_name.trim();
    if ref_name.is_empty() || !ref_name.starts_with("refs/") {
        return Response::Error {
            message: "ref_name must look like refs/heads/main".into(),
            nonce: Some(nonce.to_string()),
        };
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // let pack_hash_raw = match hex::decode(pack_hash_hex.trim()) { … };
    // let bundle = ObjectBundle::SinglePack { pack_hash, size_bytes };
    // NEW CODE - TESTING: SinglePack or ChunkedPack from optional manifest fields
    let bundle = if let Some(mh) = manifest_hash_hex.filter(|s| !s.trim().is_empty()) {
        let count = match chunk_count {
            Some(c) if c > 0 => c,
            _ => {
                return Response::Error {
                    message: "chunk_count required for ChunkedPack SignPush".into(),
                    nonce: Some(nonce.to_string()),
                };
            }
        };
        if size_bytes == 0 {
            return Response::Error {
                message: "size_bytes (total_size) required for ChunkedPack".into(),
                nonce: Some(nonce.to_string()),
            };
        }
        let manifest_hash_raw = match hex::decode(mh.trim()) {
            Ok(b) => b,
            Err(_) => {
                return Response::Error {
                    message: "manifest_hash_hex is not valid hex".into(),
                    nonce: Some(nonce.to_string()),
                };
            }
        };
        let manifest_hash: [u8; 32] = match manifest_hash_raw.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => {
                return Response::Error {
                    message: "manifest_hash must be 32 bytes".into(),
                    nonce: Some(nonce.to_string()),
                };
            }
        };
        ObjectBundle::ChunkedPack {
            manifest_hash,
            total_size: size_bytes,
            chunk_count: count,
        }
    } else {
        let pack_hash_raw = match hex::decode(pack_hash_hex.trim()) {
            Ok(b) => b,
            Err(_) => {
                return Response::Error {
                    message: "pack_hash_hex is not valid hex".into(),
                    nonce: Some(nonce.to_string()),
                };
            }
        };
        let pack_hash: [u8; 32] = match pack_hash_raw.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => {
                return Response::Error {
                    message: "pack_hash must be 32 bytes".into(),
                    nonce: Some(nonce.to_string()),
                };
            }
        };
        ObjectBundle::SinglePack {
            pack_hash,
            size_bytes,
        }
    };

    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let bundle_id = bundle.id();
    let new_seq = current
        .refs
        .get(ref_name)
        .map(|e| e.update_seq)
        .unwrap_or(0)
        + 1;

    let mut delta = RepoState::default();
    let record = sign_bundle_record(&params, &repo_sk, bundle, 0);
    delta.object_index.insert(bundle_id, record);
    let entry = sign_ref_entry(&params, &repo_sk, ref_name, tip, new_seq, 0);
    delta.refs.insert(ref_name.to_string(), entry);
    let (tip_ext_key, tip_entry) =
        sign_bundle_tip_extension(&params, &repo_sk, &bundle_id, &tip, 0);
    delta.extensions.insert(tip_ext_key, tip_entry);

    let merged = match update_state(&params, &current, &delta) {
        Ok(s) => s,
        Err(e) => {
            return Response::Error {
                message: format!("merge push delta: {e}"),
                nonce: Some(nonce.to_string()),
            };
        }
    };

    Response::SignedPush {
        nonce: nonce.to_string(),
        delta_hex: hex::encode(delta.to_bytes()),
        state_hex: hex::encode(merged.to_bytes()),
    }
}

fn create_repo(
    ctx: &mut DelegateCtx,
    nonce: &str,
    name: &str,
    description: &str,
    default_branch: &str,
) -> Response {
    if load_id_sk(ctx).is_err() {
        return Response::Error {
            message: "no identity — CreateIdentity first".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let sk_bytes = random_sk_bytes();
    let sk = SigningKey::from_bytes(&sk_bytes);
    let owner = sk.verifying_key().to_bytes();
    let prefix = pubkey_prefix(&owner, limits::DEFAULT_PREFIX_LEN);
    let params = RepoParams {
        prefix: prefix.clone(),
    };
    let state = initial_repo_state(&params, &sk, name, description, default_branch);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // let label = if name.is_empty() {
    //     "repo".to_string()
    // } else {
    //     name.chars()
    //         .map(|c| {
    //             if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '~' {
    //                 c
    //             } else {
    //                 '-'
    //             }
    //         })
    //         .collect::<String>()
    // };
    // NEW CODE - TESTING: shared slug helper (same as SignRepoRename)
    let label = slug_repo_label(name);
    let mut repos = load_repos(ctx);
    repos.repos.insert(
        prefix.clone(),
        StoredRepo {
            secret_hex: hex::encode(sk_bytes),
            label: label.clone(),
        },
    );
    save_repos(ctx, &repos);
    let url = format!("freenet::{prefix}/{label}");
    Response::CreatedRepo {
        nonce: nonce.to_string(),
        prefix,
        label,
        url,
        params_hex: hex::encode(params.to_bytes()),
        state_hex: hex::encode(state.to_bytes()),
        repo_owner_vk_b58: bs58::encode(&owner).into_string(),
    }
}

fn sign_vault(
    ctx: &DelegateCtx,
    vault_id: &str,
    username: &str,
    identity_fingerprint: &str,
    envelopes_json: &str,
    identity_dek_wrap_json: &str,
    api_key_wraps_json: &str,
    authorized_ops_json: &str,
    seq: u64,
    updated_at: &str,
    sig_kind: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let fp = fingerprint_of(&id_sk.verifying_key());
    if fp != identity_fingerprint {
        return Response::Error {
            message: "identity_fingerprint does not match loaded identity".into(),
            nonce: None,
        };
    }
    let dek_wrap = identity_dek_wrap_json.trim();
    if dek_wrap.is_empty() {
        return Response::Error {
            message: "identity_dek_wrap_json required for GitForge vault v4".into(),
            nonce: None,
        };
    }
    let wraps = if api_key_wraps_json.trim().is_empty() {
        "[]"
    } else {
        api_key_wraps_json.trim()
    };
    let ops = if authorized_ops_json.trim().is_empty() {
        "[]"
    } else {
        authorized_ops_json.trim()
    };
    let kind = if sig_kind.trim().is_empty() {
        "owner"
    } else {
        sig_kind.trim()
    };
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // v3 payload included identity_kdf_json + identity_cipher_json
    // NEW CODE - TESTING: passwordless v4 omits password cipher fields
    let mut payload = Vec::with_capacity(1024);
    payload.extend_from_slice(VAULT_SIGN_DOMAIN);
    push_field(&mut payload, vault_id.as_bytes());
    push_field(&mut payload, username.as_bytes());
    push_field(&mut payload, identity_fingerprint.as_bytes());
    push_field(&mut payload, envelopes_json.as_bytes());
    push_field(&mut payload, dek_wrap.as_bytes());
    push_field(&mut payload, wraps.as_bytes());
    push_field(&mut payload, ops.as_bytes());
    payload.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut payload, updated_at.as_bytes());
    push_field(&mut payload, kind.as_bytes());
    Response::SignedVault {
        owner_sig: hex::encode(id_sk.sign(&payload).to_bytes()),
    }
}

fn sign_profile(
    ctx: &DelegateCtx,
    username: &str,
    public_email: &str,
    bio: &str,
    url: &str,
    avatar: &str,
    inbox_pk_hex: &str,
    inbox_messages_json: &str,
    public_meta_json: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let identity_fingerprint = fingerprint_of(&id_sk.verifying_key());
    let inbox_msgs = if inbox_messages_json.trim().is_empty() {
        "[]"
    } else {
        inbox_messages_json.trim()
    };
    let meta: BTreeMap<String, String> = if public_meta_json.trim().is_empty() {
        BTreeMap::new()
    } else {
        match serde_json::from_str(public_meta_json.trim()) {
            Ok(m) => m,
            Err(e) => {
                return Response::Error {
                    message: format!("public_meta_json: {e}"),
                    nonce: None,
                };
            }
        }
    };
    let meta_json = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".into());
    let mut payload = Vec::with_capacity(512);
    payload.extend_from_slice(PROFILE_SIGN_DOMAIN);
    push_field(&mut payload, identity_fingerprint.as_bytes());
    push_field(&mut payload, username.as_bytes());
    push_field(&mut payload, public_email.as_bytes());
    push_field(&mut payload, bio.as_bytes());
    push_field(&mut payload, url.as_bytes());
    push_field(&mut payload, avatar.as_bytes());
    push_field(&mut payload, inbox_pk_hex.as_bytes());
    push_field(&mut payload, inbox_msgs.as_bytes());
    push_field(&mut payload, meta_json.as_bytes());
    payload.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut payload, updated_at.as_bytes());
    Response::SignedProfile {
        identity_fingerprint,
        username: username.to_string(),
        public_email: public_email.to_string(),
        bio: bio.to_string(),
        url: url.to_string(),
        avatar: avatar.to_string(),
        inbox_pk_hex: inbox_pk_hex.to_string(),
        inbox_messages_json: inbox_msgs.to_string(),
        public_meta_json: meta_json,
        seq,
        updated_at: updated_at.to_string(),
        owner_sig: hex::encode(id_sk.sign(&payload).to_bytes()),
    }
}

fn sign_repo_meta_upsert(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    seal_pk: &str,
    public_settings_json: &str,
    sealed_settings_json: &str,
    seq: u64,
    updated_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let (repo_sk, repo_owner_vk) = match load_repo_sk(ctx, prefix, nonce) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let fp = fingerprint_of(&id_sk.verifying_key());
    let public_settings: BTreeMap<String, String> = if public_settings_json.trim().is_empty() {
        BTreeMap::new()
    } else {
        match serde_json::from_str(public_settings_json.trim()) {
            Ok(m) => m,
            Err(e) => {
                return Response::Error {
                    message: format!("public_settings_json: {e}"),
                    nonce: Some(nonce.to_string()),
                };
            }
        }
    };
    let settings_json = serde_json::to_string(&public_settings).unwrap_or_else(|_| "{}".into());
    let sealed_settings: Option<RepoMetaSealedBlob> = if sealed_settings_json.trim().is_empty()
        || sealed_settings_json.trim() == "null"
    {
        None
    } else {
        match serde_json::from_str(sealed_settings_json.trim()) {
            Ok(s) => Some(s),
            Err(e) => {
                return Response::Error {
                    message: format!("sealed_settings_json: {e}"),
                    nonce: Some(nonce.to_string()),
                };
            }
        }
    };
    let sealed_field = sealed_settings
        .as_ref()
        .and_then(|s| serde_json::to_string(s).ok())
        .unwrap_or_default();
    let mut payload = Vec::with_capacity(512);
    payload.extend_from_slice(REPO_META_UPSERT_DOMAIN);
    push_field(&mut payload, prefix.as_bytes());
    push_field(&mut payload, repo_owner_vk.as_bytes());
    push_field(&mut payload, seal_pk.as_bytes());
    push_field(&mut payload, settings_json.as_bytes());
    push_field(&mut payload, sealed_field.as_bytes());
    push_field(&mut payload, fp.as_bytes());
    payload.extend_from_slice(&seq.to_le_bytes());
    push_field(&mut payload, updated_at.as_bytes());
    Response::SignedRepoMetaUpsert {
        nonce: nonce.to_string(),
        entry: RepoMetaUpsertEntry {
            schema_version: 1,
            repo_prefix: prefix.to_string(),
            repo_owner_vk,
            seal_pk: seal_pk.to_string(),
            public_settings,
            sealed_settings,
            identity_fingerprint: fp,
            attestation: "dual-sig-v1".into(),
            identity_sig: hex::encode(id_sk.sign(&payload).to_bytes()),
            repo_owner_sig: hex::encode(repo_sk.sign(&payload).to_bytes()),
            seq,
            updated_at: updated_at.to_string(),
        },
    }
}

fn sign_repo_meta_append_public(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    id: &str,
    body_b64: &str,
    created_at: &str,
    thread_id: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let sender_vk = bs58::encode(id_sk.verifying_key().as_bytes()).into_string();
    let mut payload = Vec::with_capacity(256);
    payload.extend_from_slice(REPO_META_APPEND_PUBLIC_DOMAIN);
    push_field(&mut payload, prefix.as_bytes());
    push_field(&mut payload, id.as_bytes());
    push_field(&mut payload, body_b64.as_bytes());
    push_field(&mut payload, created_at.as_bytes());
    push_field(&mut payload, sender_vk.as_bytes());
    push_field(&mut payload, thread_id.as_bytes());
    Response::SignedRepoMetaAppend {
        nonce: nonce.to_string(),
        kind: "public".into(),
        message: RepoMetaChannelMessage {
            id: id.to_string(),
            body_b64: Some(body_b64.to_string()),
            ciphertext_b64: None,
            created_at: created_at.to_string(),
            sender_vk,
            sender_sig: hex::encode(id_sk.sign(&payload).to_bytes()),
            thread_id: if thread_id.is_empty() {
                None
            } else {
                Some(thread_id.to_string())
            },
        },
    }
}

fn sign_repo_meta_append_private(
    ctx: &DelegateCtx,
    nonce: &str,
    prefix: &str,
    id: &str,
    ciphertext_b64: &str,
    created_at: &str,
    thread_id: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => {
            return match e {
                Response::Error { message, .. } => Response::Error {
                    message,
                    nonce: Some(nonce.to_string()),
                },
                other => other,
            };
        }
    };
    let sender_vk = bs58::encode(id_sk.verifying_key().as_bytes()).into_string();
    let mut payload = Vec::with_capacity(256);
    payload.extend_from_slice(REPO_META_APPEND_PRIVATE_DOMAIN);
    push_field(&mut payload, prefix.as_bytes());
    push_field(&mut payload, id.as_bytes());
    push_field(&mut payload, ciphertext_b64.as_bytes());
    push_field(&mut payload, created_at.as_bytes());
    push_field(&mut payload, sender_vk.as_bytes());
    push_field(&mut payload, thread_id.as_bytes());
    Response::SignedRepoMetaAppend {
        nonce: nonce.to_string(),
        kind: "private".into(),
        message: RepoMetaChannelMessage {
            id: id.to_string(),
            body_b64: None,
            ciphertext_b64: Some(ciphertext_b64.to_string()),
            created_at: created_at.to_string(),
            sender_vk,
            sender_sig: hex::encode(id_sk.sign(&payload).to_bytes()),
            thread_id: if thread_id.is_empty() {
                None
            } else {
                Some(thread_id.to_string())
            },
        },
    }
}

fn sign_star(
    ctx: &DelegateCtx,
    repo_prefix: &str,
    label: Option<String>,
    starred_at: &str,
) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let fingerprint = fingerprint_of(&id_sk.verifying_key());
    let label_field = label.as_deref().unwrap_or("");
    let mut payload = Vec::with_capacity(256);
    payload.extend_from_slice(STAR_DOMAIN);
    push_field(&mut payload, repo_prefix.as_bytes());
    push_field(&mut payload, fingerprint.as_bytes());
    push_field(&mut payload, label_field.as_bytes());
    push_field(&mut payload, starred_at.as_bytes());
    Response::SignedStar {
        fingerprint,
        repo_prefix: repo_prefix.to_string(),
        label,
        starred_at: starred_at.to_string(),
        sig: hex::encode(id_sk.sign(&payload).to_bytes()),
    }
}

fn sign_unstar(ctx: &DelegateCtx, repo_prefix: &str, starred_at: &str) -> Response {
    let id_sk = match load_id_sk(ctx) {
        Ok(k) => k,
        Err(e) => return e,
    };
    let fingerprint = fingerprint_of(&id_sk.verifying_key());
    let mut payload = Vec::with_capacity(256);
    payload.extend_from_slice(UNSTAR_DOMAIN);
    push_field(&mut payload, repo_prefix.as_bytes());
    push_field(&mut payload, fingerprint.as_bytes());
    push_field(&mut payload, starred_at.as_bytes());
    Response::SignedUnstar {
        fingerprint,
        repo_prefix: repo_prefix.to_string(),
        starred_at: starred_at.to_string(),
        sig: hex::encode(id_sk.sign(&payload).to_bytes()),
    }
}

#[delegate]
impl DelegateInterface for ForgeIdentityDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        _parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // match &origin {
        //     Some(MessageOrigin::WebApp(_)) => {}
        //     _ => return Err(DelegateError::Other("only web app calls accepted".into())),
        // }
        // NEW CODE - TESTING: WebApp (published SPA with shell authToken) OR
        // None (local command WS / CLI `gitforge-vault --import-local-delegate`).
        // Inter-delegate calls stay rejected — identity secrets stay owner-driven.
        match &origin {
            Some(MessageOrigin::WebApp(_)) | None => {}
            Some(MessageOrigin::Delegate(_)) => {
                return Err(DelegateError::Other(
                    "forge-identity does not accept inter-delegate calls".into(),
                ));
            }
            other => {
                return Err(DelegateError::Other(format!(
                    "forge-identity rejects origin {other:?}"
                )));
            }
        }

        match message {
            InboundDelegateMsg::ApplicationMessage(app_msg) => {
                let request: Request = serde_json::from_slice(&app_msg.payload)
                    .map_err(|e| DelegateError::Other(format!("invalid request: {e}")))?;

                let response = match request {
                    Request::CreateIdentity { name, email } => {
                        create_identity(ctx, &name, &email)
                    }
                    Request::GetIdentity => get_identity(ctx),
                    Request::ImportIdentity {
                        secret_key,
                        name,
                        email,
                    } => import_identity(ctx, &secret_key, &name, &email),
                    Request::ExportIdentity => export_identity(ctx),
                    Request::ExportRepos => export_repos(ctx),
                    Request::ImportRepoKey {
                        prefix,
                        secret_key,
                        label,
                    } => import_repo_key(ctx, &prefix, &secret_key, &label),
                    Request::RemoveRepoKey { prefix } => remove_repo_key(ctx, &prefix),
                    Request::ListRepos => list_repos(ctx),
                    Request::SignRegister {
                        nonce,
                        prefix,
                        label,
                        name,
                        description,
                        website,
                        topics,
                        public_meta_json,
                        seq,
                        updated_at,
                    } => sign_register(
                        ctx,
                        &nonce,
                        &prefix,
                        &label,
                        name,
                        description,
                        website,
                        topics,
                        &public_meta_json,
                        seq,
                        &updated_at,
                    ),
                    Request::SignUnregister {
                        nonce,
                        prefix,
                        seq,
                        updated_at,
                    } => sign_unregister(ctx, &nonce, &prefix, seq, &updated_at),
                    Request::SignContributorAdd {
                        nonce,
                        prefix,
                        seq,
                        updated_at,
                    } => sign_contributor_add(ctx, &nonce, &prefix, seq, &updated_at),
                    Request::SignContributorInvite {
                        nonce,
                        prefix,
                        invitee_fingerprint,
                        seq,
                        updated_at,
                    } => sign_contributor_invite(
                        ctx,
                        &nonce,
                        &prefix,
                        &invitee_fingerprint,
                        seq,
                        &updated_at,
                    ),
                    Request::SignContributorAcceptCoupon {
                        nonce,
                        prefix,
                        invitee_fingerprint,
                        repo_owner_vk,
                        repo_owner_sig,
                        seq,
                        updated_at,
                    } => sign_contributor_accept_coupon(
                        ctx,
                        &nonce,
                        &prefix,
                        &invitee_fingerprint,
                        &repo_owner_vk,
                        &repo_owner_sig,
                        seq,
                        &updated_at,
                    ),
                    Request::SignContributorRemove {
                        nonce,
                        prefix,
                        contributor_fingerprint,
                        seq,
                        updated_at,
                    } => sign_contributor_remove(
                        ctx,
                        &nonce,
                        &prefix,
                        contributor_fingerprint,
                        seq,
                        &updated_at,
                    ),
                    Request::SignPendingInviteAdd {
                        nonce,
                        prefix,
                        invitee_fingerprint,
                        seq,
                        updated_at,
                    } => sign_pending_invite_add(
                        ctx,
                        &nonce,
                        &prefix,
                        &invitee_fingerprint,
                        seq,
                        &updated_at,
                    ),
                    Request::SignPendingInviteCancel {
                        nonce,
                        prefix,
                        invitee_fingerprint,
                        seq,
                        updated_at,
                    } => sign_pending_invite_cancel(
                        ctx,
                        &nonce,
                        &prefix,
                        &invitee_fingerprint,
                        seq,
                        &updated_at,
                    ),
                    Request::SignPendingInviteDecline {
                        nonce,
                        prefix,
                        invitee_fingerprint,
                        repo_owner_vk,
                        seq,
                        updated_at,
                    } => sign_pending_invite_decline(
                        ctx,
                        &nonce,
                        &prefix,
                        &invitee_fingerprint,
                        &repo_owner_vk,
                        seq,
                        &updated_at,
                    ),
                    Request::SignInboxAppend {
                        nonce,
                        recipient_fingerprint,
                        id,
                        ciphertext_b64,
                        created_at,
                    } => sign_inbox_append(
                        ctx,
                        &nonce,
                        &recipient_fingerprint,
                        &id,
                        &ciphertext_b64,
                        &created_at,
                    ),
                    Request::SignRepoTombstone {
                        nonce,
                        prefix,
                        state_hex,
                        deleted_at,
                    } => sign_repo_tombstone(ctx, &nonce, &prefix, &state_hex, &deleted_at),
                    Request::SignRepoRename {
                        nonce,
                        prefix,
                        state_hex,
                        name,
                    } => sign_repo_rename(ctx, &nonce, &prefix, &state_hex, &name),
                    Request::SignRepoDescription {
                        nonce,
                        prefix,
                        state_hex,
                        description,
                    } => sign_repo_description(ctx, &nonce, &prefix, &state_hex, &description),
                    Request::SignRepoPages {
                        nonce,
                        prefix,
                        state_hex,
                        pages_json,
                    } => sign_repo_pages(ctx, &nonce, &prefix, &state_hex, &pages_json),
                    Request::SignPush {
                        nonce,
                        prefix,
                        state_hex,
                        pack_hash_hex,
                        size_bytes,
                        ref_name,
                        tip_hex,
                        manifest_hash_hex,
                        chunk_count,
                    } => sign_push(
                        ctx,
                        &nonce,
                        &prefix,
                        &state_hex,
                        &pack_hash_hex,
                        size_bytes,
                        &ref_name,
                        &tip_hex,
                        manifest_hash_hex.as_deref(),
                        chunk_count,
                    ),
                    Request::CreateRepo {
                        nonce,
                        name,
                        description,
                        default_branch,
                    } => create_repo(ctx, &nonce, &name, &description, &default_branch),
                    Request::Logout => {
                        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                        // ctx.delete_secret(SECRET_ID_SK);
                        // ctx.delete_secret(SECRET_ID_NAME);
                        // ctx.delete_secret(SECRET_ID_EMAIL);
                        // ctx.delete_secret(SECRET_REPOS);
                        // NEW CODE - TESTING: also wipe durable backup pins + tip pack blobs
                        let _ = ctx.remove_secret(SECRET_ID_SK);
                        let _ = ctx.remove_secret(SECRET_ID_NAME);
                        let _ = ctx.remove_secret(SECRET_ID_EMAIL);
                        let _ = ctx.remove_secret(SECRET_REPOS);
                        let _ = ctx.remove_secret(SECRET_REPO_BACKUPS);
                        clear_all_backup_blobs(ctx);
                        Response::LoggedOut
                    }
                    Request::SignVault {
                        vault_id,
                        username,
                        identity_fingerprint,
                        envelopes_json,
                        identity_dek_wrap_json,
                        api_key_wraps_json,
                        authorized_ops_json,
                        seq,
                        updated_at,
                        sig_kind,
                    } => sign_vault(
                        ctx,
                        &vault_id,
                        &username,
                        &identity_fingerprint,
                        &envelopes_json,
                        &identity_dek_wrap_json,
                        &api_key_wraps_json,
                        &authorized_ops_json,
                        seq,
                        &updated_at,
                        &sig_kind,
                    ),
                    Request::SignProfile {
                        username,
                        public_email,
                        bio,
                        url,
                        avatar,
                        inbox_pk_hex,
                        inbox_messages_json,
                        public_meta_json,
                        seq,
                        updated_at,
                    } => sign_profile(
                        ctx,
                        &username,
                        &public_email,
                        &bio,
                        &url,
                        &avatar,
                        &inbox_pk_hex,
                        &inbox_messages_json,
                        &public_meta_json,
                        seq,
                        &updated_at,
                    ),
                    Request::SignRepoMetaUpsert {
                        nonce,
                        prefix,
                        seal_pk,
                        public_settings_json,
                        sealed_settings_json,
                        seq,
                        updated_at,
                    } => sign_repo_meta_upsert(
                        ctx,
                        &nonce,
                        &prefix,
                        &seal_pk,
                        &public_settings_json,
                        &sealed_settings_json,
                        seq,
                        &updated_at,
                    ),
                    Request::SignRepoMetaAppendPublic {
                        nonce,
                        prefix,
                        id,
                        body_b64,
                        created_at,
                        thread_id,
                    } => sign_repo_meta_append_public(
                        ctx,
                        &nonce,
                        &prefix,
                        &id,
                        &body_b64,
                        &created_at,
                        &thread_id,
                    ),
                    Request::SignRepoMetaAppendPrivate {
                        nonce,
                        prefix,
                        id,
                        ciphertext_b64,
                        created_at,
                        thread_id,
                    } => sign_repo_meta_append_private(
                        ctx,
                        &nonce,
                        &prefix,
                        &id,
                        &ciphertext_b64,
                        &created_at,
                        &thread_id,
                    ),
                    Request::SignStar {
                        repo_prefix,
                        label,
                        starred_at,
                    } => sign_star(ctx, &repo_prefix, label, &starred_at),
                    Request::SignUnstar {
                        repo_prefix,
                        starred_at,
                    } => sign_unstar(ctx, &repo_prefix, &starred_at),
                    Request::UpsertRepoBackupPin { pin_json } => {
                        upsert_repo_backup_pin(ctx, &pin_json)
                    }
                    Request::RemoveRepoBackupPin { prefix, reason } => {
                        remove_repo_backup_pin(ctx, &prefix, reason.as_deref())
                    }
                    Request::ListRepoBackupPins => list_repo_backup_pins(ctx),
                    // NEW CODE - TESTING: durable tip pack bytes on the identity node
                    Request::UpsertRepoBackupBlob {
                        hash_hex,
                        bytes_hex,
                    } => upsert_repo_backup_blob(ctx, &hash_hex, &bytes_hex),
                    Request::GetRepoBackupBlob { hash_hex } => {
                        get_repo_backup_blob(ctx, &hash_hex)
                    }
                    Request::RemoveRepoBackupBlob { hash_hex } => {
                        remove_repo_backup_blob(ctx, &hash_hex)
                    }
                    Request::ListRepoBackupBlobHashes => list_repo_backup_blob_hashes(ctx),
                };

                let response_bytes = serde_json::to_vec(&response)
                    .map_err(|e| DelegateError::Other(format!("serialize error: {e}")))?;
                Ok(vec![OutboundDelegateMsg::ApplicationMessage(
                    ApplicationMessage::new(response_bytes),
                )])
            }
            _ => Err(DelegateError::Other("unexpected message type".into())),
        }
    }
}
