//! HubRepoMeta — per-repo settings + public/private message channels.
//!
//! Addressed by `gitatlas-repo-v1:{repo_prefix}`. Keeps appendable traffic
//! off the global HubRegistry Discover singleton.

#![allow(unexpected_cfgs)]

use ed25519_compact::{PublicKey, Signature};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const UPSERT_DOMAIN: &[u8] = b"gitatlas.repo-meta.upsert.v1\0";
const APPEND_PUBLIC_DOMAIN: &[u8] = b"gitatlas.repo-meta.append-public.v1\0";
const APPEND_PRIVATE_DOMAIN: &[u8] = b"gitatlas.repo-meta.append-private.v1\0";
const PARAMS_PREFIX: &str = "gitatlas-repo-v1:";
const SCHEMA_VERSION: u32 = 1;
const MIN_PREFIX_LEN: usize = 8;
const MAX_PREFIX_LEN: usize = 24;
const MAX_CHANNEL_MESSAGES: usize = 128;
const MAX_BLOB_B64: usize = 16_384;
const MAX_ID: usize = 64;
const MAX_META_KEYS: usize = 64;
const MAX_META_KEY: usize = 64;
const MAX_META_VALUE: usize = 4096;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SealedBlob {
    pub alg: String,
    pub nonce_b64: String,
    pub blob_b64: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChannelMessage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ciphertext_b64: Option<String>,
    pub created_at: String,
    pub sender_vk: String,
    pub sender_sig: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct ChannelBags {
    #[serde(default)]
    pub public: Vec<ChannelMessage>,
    #[serde(default)]
    pub private: Vec<ChannelMessage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubRepoMetaState {
    pub schema_version: u32,
    pub repo_prefix: String,
    pub repo_owner_vk: String,
    #[serde(default)]
    pub seal_pk: String,
    #[serde(default)]
    pub public_settings: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_settings: Option<SealedBlob>,
    #[serde(default)]
    pub channels: ChannelBags,
    pub identity_fingerprint: String,
    pub attestation: String,
    pub identity_sig: String,
    pub repo_owner_sig: String,
    pub seq: u64,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct UpsertEnvelope {
    upsert: HubRepoMetaState,
}

#[derive(Serialize, Deserialize)]
struct AppendPublicEnvelope {
    append_public: ChannelMessage,
}

#[derive(Serialize, Deserialize)]
struct AppendPrivateEnvelope {
    append_private: ChannelMessage,
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

pub fn upsert_signing_payload(state: &HubRepoMetaState) -> Result<Vec<u8>, String> {
    let settings_json =
        serde_json::to_string(&state.public_settings).map_err(|e| format!("settings json: {e}"))?;
    let sealed_field = match &state.sealed_settings {
        Some(s) => serde_json::to_string(s).map_err(|e| format!("sealed json: {e}"))?,
        None => String::new(),
    };
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(UPSERT_DOMAIN);
    push_field(&mut out, state.repo_prefix.as_bytes());
    push_field(&mut out, state.repo_owner_vk.as_bytes());
    push_field(&mut out, state.seal_pk.as_bytes());
    push_field(&mut out, settings_json.as_bytes());
    push_field(&mut out, sealed_field.as_bytes());
    push_field(&mut out, state.identity_fingerprint.as_bytes());
    out.extend_from_slice(&state.seq.to_le_bytes());
    push_field(&mut out, state.updated_at.as_bytes());
    Ok(out)
}

pub fn append_public_signing_payload(prefix: &str, msg: &ChannelMessage) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(APPEND_PUBLIC_DOMAIN);
    push_field(&mut out, prefix.as_bytes());
    push_field(&mut out, msg.id.as_bytes());
    push_field(
        &mut out,
        msg.body_b64.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(&mut out, msg.created_at.as_bytes());
    push_field(&mut out, msg.sender_vk.as_bytes());
    push_field(
        &mut out,
        msg.thread_id.as_deref().unwrap_or("").as_bytes(),
    );
    out
}

pub fn append_private_signing_payload(prefix: &str, msg: &ChannelMessage) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(APPEND_PRIVATE_DOMAIN);
    push_field(&mut out, prefix.as_bytes());
    push_field(&mut out, msg.id.as_bytes());
    push_field(
        &mut out,
        msg.ciphertext_b64.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(&mut out, msg.created_at.as_bytes());
    push_field(&mut out, msg.sender_vk.as_bytes());
    push_field(
        &mut out,
        msg.thread_id.as_deref().unwrap_or("").as_bytes(),
    );
    out
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

fn prefix_from_params(parameters: &Parameters<'_>) -> Result<String, ContractError> {
    let s = std::str::from_utf8(parameters.as_ref())
        .map_err(|e| ContractError::Deser(format!("params utf8: {e}")))?;
    let prefix = s.strip_prefix(PARAMS_PREFIX).ok_or_else(|| {
        ContractError::Other(format!("params must start with {PARAMS_PREFIX}"))
    })?;
    let plen = prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(ContractError::Other(format!(
            "repo_prefix length {plen} out of range"
        )));
    }
    Ok(prefix.to_string())
}

fn validate_meta_map(map: &BTreeMap<String, String>) -> Result<(), String> {
    if map.len() > MAX_META_KEYS {
        return Err("settings map too large".into());
    }
    for (k, v) in map {
        if k.is_empty() || k.len() > MAX_META_KEY {
            return Err("settings key length invalid".into());
        }
        if v.len() > MAX_META_VALUE {
            return Err("settings value too long".into());
        }
    }
    Ok(())
}

fn validate_message_common(msg: &ChannelMessage) -> Result<(), String> {
    if msg.id.is_empty() || msg.id.len() > MAX_ID {
        return Err("message id invalid".into());
    }
    if msg.created_at.is_empty() || msg.created_at.len() > 64 {
        return Err("created_at invalid".into());
    }
    if msg.sender_vk.is_empty() || msg.sender_vk.len() > 128 {
        return Err("sender_vk invalid".into());
    }
    if msg.sender_sig.is_empty() {
        return Err("sender_sig required".into());
    }
    if let Some(ref t) = msg.thread_id {
        if t.len() > MAX_ID {
            return Err("thread_id too long".into());
        }
    }
    Ok(())
}

fn validate_upsert(state: &HubRepoMetaState, expected_prefix: &str) -> Result<(), String> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schema_version {}", state.schema_version));
    }
    if state.repo_prefix != expected_prefix {
        return Err("repo_prefix does not match params".into());
    }
    if state.attestation != "dual-sig-v1" {
        return Err(format!("unsupported attestation {}", state.attestation));
    }
    if state.repo_owner_vk.is_empty() {
        return Err("repo_owner_vk required".into());
    }
    if !state.seal_pk.is_empty()
        && (state.seal_pk.len() != 64 || !state.seal_pk.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("seal_pk must be 64 hex chars or empty".into());
    }
    validate_meta_map(&state.public_settings)?;
    if state.channels.public.len() > MAX_CHANNEL_MESSAGES
        || state.channels.private.len() > MAX_CHANNEL_MESSAGES
    {
        return Err("channel exceeds max messages".into());
    }
    for msg in state.channels.public.iter().chain(state.channels.private.iter()) {
        validate_message_common(msg)?;
    }
    let id_vk = identity_vk_from_fingerprint(&state.identity_fingerprint)?;
    let repo_vk = decode_vk_b58(&state.repo_owner_vk)?;
    let payload = upsert_signing_payload(state)?;
    verify_ed25519(&id_vk, &state.identity_sig, &payload)?;
    verify_ed25519(&repo_vk, &state.repo_owner_sig, &payload)?;
    Ok(())
}

fn validate_append_public(
    state: &HubRepoMetaState,
    msg: &ChannelMessage,
) -> Result<(), String> {
    if state.repo_owner_vk.is_empty() {
        return Err("cannot append: repo meta not initialized".into());
    }
    validate_message_common(msg)?;
    let body = msg
        .body_b64
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("body_b64 required for public append")?;
    if body.len() > MAX_BLOB_B64 {
        return Err("body_b64 too large".into());
    }
    let sender_vk = decode_vk_b58(&msg.sender_vk)?;
    let payload = append_public_signing_payload(&state.repo_prefix, msg);
    verify_ed25519(&sender_vk, &msg.sender_sig, &payload)?;
    Ok(())
}

fn validate_append_private(
    state: &HubRepoMetaState,
    msg: &ChannelMessage,
) -> Result<(), String> {
    if state.seal_pk.is_empty() {
        return Err("cannot append private: seal_pk not provisioned".into());
    }
    validate_message_common(msg)?;
    let ct = msg
        .ciphertext_b64
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("ciphertext_b64 required for private append")?;
    if ct.len() > MAX_BLOB_B64 {
        return Err("ciphertext_b64 too large".into());
    }
    let sender_vk = decode_vk_b58(&msg.sender_vk)?;
    let payload = append_private_signing_payload(&state.repo_prefix, msg);
    verify_ed25519(&sender_vk, &msg.sender_sig, &payload)?;
    Ok(())
}

fn parse_state(bytes: &[u8]) -> Result<Option<HubRepoMetaState>, ContractError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|e| ContractError::Deser(e.to_string()))
}

fn apply_upsert(
    current: Option<HubRepoMetaState>,
    next: HubRepoMetaState,
    expected_prefix: &str,
) -> Result<HubRepoMetaState, ContractError> {
    validate_upsert(&next, expected_prefix).map_err(ContractError::Other)?;
    if let Some(prev) = current {
        if next.seq <= prev.seq {
            return Err(ContractError::Other(format!(
                "seq must increase (have {}, got {})",
                prev.seq, next.seq
            )));
        }
        if prev.identity_fingerprint != next.identity_fingerprint {
            return Err(ContractError::Other(
                "different identity cannot overwrite repo meta".into(),
            ));
        }
    }
    Ok(next)
}

fn apply_append_public(
    mut state: HubRepoMetaState,
    msg: ChannelMessage,
) -> Result<HubRepoMetaState, ContractError> {
    validate_append_public(&state, &msg).map_err(ContractError::Other)?;
    if state.channels.public.iter().any(|m| m.id == msg.id) {
        return Err(ContractError::Other("duplicate message id".into()));
    }
    if state.channels.public.len() >= MAX_CHANNEL_MESSAGES {
        return Err(ContractError::Other("public channel full".into()));
    }
    state.channels.public.push(msg);
    Ok(state)
}

fn apply_append_private(
    mut state: HubRepoMetaState,
    msg: ChannelMessage,
) -> Result<HubRepoMetaState, ContractError> {
    validate_append_private(&state, &msg).map_err(ContractError::Other)?;
    if state.channels.private.iter().any(|m| m.id == msg.id) {
        return Err(ContractError::Other("duplicate message id".into()));
    }
    if state.channels.private.len() >= MAX_CHANNEL_MESSAGES {
        return Err(ContractError::Other("private channel full".into()));
    }
    state.channels.private.push(msg);
    Ok(state)
}

fn apply_bytes(
    current: Option<HubRepoMetaState>,
    bytes: &[u8],
    expected_prefix: &str,
) -> Result<HubRepoMetaState, ContractError> {
    if let Ok(env) = serde_json::from_slice::<UpsertEnvelope>(bytes) {
        return apply_upsert(current, env.upsert, expected_prefix);
    }
    if let Ok(env) = serde_json::from_slice::<AppendPublicEnvelope>(bytes) {
        let state = current.ok_or_else(|| {
            ContractError::Other("cannot append to empty repo meta".into())
        })?;
        return apply_append_public(state, env.append_public);
    }
    if let Ok(env) = serde_json::from_slice::<AppendPrivateEnvelope>(bytes) {
        let state = current.ok_or_else(|| {
            ContractError::Other("cannot append to empty repo meta".into())
        })?;
        return apply_append_private(state, env.append_private);
    }
    let incoming = parse_state(bytes)?.ok_or_else(|| {
        ContractError::Other("empty update".into())
    })?;
    apply_upsert(current, incoming, expected_prefix)
}

pub struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let prefix = prefix_from_params(&parameters)?;
        let Some(parsed) = parse_state(state.as_ref())? else {
            return Ok(ValidateResult::Valid);
        };
        validate_upsert(&parsed, &prefix).map_err(ContractError::Other)?;
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let prefix = prefix_from_params(&parameters)?;
        let mut current = parse_state(state.as_ref())?;
        for ud in data {
            match ud {
                UpdateData::State(s) => {
                    if !s.is_empty() {
                        current = Some(apply_bytes(current, s.as_ref(), &prefix)?);
                    }
                }
                UpdateData::Delta(s) => {
                    if !s.is_empty() {
                        current = Some(apply_bytes(current, s.as_ref(), &prefix)?);
                    }
                }
                UpdateData::StateAndDelta { state: st, delta } => {
                    if !st.is_empty() {
                        current = Some(apply_bytes(current, st.as_ref(), &prefix)?);
                    }
                    if !delta.is_empty() {
                        current = Some(apply_bytes(current, delta.as_ref(), &prefix)?);
                    }
                }
                _ => {}
            }
        }
        let out = current.ok_or_else(|| ContractError::Other("no state after update".into()))?;
        let bytes =
            serde_json::to_vec(&out).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let parsed = parse_state(state.as_ref())?;
        let summary = match parsed {
            None => serde_json::json!({ "empty": true }),
            Some(s) => serde_json::json!({
                "schema_version": s.schema_version,
                "seq": s.seq,
                "public_len": s.channels.public.len(),
                "private_len": s.channels.private.len(),
            }),
        };
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
