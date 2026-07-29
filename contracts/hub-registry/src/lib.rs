//! HubRegistry Freenet contract — public Discover/People listings.
//!
//! Accepts only `attestation: "dual-sig-v1"` entries. Bridge
//! `local-bundle-v1` stays on the Express Hub; it is rejected here.
//! Soft-unregister via `{ "remove": … }` + `removed` tombstones.

#![allow(unexpected_cfgs)]

use ed25519_compact::{PublicKey, Signature};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const SIGN_DOMAIN: &[u8] = b"gitatlas.register.v2\0";
const UNREGISTER_DOMAIN: &[u8] = b"gitatlas.unregister.v1\0";
// NEW CODE - TESTING: verified contributor (site-key holder + their identity)
const CONTRIBUTOR_ADD_DOMAIN: &[u8] = b"gitatlas.contributor.add.v1\0";
const CONTRIBUTOR_REMOVE_DOMAIN: &[u8] = b"gitatlas.contributor.remove.v1\0";
// NEW CODE - TESTING: pending collaborator invites (repo-level, not inbox)
const PENDING_INVITE_ADD_DOMAIN: &[u8] = b"gitatlas.pending-invite.add.v1\0";
const PENDING_INVITE_REMOVE_DOMAIN: &[u8] = b"gitatlas.pending-invite.remove.v1\0";
const MIN_PREFIX_LEN: usize = 8;
const MAX_PREFIX_LEN: usize = 24;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubRegistryEntry {
    pub schema_version: u32,
    pub repo_prefix: String,
    pub label: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// Project / homepage URL (About sidebar). Empty = unset.
    #[serde(default)]
    pub website: Option<String>,
    /// Custom tags for About / future Discover search.
    #[serde(default)]
    pub topics: Vec<String>,
    /// Light adaptive Discover flags (SPA conventions).
    #[serde(default)]
    pub public_meta: BTreeMap<String, String>,
    pub identity_fingerprint: String,
    pub identity_name: String,
    pub identity_email: Option<String>,
    /// Base58 of the 32-byte repo owner verifying key (required for dual-sig).
    pub repo_owner_vk: String,
    pub attestation: String,
    pub identity_sig: Option<String>,
    pub repo_owner_sig: Option<String>,
    pub seq: u64,
    pub updated_at: String,
}

/// Dual-signed soft-unregister op (Discover drop). Kept in `removed` so
/// peer merges do not resurrect listings until a higher-seq upsert.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubRegistryRemove {
    pub schema_version: u32,
    pub repo_prefix: String,
    pub identity_fingerprint: String,
    pub repo_owner_vk: String,
    pub attestation: String,
    pub identity_sig: Option<String>,
    pub repo_owner_sig: Option<String>,
    pub seq: u64,
    pub updated_at: String,
}

/// Dual-signed contributor grant (separate from listing owner).
/// Keyed under `state.contributors[repo_prefix][identity_fingerprint]`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubRegistryContributor {
    pub schema_version: u32,
    pub repo_prefix: String,
    /// Contributor identity (`freenet:id:…`), not the listing owner.
    pub identity_fingerprint: String,
    pub repo_owner_vk: String,
    pub attestation: String,
    pub identity_sig: Option<String>,
    pub repo_owner_sig: Option<String>,
    pub seq: u64,
    pub updated_at: String,
}

/// Pending collaborator invite (repo-level).
/// Keyed under `state.pending_invites[repo_prefix][invitee_fingerprint]`.
///
/// Add: listing owner identity + site key.
/// Remove: listing owner + site key (cancel), or invitee identity alone (decline).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubRegistryPendingInvite {
    pub schema_version: u32,
    pub repo_prefix: String,
    /// Invitee identity (`freenet:id:…`).
    pub identity_fingerprint: String,
    pub repo_owner_vk: String,
    pub attestation: String,
    pub identity_sig: Option<String>,
    pub repo_owner_sig: Option<String>,
    pub seq: u64,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct HubRegistryState {
    pub schema_version: u32,
    pub repos: BTreeMap<String, HubRegistryEntry>,
    #[serde(default)]
    pub removed: BTreeMap<String, HubRegistryRemove>,
    /// Accepted collaborators per repo_prefix → fingerprint.
    #[serde(default)]
    pub contributors: BTreeMap<String, BTreeMap<String, HubRegistryContributor>>,
    /// Outstanding invites per repo_prefix → invitee fingerprint.
    #[serde(default)]
    pub pending_invites: BTreeMap<String, BTreeMap<String, HubRegistryPendingInvite>>,
}

impl HubRegistryState {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            repos: BTreeMap::new(),
            removed: BTreeMap::new(),
            contributors: BTreeMap::new(),
            pending_invites: BTreeMap::new(),
        }
    }
}

/// Canonical topics string for signing: lowercased, sorted, comma-joined.
pub fn topics_canonical(topics: &[String]) -> String {
    let mut cleaned: Vec<String> = topics
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    cleaned.sort();
    cleaned.dedup();
    cleaned.join(",")
}

/// Canonical bytes both keys must sign (excludes signature fields).
pub fn signing_payload(entry: &HubRegistryEntry) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(SIGN_DOMAIN);
    push_field(&mut out, entry.repo_prefix.as_bytes());
    push_field(&mut out, entry.label.as_bytes());
    push_field(
        &mut out,
        entry.name.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(
        &mut out,
        entry.description.as_deref().unwrap_or("").as_bytes(),
    );
    // NEW CODE - TESTING: website + topics after description
    push_field(
        &mut out,
        entry.website.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(&mut out, topics_canonical(&entry.topics).as_bytes());
    push_field(&mut out, entry.identity_fingerprint.as_bytes());
    push_field(&mut out, entry.identity_name.as_bytes());
    push_field(
        &mut out,
        entry.identity_email.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(&mut out, entry.repo_owner_vk.as_bytes());
    // NEW CODE - TESTING: public_meta before seq (register.v2)
    let meta_json = serde_json::to_string(&entry.public_meta).unwrap_or_else(|_| "{}".into());
    push_field(&mut out, meta_json.as_bytes());
    out.extend_from_slice(&entry.seq.to_le_bytes());
    push_field(&mut out, entry.updated_at.as_bytes());
    out
}

pub fn unregister_signing_payload(op: &HubRegistryRemove) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(UNREGISTER_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.identity_fingerprint.as_bytes());
    push_field(&mut out, op.repo_owner_vk.as_bytes());
    out.extend_from_slice(&op.seq.to_le_bytes());
    push_field(&mut out, op.updated_at.as_bytes());
    out
}

pub fn contributor_add_signing_payload(op: &HubRegistryContributor) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(CONTRIBUTOR_ADD_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.identity_fingerprint.as_bytes());
    push_field(&mut out, op.repo_owner_vk.as_bytes());
    out.extend_from_slice(&op.seq.to_le_bytes());
    push_field(&mut out, op.updated_at.as_bytes());
    out
}

pub fn contributor_remove_signing_payload(op: &HubRegistryContributor) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(CONTRIBUTOR_REMOVE_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.identity_fingerprint.as_bytes());
    push_field(&mut out, op.repo_owner_vk.as_bytes());
    out.extend_from_slice(&op.seq.to_le_bytes());
    push_field(&mut out, op.updated_at.as_bytes());
    out
}

pub fn pending_invite_add_signing_payload(op: &HubRegistryPendingInvite) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(PENDING_INVITE_ADD_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.identity_fingerprint.as_bytes());
    push_field(&mut out, op.repo_owner_vk.as_bytes());
    out.extend_from_slice(&op.seq.to_le_bytes());
    push_field(&mut out, op.updated_at.as_bytes());
    out
}

pub fn pending_invite_remove_signing_payload(op: &HubRegistryPendingInvite) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(PENDING_INVITE_REMOVE_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.identity_fingerprint.as_bytes());
    push_field(&mut out, op.repo_owner_vk.as_bytes());
    out.extend_from_slice(&op.seq.to_le_bytes());
    push_field(&mut out, op.updated_at.as_bytes());
    out
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

fn decode_vk_b58(s: &str) -> Result<[u8; 32], String> {
    let bytes = bs58::decode(s)
        .into_vec()
        .map_err(|e| format!("base58 decode: {e}"))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("verifying key must be 32 bytes, got {}", bytes.len()))
}

fn identity_vk_from_fingerprint(fp: &str) -> Result<[u8; 32], String> {
    let rest = fp
        .strip_prefix("freenet:id:")
        .ok_or_else(|| "identity_fingerprint must start with freenet:id:".to_string())?;
    decode_vk_b58(rest)
}

fn verify_ed25519(vk: &[u8; 32], sig_hex: &str, payload: &[u8]) -> Result<(), String> {
    let sig_bytes = hex::decode(sig_hex).map_err(|e| format!("sig hex: {e}"))?;
    if sig_bytes.len() != 64 {
        return Err(format!("signature must be 64 bytes, got {}", sig_bytes.len()));
    }
    let pk = PublicKey::from_slice(vk).map_err(|e| format!("public key: {e}"))?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("signature: {e}"))?;
    pk.verify(payload, &sig)
        .map_err(|_| "ed25519 verification failed".to_string())
}

fn pubkey_prefix(vk: &[u8; 32], len: usize) -> String {
    let encoded = bs58::encode(vk).into_string();
    let take = len.min(encoded.len());
    encoded[..take].to_string()
}

fn validate_entry(entry: &HubRegistryEntry) -> Result<(), String> {
    if entry.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", entry.schema_version));
    }
    if entry.attestation != "dual-sig-v1" {
        return Err(format!(
            "HubRegistry WASM only accepts dual-sig-v1, got {}",
            entry.attestation
        ));
    }
    let plen = entry.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    if entry.label.is_empty() || entry.label.len() > 128 {
        return Err("label length invalid".into());
    }
    if entry.public_meta.len() > 32 {
        return Err("public_meta has too many keys".into());
    }
    for (k, v) in &entry.public_meta {
        if k.is_empty() || k.len() > 64 {
            return Err("public_meta key length invalid".into());
        }
        if v.len() > 1024 {
            return Err("public_meta value too long".into());
        }
    }
    let id_vk = identity_vk_from_fingerprint(&entry.identity_fingerprint)?;
    let repo_vk = decode_vk_b58(&entry.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != entry.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let id_sig = entry
        .identity_sig
        .as_deref()
        .ok_or("missing identity_sig")?;
    let repo_sig = entry
        .repo_owner_sig
        .as_deref()
        .ok_or("missing repo_owner_sig")?;
    let payload = signing_payload(entry);
    verify_ed25519(&id_vk, id_sig, &payload)?;
    verify_ed25519(&repo_vk, repo_sig, &payload)?;
    Ok(())
}

fn validate_remove(op: &HubRegistryRemove) -> Result<(), String> {
    if op.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", op.schema_version));
    }
    if op.attestation != "dual-sig-v1" {
        return Err(format!(
            "HubRegistry WASM only accepts dual-sig-v1, got {}",
            op.attestation
        ));
    }
    let plen = op.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    let id_vk = identity_vk_from_fingerprint(&op.identity_fingerprint)?;
    let repo_vk = decode_vk_b58(&op.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != op.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let id_sig = op.identity_sig.as_deref().ok_or("missing identity_sig")?;
    let repo_sig = op.repo_owner_sig.as_deref().ok_or("missing repo_owner_sig")?;
    let payload = unregister_signing_payload(op);
    verify_ed25519(&id_vk, id_sig, &payload)?;
    verify_ed25519(&repo_vk, repo_sig, &payload)?;
    Ok(())
}

/// Contributor add: dual-sig by **contributor identity** + **repo site key**.
/// Listing must already exist; contributor cannot be the listing owner.
fn validate_contributor_add(
    state: &HubRegistryState,
    op: &HubRegistryContributor,
) -> Result<(), String> {
    if op.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", op.schema_version));
    }
    if op.attestation != "dual-sig-v1" {
        return Err(format!(
            "HubRegistry WASM only accepts dual-sig-v1, got {}",
            op.attestation
        ));
    }
    let listing = state.repos.get(&op.repo_prefix).ok_or_else(|| {
        format!(
            "cannot add contributor: repo_prefix {} is not listed",
            op.repo_prefix
        )
    })?;
    if op.identity_fingerprint == listing.identity_fingerprint {
        return Err("listing owner is not listed as a contributor".into());
    }
    if op.repo_owner_vk != listing.repo_owner_vk {
        return Err("repo_owner_vk does not match listing".into());
    }
    let plen = op.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    let id_vk = identity_vk_from_fingerprint(&op.identity_fingerprint)?;
    let repo_vk = decode_vk_b58(&op.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != op.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let id_sig = op.identity_sig.as_deref().ok_or("missing identity_sig")?;
    let repo_sig = op.repo_owner_sig.as_deref().ok_or("missing repo_owner_sig")?;
    let payload = contributor_add_signing_payload(op);
    verify_ed25519(&id_vk, id_sig, &payload)?;
    verify_ed25519(&repo_vk, repo_sig, &payload)?;
    Ok(())
}

/// Contributor remove: dual-sig by **listing owner identity** + **repo site key**,
/// or by the **contributor themselves** + repo site key.
fn validate_contributor_remove(
    state: &HubRegistryState,
    op: &HubRegistryContributor,
) -> Result<(), String> {
    if op.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", op.schema_version));
    }
    if op.attestation != "dual-sig-v1" {
        return Err(format!(
            "HubRegistry WASM only accepts dual-sig-v1, got {}",
            op.attestation
        ));
    }
    let listing = state.repos.get(&op.repo_prefix).ok_or_else(|| {
        format!(
            "cannot remove contributor: repo_prefix {} is not listed",
            op.repo_prefix
        )
    })?;
    if op.repo_owner_vk != listing.repo_owner_vk {
        return Err("repo_owner_vk does not match listing".into());
    }
    let plen = op.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    let repo_vk = decode_vk_b58(&op.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != op.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let id_sig = op.identity_sig.as_deref().ok_or("missing identity_sig")?;
    let repo_sig = op.repo_owner_sig.as_deref().ok_or("missing repo_owner_sig")?;
    let payload = contributor_remove_signing_payload(op);
    // Signer is either listing owner or the contributor being removed.
    let owner_vk = identity_vk_from_fingerprint(&listing.identity_fingerprint)?;
    let contrib_vk = identity_vk_from_fingerprint(&op.identity_fingerprint)?;
    let owner_ok = verify_ed25519(&owner_vk, id_sig, &payload).is_ok();
    let self_ok = verify_ed25519(&contrib_vk, id_sig, &payload).is_ok();
    if !owner_ok && !self_ok {
        return Err("identity_sig must be listing owner or the contributor".into());
    }
    verify_ed25519(&repo_vk, repo_sig, &payload)?;
    Ok(())
}

/// Pending invite add: listing **owner identity** + **site key**.
fn validate_pending_invite_add(
    state: &HubRegistryState,
    op: &HubRegistryPendingInvite,
) -> Result<(), String> {
    if op.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", op.schema_version));
    }
    if op.attestation != "dual-sig-v1" {
        return Err(format!(
            "HubRegistry WASM only accepts dual-sig-v1, got {}",
            op.attestation
        ));
    }
    let listing = state.repos.get(&op.repo_prefix).ok_or_else(|| {
        format!(
            "cannot add pending invite: repo_prefix {} is not listed",
            op.repo_prefix
        )
    })?;
    if op.identity_fingerprint == listing.identity_fingerprint {
        return Err("cannot invite the listing owner".into());
    }
    if op.repo_owner_vk != listing.repo_owner_vk {
        return Err("repo_owner_vk does not match listing".into());
    }
    if state
        .contributors
        .get(&op.repo_prefix)
        .and_then(|m| m.get(&op.identity_fingerprint))
        .is_some()
    {
        return Err("identity is already a verified contributor".into());
    }
    let plen = op.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    let owner_vk = identity_vk_from_fingerprint(&listing.identity_fingerprint)?;
    let repo_vk = decode_vk_b58(&op.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != op.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let _ = identity_vk_from_fingerprint(&op.identity_fingerprint)?;
    let id_sig = op.identity_sig.as_deref().ok_or("missing identity_sig")?;
    let repo_sig = op.repo_owner_sig.as_deref().ok_or("missing repo_owner_sig")?;
    let payload = pending_invite_add_signing_payload(op);
    verify_ed25519(&owner_vk, id_sig, &payload)?;
    verify_ed25519(&repo_vk, repo_sig, &payload)?;
    Ok(())
}

/// Pending invite remove: owner dual-sig (cancel) **or** invitee identity alone (decline).
fn validate_pending_invite_remove(
    state: &HubRegistryState,
    op: &HubRegistryPendingInvite,
) -> Result<(), String> {
    if op.schema_version != 1 {
        return Err(format!("unsupported schema_version {}", op.schema_version));
    }
    if op.attestation != "dual-sig-v1" && op.attestation != "invitee-decline-v1" {
        return Err(format!(
            "unsupported pending-invite remove attestation {}",
            op.attestation
        ));
    }
    let listing = state.repos.get(&op.repo_prefix).ok_or_else(|| {
        format!(
            "cannot remove pending invite: repo_prefix {} is not listed",
            op.repo_prefix
        )
    })?;
    if op.repo_owner_vk != listing.repo_owner_vk {
        return Err("repo_owner_vk does not match listing".into());
    }
    let plen = op.repo_prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    let repo_vk = decode_vk_b58(&op.repo_owner_vk)?;
    if pubkey_prefix(&repo_vk, plen) != op.repo_prefix {
        return Err("repo_owner_vk does not match repo_prefix".into());
    }
    let id_sig = op.identity_sig.as_deref().ok_or("missing identity_sig")?;
    let payload = pending_invite_remove_signing_payload(op);
    let owner_vk = identity_vk_from_fingerprint(&listing.identity_fingerprint)?;
    let invitee_vk = identity_vk_from_fingerprint(&op.identity_fingerprint)?;
    let owner_ok = verify_ed25519(&owner_vk, id_sig, &payload).is_ok();
    let invitee_ok = verify_ed25519(&invitee_vk, id_sig, &payload).is_ok();
    if owner_ok {
        let repo_sig = op
            .repo_owner_sig
            .as_deref()
            .ok_or("missing repo_owner_sig for owner cancel")?;
        verify_ed25519(&repo_vk, repo_sig, &payload)?;
        return Ok(());
    }
    if invitee_ok {
        // Decline before site-key import — identity proof is enough.
        return Ok(());
    }
    Err("identity_sig must be listing owner (with site key) or the invitee".into())
}

fn clear_pending_invite(state: &mut HubRegistryState, prefix: &str, fingerprint: &str) {
    if let Some(by_prefix) = state.pending_invites.get_mut(prefix) {
        by_prefix.remove(fingerprint);
        if by_prefix.is_empty() {
            state.pending_invites.remove(prefix);
        }
    }
}

fn parse_state(bytes: &[u8]) -> Result<HubRegistryState, ContractError> {
    if bytes.is_empty() {
        return Ok(HubRegistryState::empty());
    }
    serde_json::from_slice(bytes).map_err(|e| ContractError::Deser(e.to_string()))
}

fn tombstone_blocks(state: &HubRegistryState, prefix: &str, seq: u64) -> bool {
    state
        .removed
        .get(prefix)
        .map(|t| t.seq >= seq)
        .unwrap_or(false)
}

fn merge_entry(
    state: &mut HubRegistryState,
    entry: HubRegistryEntry,
) -> Result<(), ContractError> {
    validate_entry(&entry).map_err(ContractError::Other)?;
    if tombstone_blocks(state, &entry.repo_prefix, entry.seq) {
        return Err(ContractError::Other(format!(
            "upsert seq {} blocked by remove tombstone",
            entry.seq
        )));
    }
    match state.repos.get(&entry.repo_prefix) {
        None => {
            state.removed.remove(&entry.repo_prefix);
            state.repos.insert(entry.repo_prefix.clone(), entry);
        }
        Some(existing) => {
            if existing.identity_fingerprint != entry.identity_fingerprint {
                return Err(ContractError::Other(
                    "different identity cannot overwrite repo_prefix".into(),
                ));
            }
            if entry.seq <= existing.seq {
                return Err(ContractError::Other(format!(
                    "seq must increase (have {}, got {})",
                    existing.seq, entry.seq
                )));
            }
            state.removed.remove(&entry.repo_prefix);
            state.repos.insert(entry.repo_prefix.clone(), entry);
        }
    }
    Ok(())
}

fn apply_remove(
    state: &mut HubRegistryState,
    op: HubRegistryRemove,
) -> Result<(), ContractError> {
    validate_remove(&op).map_err(ContractError::Other)?;
    if let Some(existing_tomb) = state.removed.get(&op.repo_prefix) {
        if op.seq <= existing_tomb.seq {
            return Err(ContractError::Other(format!(
                "remove seq must increase (have {}, got {})",
                existing_tomb.seq, op.seq
            )));
        }
    }
    match state.repos.get(&op.repo_prefix) {
        None => {
            // Allow tombstone when already absent (idempotent unregister).
        }
        Some(existing) => {
            if existing.identity_fingerprint != op.identity_fingerprint {
                return Err(ContractError::Other(
                    "different identity cannot remove repo_prefix".into(),
                ));
            }
            if op.seq <= existing.seq {
                return Err(ContractError::Other(format!(
                    "remove seq must increase (have {}, got {})",
                    existing.seq, op.seq
                )));
            }
            state.repos.remove(&op.repo_prefix);
        }
    }
    state.repos.remove(&op.repo_prefix);
    state.contributors.remove(&op.repo_prefix);
    state.pending_invites.remove(&op.repo_prefix);
    state.removed.insert(op.repo_prefix.clone(), op);
    Ok(())
}

fn apply_contributor_add(
    state: &mut HubRegistryState,
    op: HubRegistryContributor,
) -> Result<(), ContractError> {
    validate_contributor_add(state, &op).map_err(ContractError::Other)?;
    let prefix = op.repo_prefix.clone();
    let fp = op.identity_fingerprint.clone();
    {
        let by_prefix = state.contributors.entry(prefix.clone()).or_default();
        if let Some(existing) = by_prefix.get(&fp) {
            if op.seq <= existing.seq {
                // Idempotent accept / retry — still drop any leftover pending.
            } else {
                by_prefix.insert(fp.clone(), op);
            }
        } else {
            by_prefix.insert(fp.clone(), op);
        }
    }
    clear_pending_invite(state, &prefix, &fp);
    Ok(())
}

fn apply_contributor_remove(
    state: &mut HubRegistryState,
    op: HubRegistryContributor,
) -> Result<(), ContractError> {
    validate_contributor_remove(state, &op).map_err(ContractError::Other)?;
    if let Some(by_prefix) = state.contributors.get_mut(&op.repo_prefix) {
        by_prefix.remove(&op.identity_fingerprint);
        if by_prefix.is_empty() {
            state.contributors.remove(&op.repo_prefix);
        }
    }
    Ok(())
}

fn apply_pending_invite_add(
    state: &mut HubRegistryState,
    op: HubRegistryPendingInvite,
) -> Result<(), ContractError> {
    validate_pending_invite_add(state, &op).map_err(ContractError::Other)?;
    let by_prefix = state
        .pending_invites
        .entry(op.repo_prefix.clone())
        .or_default();
    if let Some(existing) = by_prefix.get(&op.identity_fingerprint) {
        if op.seq <= existing.seq {
            return Ok(());
        }
    }
    by_prefix.insert(op.identity_fingerprint.clone(), op);
    Ok(())
}

fn apply_pending_invite_remove(
    state: &mut HubRegistryState,
    op: HubRegistryPendingInvite,
) -> Result<(), ContractError> {
    validate_pending_invite_remove(state, &op).map_err(ContractError::Other)?;
    clear_pending_invite(state, &op.repo_prefix, &op.identity_fingerprint);
    Ok(())
}

fn merge_states(
    mut current: HubRegistryState,
    incoming: HubRegistryState,
) -> Result<HubRegistryState, ContractError> {
    if incoming.schema_version != 0 && incoming.schema_version != 1 {
        return Err(ContractError::Other(format!(
            "bad schema_version {}",
            incoming.schema_version
        )));
    }
    current.schema_version = 1;

    for (_, op) in incoming.removed {
        if validate_remove(&op).is_err() {
            continue;
        }
        match current.removed.get(&op.repo_prefix) {
            None => {
                if let Some(live) = current.repos.get(&op.repo_prefix) {
                    if live.identity_fingerprint == op.identity_fingerprint && op.seq > live.seq {
                        current.repos.remove(&op.repo_prefix);
                        current.contributors.remove(&op.repo_prefix);
                        current.pending_invites.remove(&op.repo_prefix);
                        current.removed.insert(op.repo_prefix.clone(), op);
                    }
                } else {
                    current.removed.insert(op.repo_prefix.clone(), op);
                }
            }
            Some(existing) => {
                if op.seq > existing.seq {
                    if let Some(live) = current.repos.get(&op.repo_prefix) {
                        if live.identity_fingerprint == op.identity_fingerprint && op.seq > live.seq
                        {
                            current.repos.remove(&op.repo_prefix);
                            current.contributors.remove(&op.repo_prefix);
                            current.pending_invites.remove(&op.repo_prefix);
                        }
                    }
                    current.removed.insert(op.repo_prefix.clone(), op);
                }
            }
        }
    }

    for (_, entry) in incoming.repos {
        if validate_entry(&entry).is_err() {
            continue;
        }
        if tombstone_blocks(&current, &entry.repo_prefix, entry.seq) {
            continue;
        }
        match current.repos.get(&entry.repo_prefix) {
            None => {
                current.removed.remove(&entry.repo_prefix);
                current.repos.insert(entry.repo_prefix.clone(), entry);
            }
            Some(existing) => {
                if existing.identity_fingerprint != entry.identity_fingerprint {
                    continue;
                }
                if entry.seq > existing.seq {
                    current.removed.remove(&entry.repo_prefix);
                    current.repos.insert(entry.repo_prefix.clone(), entry);
                }
            }
        }
    }

    for (prefix, incoming_map) in incoming.contributors {
        for (_, op) in incoming_map {
            if validate_contributor_add(&current, &op).is_err() {
                continue;
            }
            let fp = op.identity_fingerprint.clone();
            let mut inserted = false;
            {
                let by_prefix = current.contributors.entry(prefix.clone()).or_default();
                match by_prefix.get(&fp) {
                    None => {
                        by_prefix.insert(fp.clone(), op);
                        inserted = true;
                    }
                    Some(existing) => {
                        if op.seq > existing.seq {
                            by_prefix.insert(fp.clone(), op);
                            inserted = true;
                        } else {
                            // Idempotent — still clear pending below
                            inserted = true;
                        }
                    }
                }
            }
            if inserted {
                clear_pending_invite(&mut current, &prefix, &fp);
            }
        }
    }

    for (prefix, incoming_map) in incoming.pending_invites {
        for (_, op) in incoming_map {
            if validate_pending_invite_add(&current, &op).is_err() {
                continue;
            }
            let by_prefix = current.pending_invites.entry(prefix.clone()).or_default();
            match by_prefix.get(&op.identity_fingerprint) {
                None => {
                    by_prefix.insert(op.identity_fingerprint.clone(), op);
                }
                Some(existing) => {
                    if op.seq > existing.seq {
                        by_prefix.insert(op.identity_fingerprint.clone(), op);
                    }
                }
            }
        }
    }
    Ok(current)
}

fn apply_envelope(
    current: &mut HubRegistryState,
    bytes: &[u8],
) -> Result<(), ContractError> {
    if let Ok(wrap) = serde_json::from_slice::<UpdateEnvelope>(bytes) {
        match wrap {
            UpdateEnvelope::Upsert { upsert } => merge_entry(current, upsert)?,
            UpdateEnvelope::Remove { remove } => apply_remove(current, remove)?,
            UpdateEnvelope::AddContributor { add_contributor } => {
                apply_contributor_add(current, add_contributor)?
            }
            UpdateEnvelope::RemoveContributor {
                remove_contributor,
            } => apply_contributor_remove(current, remove_contributor)?,
            UpdateEnvelope::AddPendingInvite {
                add_pending_invite,
            } => apply_pending_invite_add(current, add_pending_invite)?,
            UpdateEnvelope::RemovePendingInvite {
                remove_pending_invite,
            } => apply_pending_invite_remove(current, remove_pending_invite)?,
        }
        return Ok(());
    }
    let incoming = parse_state(bytes)?;
    *current = merge_states(std::mem::take(current), incoming)?;
    Ok(())
}

pub struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let parsed = parse_state(state.as_ref())?;
        for entry in parsed.repos.values() {
            validate_entry(entry).map_err(ContractError::Other)?;
        }
        for op in parsed.removed.values() {
            validate_remove(op).map_err(ContractError::Other)?;
        }
        for by_prefix in parsed.contributors.values() {
            for op in by_prefix.values() {
                // Full listing may be mid-merge; re-check when present.
                if parsed.repos.contains_key(&op.repo_prefix) {
                    validate_contributor_add(&parsed, op).map_err(ContractError::Other)?;
                }
            }
        }
        for by_prefix in parsed.pending_invites.values() {
            for op in by_prefix.values() {
                if parsed.repos.contains_key(&op.repo_prefix) {
                    validate_pending_invite_add(&parsed, op).map_err(ContractError::Other)?;
                }
            }
        }
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let mut current = parse_state(state.as_ref())?;
        current.schema_version = 1;

        for ud in data {
            match ud {
                UpdateData::State(s) => {
                    if s.is_empty() {
                        continue;
                    }
                    apply_envelope(&mut current, s.as_ref())?;
                }
                UpdateData::Delta(s) => {
                    if s.is_empty() {
                        continue;
                    }
                    apply_envelope(&mut current, s.as_ref())?;
                }
                UpdateData::StateAndDelta { state: st, delta } => {
                    if !st.is_empty() {
                        apply_envelope(&mut current, st.as_ref())?;
                    }
                    if !delta.is_empty() {
                        apply_envelope(&mut current, delta.as_ref())?;
                    }
                }
                _ => {}
            }
        }

        let bytes = serde_json::to_vec(&current)
            .map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let parsed = parse_state(state.as_ref())?;
        let summary = serde_json::json!({
            "schema_version": parsed.schema_version,
            "count": parsed.repos.len(),
            "removed_count": parsed.removed.len(),
        });
        let bytes =
            serde_json::to_vec(&summary).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(StateSummary::from(bytes))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        Ok(StateDelta::from(state.as_ref().to_vec()))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum UpdateEnvelope {
    Upsert { upsert: HubRegistryEntry },
    Remove { remove: HubRegistryRemove },
    AddContributor {
        add_contributor: HubRegistryContributor,
    },
    RemoveContributor {
        remove_contributor: HubRegistryContributor,
    },
    AddPendingInvite {
        add_pending_invite: HubRegistryPendingInvite,
    },
    RemovePendingInvite {
        remove_pending_invite: HubRegistryPendingInvite,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sign_hex(sk: &SigningKey, payload: &[u8]) -> String {
        hex::encode(sk.sign(payload).to_bytes())
    }

    #[test]
    fn dual_sig_round_trip() {
        let id = SigningKey::from_bytes(&[1u8; 32]);
        let repo = SigningKey::from_bytes(&[2u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let repo_vk = repo.verifying_key().to_bytes();
        let prefix = pubkey_prefix(&repo_vk, 12);
        let mut entry = HubRegistryEntry {
            schema_version: 1,
            repo_prefix: prefix,
            label: "demo".into(),
            name: Some("Demo".into()),
            description: None,
            website: None,
            topics: vec![],
            public_meta: BTreeMap::new(),
            identity_fingerprint: format!("freenet:id:{}", bs58::encode(&id_vk).into_string()),
            identity_name: "Alice".into(),
            identity_email: Some("a@example.com".into()),
            repo_owner_vk: bs58::encode(&repo_vk).into_string(),
            attestation: "dual-sig-v1".into(),
            identity_sig: None,
            repo_owner_sig: None,
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let payload = signing_payload(&entry);
        entry.identity_sig = Some(sign_hex(&id, &payload));
        entry.repo_owner_sig = Some(sign_hex(&repo, &payload));
        validate_entry(&entry).expect("valid");
    }

    #[test]
    fn topics_canonical_sorts_and_lowercases() {
        assert_eq!(topics_canonical(&[]), "");
        assert_eq!(
            topics_canonical(&["Radio".into(), "social".into(), "radio".into()]),
            "radio,social"
        );
    }

    #[test]
    fn website_and_topics_in_signing_payload() {
        let id = SigningKey::from_bytes(&[1u8; 32]);
        let repo = SigningKey::from_bytes(&[2u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let repo_vk = repo.verifying_key().to_bytes();
        let prefix = pubkey_prefix(&repo_vk, 12);
        let mut entry = HubRegistryEntry {
            schema_version: 1,
            repo_prefix: prefix,
            label: "demo".into(),
            name: Some("Demo".into()),
            description: Some("blurb".into()),
            website: Some("https://example.com".into()),
            topics: vec!["Social".into(), "radio".into()],
            public_meta: BTreeMap::new(),
            identity_fingerprint: format!("freenet:id:{}", bs58::encode(&id_vk).into_string()),
            identity_name: "Alice".into(),
            identity_email: None,
            repo_owner_vk: bs58::encode(&repo_vk).into_string(),
            attestation: "dual-sig-v1".into(),
            identity_sig: None,
            repo_owner_sig: None,
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let payload = signing_payload(&entry);
        assert!(payload.windows(b"https://example.com".len()).any(|w| w == b"https://example.com"));
        assert!(payload.windows(b"radio,social".len()).any(|w| w == b"radio,social"));
        entry.identity_sig = Some(sign_hex(&id, &payload));
        entry.repo_owner_sig = Some(sign_hex(&repo, &payload));
        validate_entry(&entry).expect("valid with website/topics");
    }

    #[test]
    fn remove_tombstone_blocks_stale_upsert() {
        let id = SigningKey::from_bytes(&[1u8; 32]);
        let repo = SigningKey::from_bytes(&[2u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let repo_vk = repo.verifying_key().to_bytes();
        let prefix = pubkey_prefix(&repo_vk, 12);
        let fp = format!("freenet:id:{}", bs58::encode(&id_vk).into_string());
        let repo_owner_vk = bs58::encode(&repo_vk).into_string();

        let mut entry = HubRegistryEntry {
            schema_version: 1,
            repo_prefix: prefix.clone(),
            label: "demo".into(),
            name: Some("Demo".into()),
            description: None,
            website: None,
            topics: vec![],
            public_meta: BTreeMap::new(),
            identity_fingerprint: fp.clone(),
            identity_name: "Alice".into(),
            identity_email: None,
            repo_owner_vk: repo_owner_vk.clone(),
            attestation: "dual-sig-v1".into(),
            identity_sig: None,
            repo_owner_sig: None,
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let payload = signing_payload(&entry);
        entry.identity_sig = Some(sign_hex(&id, &payload));
        entry.repo_owner_sig = Some(sign_hex(&repo, &payload));

        let mut state = HubRegistryState::empty();
        merge_entry(&mut state, entry.clone()).unwrap();

        let mut op = HubRegistryRemove {
            schema_version: 1,
            repo_prefix: prefix.clone(),
            identity_fingerprint: fp,
            repo_owner_vk,
            attestation: "dual-sig-v1".into(),
            identity_sig: None,
            repo_owner_sig: None,
            seq: 2,
            updated_at: "2026-01-02T00:00:00Z".into(),
        };
        let upayload = unregister_signing_payload(&op);
        op.identity_sig = Some(sign_hex(&id, &upayload));
        op.repo_owner_sig = Some(sign_hex(&repo, &upayload));
        apply_remove(&mut state, op).unwrap();
        assert!(state.repos.is_empty());
        assert!(state.removed.contains_key(&prefix));

        entry.seq = 2;
        let payload2 = signing_payload(&entry);
        entry.identity_sig = Some(sign_hex(&id, &payload2));
        entry.repo_owner_sig = Some(sign_hex(&repo, &payload2));
        assert!(merge_entry(&mut state, entry).is_err());
    }
}
