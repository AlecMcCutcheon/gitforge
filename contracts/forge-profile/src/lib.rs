//! GitForge profile Freenet contract — public bio/avatar/url + encrypted inbox.
//!
//! Addressed by identity fingerprint (not vault seed). Owner-signed upserts for
//! bio + inbox prune / inbox_pk. Inbox appends require the sender’s GitForge
//! identity ed25519 signature (not anonymous).

#![allow(unexpected_cfgs)]

use ed25519_compact::{PublicKey, Signature};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const SIGN_DOMAIN: &[u8] = b"gitforge.profile.v2\0";
// const SCHEMA_VERSION: u32 = 2;
// NEW CODE - TESTING: profile v3 + public_meta bag
const SIGN_DOMAIN: &[u8] = b"gitforge.profile.v3\0";
const INBOX_APPEND_DOMAIN: &[u8] = b"gitforge.profile.inbox-append.v1\0";
const PARAMS_PREFIX: &str = "gitforge-profile-v1:";
const SCHEMA_VERSION: u32 = 3;
const MAX_BIO: usize = 512;
const MAX_URL: usize = 512;
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const MAX_AVATAR: usize = 48_000;
// const MAX_AVATAR: usize = 1_048_576; // ~768 KiB file — still too small for some GIFs
// NEW CODE - TESTING: 16 MiB data-URL chars (~12 MiB raw file)
const MAX_AVATAR: usize = 16_777_216;
const MAX_EMAIL: usize = 256;
const MAX_USERNAME: usize = 128;
const MAX_INBOX_PK_HEX: usize = 64;
const MAX_INBOX_MESSAGES: usize = 64;
const MAX_INBOX_BLOB_B64: usize = 16_384;
const MAX_INBOX_ID: usize = 64;
const MAX_PUBLIC_META_KEYS: usize = 32;
const MAX_PUBLIC_META_KEY: usize = 64;
const MAX_PUBLIC_META_VALUE: usize = 4096;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct InboxMessage {
    pub id: String,
    pub ciphertext_b64: String,
    pub created_at: String,
    /// Base58 ed25519 verifying key of the GitForge identity that signed this append.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_vk: Option<String>,
    /// Hex ed25519 over `inbox_append_signing_payload` (required on append).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_sig: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ForgeProfileState {
    pub schema_version: u32,
    pub identity_fingerprint: String,
    pub username: String,
    #[serde(default)]
    pub public_email: String,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub avatar: String,
    /// X25519 seal public key (32-byte hex). Empty until provisioned.
    #[serde(default)]
    pub inbox_pk: String,
    #[serde(default)]
    pub inbox_messages: Vec<InboxMessage>,
    /// Adaptive public bag (status, pinned, …). SPA conventions only.
    #[serde(default)]
    pub public_meta: BTreeMap<String, String>,
    pub seq: u64,
    pub updated_at: String,
    pub owner_sig: String,
}

#[derive(Serialize, Deserialize)]
struct UpsertEnvelope {
    upsert: ForgeProfileState,
}

/// Anyone with a GitForge identity may append a sealed message if they
/// dual-prove with `sender_vk` + `sender_sig` (identity ed25519).
#[derive(Serialize, Deserialize)]
struct AppendInboxEnvelope {
    append_inbox: InboxMessage,
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

/// Compact JSON of public_meta (BTreeMap key order) for signing.
pub fn public_meta_canonical(meta: &BTreeMap<String, String>) -> Result<String, String> {
    serde_json::to_string(meta).map_err(|e| format!("public_meta json: {e}"))
}

pub fn signing_payload(state: &ForgeProfileState) -> Result<Vec<u8>, String> {
    // Inbox message bodies are never part of the owner signature so signed
    // appends do not invalidate owner_sig. Prune/bio updates bump `seq` and resign.
    let inbox_messages_json = "[]";
    let meta_json = public_meta_canonical(&state.public_meta)?;
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(SIGN_DOMAIN);
    push_field(&mut out, state.identity_fingerprint.as_bytes());
    push_field(&mut out, state.username.as_bytes());
    push_field(&mut out, state.public_email.as_bytes());
    push_field(&mut out, state.bio.as_bytes());
    push_field(&mut out, state.url.as_bytes());
    push_field(&mut out, state.avatar.as_bytes());
    push_field(&mut out, state.inbox_pk.as_bytes());
    push_field(&mut out, inbox_messages_json.as_bytes());
    push_field(&mut out, meta_json.as_bytes());
    out.extend_from_slice(&state.seq.to_le_bytes());
    push_field(&mut out, state.updated_at.as_bytes());
    Ok(out)
}

/// Canonical bytes the sender identity must sign to append.
pub fn inbox_append_signing_payload(
    recipient_fingerprint: &str,
    msg: &InboxMessage,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(INBOX_APPEND_DOMAIN);
    push_field(&mut out, recipient_fingerprint.as_bytes());
    push_field(&mut out, msg.id.as_bytes());
    push_field(&mut out, msg.ciphertext_b64.as_bytes());
    push_field(&mut out, msg.created_at.as_bytes());
    push_field(
        &mut out,
        msg.sender_vk.as_deref().unwrap_or("").as_bytes(),
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

fn fingerprint_from_params(parameters: &Parameters<'_>) -> Result<String, ContractError> {
    let s = std::str::from_utf8(parameters.as_ref())
        .map_err(|e| ContractError::Deser(format!("params utf8: {e}")))?;
    let fp = s.strip_prefix(PARAMS_PREFIX).ok_or_else(|| {
        ContractError::Other(format!("params must start with {PARAMS_PREFIX}"))
    })?;
    if !fp.starts_with("freenet:id:") || fp.len() < 20 {
        return Err(ContractError::Other(
            "params fingerprint must be freenet:id:…".into(),
        ));
    }
    Ok(fp.to_string())
}

fn validate_inbox_message(msg: &InboxMessage) -> Result<(), String> {
    if msg.id.is_empty() || msg.id.len() > MAX_INBOX_ID {
        return Err("inbox message id invalid".into());
    }
    if msg.ciphertext_b64.is_empty() || msg.ciphertext_b64.len() > MAX_INBOX_BLOB_B64 {
        return Err("inbox ciphertext size invalid".into());
    }
    if msg.created_at.is_empty() || msg.created_at.len() > 64 {
        return Err("inbox created_at invalid".into());
    }
    if let Some(ref vk) = msg.sender_vk {
        if vk.len() > 128 {
            return Err("sender_vk too long".into());
        }
    }
    Ok(())
}

/// Append path: require GitForge identity proof (sender_vk + sender_sig).
fn validate_inbox_append(
    recipient_fingerprint: &str,
    msg: &InboxMessage,
) -> Result<(), String> {
    validate_inbox_message(msg)?;
    let sender_vk_b58 = msg
        .sender_vk
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("sender_vk required for inbox append")?;
    let sender_sig = msg
        .sender_sig
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("sender_sig required for inbox append")?;
    let sender_vk = decode_vk_b58(sender_vk_b58)?;
    let payload = inbox_append_signing_payload(recipient_fingerprint, msg);
    verify_ed25519(&sender_vk, sender_sig, &payload)?;
    Ok(())
}

fn validate_profile_state(state: &ForgeProfileState, expected_fp: &str) -> Result<(), String> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schema_version {}", state.schema_version));
    }
    if state.identity_fingerprint != expected_fp {
        return Err("identity_fingerprint does not match contract params".into());
    }
    if state.username.is_empty() || state.username.len() > MAX_USERNAME {
        return Err("username length invalid".into());
    }
    if state.public_email.len() > MAX_EMAIL {
        return Err("public_email too long".into());
    }
    if state.bio.len() > MAX_BIO {
        return Err("bio too long".into());
    }
    if state.url.len() > MAX_URL {
        return Err("url too long".into());
    }
    if state.avatar.len() > MAX_AVATAR {
        return Err("avatar too long".into());
    }
    if state.inbox_pk.len() > MAX_INBOX_PK_HEX {
        return Err("inbox_pk too long".into());
    }
    if !state.inbox_pk.is_empty() {
        if state.inbox_pk.len() != 64 || !state.inbox_pk.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("inbox_pk must be 64 hex chars".into());
        }
    }
    if state.inbox_messages.len() > MAX_INBOX_MESSAGES {
        return Err("inbox_messages exceeds max".into());
    }
    for msg in &state.inbox_messages {
        validate_inbox_message(msg)?;
    }
    validate_public_meta(&state.public_meta)?;
    let id_vk = identity_vk_from_fingerprint(&state.identity_fingerprint)?;
    let payload = signing_payload(state)?;
    verify_ed25519(&id_vk, &state.owner_sig, &payload)?;
    Ok(())
}

fn validate_public_meta(meta: &BTreeMap<String, String>) -> Result<(), String> {
    if meta.len() > MAX_PUBLIC_META_KEYS {
        return Err("public_meta has too many keys".into());
    }
    for (k, v) in meta {
        if k.is_empty() || k.len() > MAX_PUBLIC_META_KEY {
            return Err("public_meta key length invalid".into());
        }
        if v.len() > MAX_PUBLIC_META_VALUE {
            return Err("public_meta value too long".into());
        }
    }
    Ok(())
}

fn parse_state(bytes: &[u8]) -> Result<Option<ForgeProfileState>, ContractError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|e| ContractError::Deser(e.to_string()))
}

fn apply_upsert(
    current: Option<ForgeProfileState>,
    next: ForgeProfileState,
    expected_fp: &str,
) -> Result<ForgeProfileState, ContractError> {
    validate_profile_state(&next, expected_fp).map_err(ContractError::Other)?;
    match current {
        None => Ok(next),
        Some(prev) => {
            if prev.identity_fingerprint != next.identity_fingerprint {
                return Err(ContractError::Other(
                    "different identity cannot overwrite profile".into(),
                ));
            }
            if next.seq <= prev.seq {
                return Err(ContractError::Other(format!(
                    "seq must increase (have {}, got {})",
                    prev.seq, next.seq
                )));
            }
            Ok(next)
        }
    }
}

fn apply_append_inbox(
    current: Option<ForgeProfileState>,
    msg: InboxMessage,
    recipient_fingerprint: &str,
) -> Result<ForgeProfileState, ContractError> {
    let mut state = current.ok_or_else(|| {
        ContractError::Other("cannot append inbox to empty profile".into())
    })?;
    validate_inbox_append(recipient_fingerprint, &msg).map_err(ContractError::Other)?;
    if state.inbox_pk.is_empty() {
        return Err(ContractError::Other(
            "profile has no inbox_pk — cannot append".into(),
        ));
    }
    if state.inbox_messages.iter().any(|m| m.id == msg.id) {
        return Err(ContractError::Other("duplicate inbox message id".into()));
    }
    if state.inbox_messages.len() >= MAX_INBOX_MESSAGES {
        return Err(ContractError::Other("inbox full — owner must prune".into()));
    }
    state.inbox_messages.push(msg);
    // Append does not bump seq / re-sign — owner_sig covers bio+pk only.
    Ok(state)
}

fn apply_update_bytes(
    current: Option<ForgeProfileState>,
    bytes: &[u8],
    expected_fp: &str,
) -> Result<Option<ForgeProfileState>, ContractError> {
    if bytes.is_empty() {
        return Ok(current);
    }
    if let Ok(env) = serde_json::from_slice::<AppendInboxEnvelope>(bytes) {
        return Ok(Some(apply_append_inbox(
            current,
            env.append_inbox,
            expected_fp,
        )?));
    }
    if let Ok(env) = serde_json::from_slice::<UpsertEnvelope>(bytes) {
        return Ok(Some(apply_upsert(current, env.upsert, expected_fp)?));
    }
    let next: ForgeProfileState =
        serde_json::from_slice(bytes).map_err(|e| ContractError::Deser(e.to_string()))?;
    Ok(Some(apply_upsert(current, next, expected_fp)?))
}

pub struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let expected = fingerprint_from_params(&parameters)?;
        match parse_state(state.as_ref())? {
            None => Ok(ValidateResult::Valid),
            Some(s) => {
                // Owner-signed state must verify. After anonymous appends the
                // stored owner_sig still covers the pre-append signed fields
                // only if we re-sign on every append — we don't. So validate
                // structure + owner identity fields, then verify sig against
                // a copy with inbox_messages cleared to the signed set…
                // Simpler: require owner_sig verify on full state for upserts;
                // for states that only grew via append, skip full sig check and
                // verify inbox_pk + bio via a "core" payload.
                //
                // Practical approach: validate_profile_state requires matching
                // owner_sig over current full state. Append path must therefore
                // be followed by client prune/re-sign OR we soften validation:
                // verify owner_sig over core fields only (excluding messages).
                validate_profile_core(&s, &expected).map_err(ContractError::Other)?;
                Ok(ValidateResult::Valid)
            }
        }
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let expected = fingerprint_from_params(&parameters)?;
        let mut current = parse_state(state.as_ref())?;

        for ud in data {
            match ud {
                UpdateData::State(s) => {
                    current = apply_update_bytes(current, s.as_ref(), &expected)?;
                }
                UpdateData::Delta(s) => {
                    current = apply_update_bytes(current, s.as_ref(), &expected)?;
                }
                UpdateData::StateAndDelta { state: st, delta } => {
                    current = apply_update_bytes(current, st.as_ref(), &expected)?;
                    current = apply_update_bytes(current, delta.as_ref(), &expected)?;
                }
                _ => {}
            }
        }

        let out = match current {
            None => Vec::new(),
            Some(s) => {
                validate_profile_core(&s, &expected).map_err(ContractError::Other)?;
                serde_json::to_vec(&s).map_err(|e| ContractError::Deser(e.to_string()))?
            }
        };
        Ok(UpdateModification::valid(State::from(out)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let summary = match parse_state(state.as_ref())? {
            None => serde_json::json!({ "empty": true }),
            Some(s) => serde_json::json!({
                "schema_version": s.schema_version,
                "identity_fingerprint": s.identity_fingerprint,
                "username": s.username,
                "seq": s.seq,
                "inbox_len": s.inbox_messages.len(),
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

/// Owner sig covers bio + inbox_pk + the message list that was signed.
/// After anonymous appends, `inbox_messages` may be longer than when signed.
/// Verify sig against state with messages truncated? Too heuristic.
///
/// Instead: owner_sig is verified over signing_payload of a "canonical" view
/// that includes only messages whose ids were present when last owner-signed.
/// We don't track that. So: verify owner_sig over payload with **empty**
/// inbox_messages (bio + pk only). Appends don't affect owner_sig validity.
/// Owner prune/re-sign includes full message list in the new signature.
fn validate_profile_core(state: &ForgeProfileState, expected_fp: &str) -> Result<(), String> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schema_version {}", state.schema_version));
    }
    if state.identity_fingerprint != expected_fp {
        return Err("identity_fingerprint does not match contract params".into());
    }
    if state.username.is_empty() || state.username.len() > MAX_USERNAME {
        return Err("username length invalid".into());
    }
    if state.public_email.len() > MAX_EMAIL {
        return Err("public_email too long".into());
    }
    if state.bio.len() > MAX_BIO {
        return Err("bio too long".into());
    }
    if state.url.len() > MAX_URL {
        return Err("url too long".into());
    }
    if state.avatar.len() > MAX_AVATAR {
        return Err("avatar too long".into());
    }
    if state.inbox_pk.len() > MAX_INBOX_PK_HEX {
        return Err("inbox_pk too long".into());
    }
    if !state.inbox_pk.is_empty()
        && (state.inbox_pk.len() != 64 || !state.inbox_pk.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("inbox_pk must be 64 hex chars".into());
    }
    if state.inbox_messages.len() > MAX_INBOX_MESSAGES {
        return Err("inbox_messages exceeds max".into());
    }
    for msg in &state.inbox_messages {
        validate_inbox_message(msg)?;
    }
    validate_public_meta(&state.public_meta)?;
    let id_vk = identity_vk_from_fingerprint(&state.identity_fingerprint)?;
    let payload = signing_payload(state)?;
    verify_ed25519(&id_vk, &state.owner_sig, &payload)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn owner_sig_round_trip() {
        let id = SigningKey::from_bytes(&[5u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let fp = format!("freenet:id:{}", bs58::encode(&id_vk).into_string());
        let mut state = ForgeProfileState {
            schema_version: 3,
            identity_fingerprint: fp.clone(),
            username: "alice".into(),
            public_email: "a@example.com".into(),
            bio: "hello".into(),
            url: "https://example.com".into(),
            avatar: "".into(),
            inbox_pk: "aa".repeat(32),
            inbox_messages: vec![],
            public_meta: BTreeMap::new(),
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
            owner_sig: String::new(),
        };
        let payload = signing_payload(&state).unwrap();
        state.owner_sig = hex::encode(id.sign(&payload).to_bytes());
        validate_profile_core(&state, &fp).unwrap();
    }
}
