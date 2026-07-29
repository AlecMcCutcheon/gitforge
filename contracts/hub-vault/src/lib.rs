//! GitAtlas vault Freenet contract — passwordless schema v4.
//!
//! Addressing is seed-derived (`vault_id`). Envelope ciphertexts (e.g. `repos`)
//! use per-envelope DEKs. `identity_dek_wrap` seals those DEKs to the identity SK
//! (signed-in sync — no vault password). API keys unwrap scoped DEKs + a per-key
//! ops signing key (not the identity seed).

#![allow(unexpected_cfgs)]

use ed25519_compact::{PublicKey, Signature};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const SIGN_DOMAIN: &[u8] = b"freenethub.vault.v3\0";
// const PARAMS_PREFIX: &str = "freenethub-vault-v1:";
// const SCHEMA_VERSION: u32 = 3;
// NEW CODE - TESTING: GitAtlas passwordless vault
const SIGN_DOMAIN: &[u8] = b"gitatlas.vault.v4\0";
const PARAMS_PREFIX: &str = "gitatlas-vault-v1:";
const SCHEMA_VERSION: u32 = 4;
const SIG_KIND_OWNER: &str = "owner";
const SIG_KIND_OPS: &str = "ops";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct VaultKdf {
    pub alg: String,
    pub salt_b64: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct VaultCipher {
    pub alg: String,
    pub nonce_b64: String,
    pub blob_b64: String,
}

/// Public metadata + wrap of `{ deks, ops_sk_hex }` under the API key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct VaultApiKeyWrap {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub salt_b64: String,
    pub hash_b64: String,
    /// Envelope ids this key may unlock / update (e.g. `repos`).
    pub scopes: Vec<String>,
    pub wrap_kdf: VaultKdf,
    pub wrap_nonce_b64: String,
    pub wrap_blob_b64: String,
    /// Base58 ed25519 verifying key for this API key's ops signer.
    pub ops_vk_b58: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedOps {
    pub id: String,
    pub ops_vk_b58: String,
    pub scopes: Vec<String>,
    pub created_at: String,
}

/// Public AEAD of `{ deks }` under a key derived from the identity SK.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IdentityDekWrap {
    pub alg: String,
    pub nonce_b64: String,
    pub blob_b64: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HubVaultState {
    pub schema_version: u32,
    /// hex(blake3("gitatlas-vault-v1" ‖ seed)); must match params.
    pub vault_id: String,
    /// Scoped ciphertext map (`repos`, …). BTreeMap → stable JSON key order.
    pub envelopes: BTreeMap<String, VaultCipher>,
    /// Sealed envelope DEKs for the signed-in identity (owner sync without password).
    pub identity_dek_wrap: IdentityDekWrap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_wraps: Option<Vec<VaultApiKeyWrap>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorized_ops: Option<Vec<AuthorizedOps>>,
    pub identity_fingerprint: String,
    pub username: String,
    pub seq: u64,
    pub updated_at: String,
    /// `owner` (identity SK) or `ops` (per-API-key automation SK).
    pub sig_kind: String,
    pub sig: String,
}

#[derive(Serialize, Deserialize)]
struct UpsertEnvelope {
    upsert: HubVaultState,
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

/// Canonical bytes signed by owner or ops key.
pub fn signing_payload(state: &HubVaultState) -> Result<Vec<u8>, String> {
    let envelopes_json =
        serde_json::to_string(&state.envelopes).map_err(|e| format!("envelopes json: {e}"))?;
    let identity_dek_wrap_json = serde_json::to_string(&state.identity_dek_wrap)
        .map_err(|e| format!("identity_dek_wrap json: {e}"))?;
    // Always include both arrays (possibly `[]`) so the payload layout is unambiguous.
    let wraps_json = serde_json::to_string(state.api_key_wraps.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("api_key_wraps json: {e}"))?;
    let ops_json = serde_json::to_string(state.authorized_ops.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("authorized_ops json: {e}"))?;
    let mut out = Vec::with_capacity(1024);
    out.extend_from_slice(SIGN_DOMAIN);
    push_field(&mut out, state.vault_id.as_bytes());
    push_field(&mut out, state.username.as_bytes());
    push_field(&mut out, state.identity_fingerprint.as_bytes());
    push_field(&mut out, envelopes_json.as_bytes());
    push_field(&mut out, identity_dek_wrap_json.as_bytes());
    push_field(&mut out, wraps_json.as_bytes());
    push_field(&mut out, ops_json.as_bytes());
    out.extend_from_slice(&state.seq.to_le_bytes());
    push_field(&mut out, state.updated_at.as_bytes());
    push_field(&mut out, state.sig_kind.as_bytes());
    Ok(out)
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

fn vault_id_from_params(parameters: &Parameters<'_>) -> Result<String, ContractError> {
    let s = std::str::from_utf8(parameters.as_ref())
        .map_err(|e| ContractError::Deser(format!("params utf8: {e}")))?;
    let hash = s.strip_prefix(PARAMS_PREFIX).ok_or_else(|| {
        ContractError::Other(format!("params must start with {PARAMS_PREFIX}"))
    })?;
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ContractError::Other(
            "vault_id in params must be 64 hex chars".into(),
        ));
    }
    Ok(hash.to_ascii_lowercase())
}

fn validate_cipher(c: &VaultCipher, label: &str) -> Result<(), String> {
    if c.alg != "xchacha20poly1305" {
        return Err(format!("unsupported {label} cipher {}", c.alg));
    }
    if c.blob_b64.is_empty() || c.nonce_b64.is_empty() {
        return Err(format!("missing {label} cipher material"));
    }
    Ok(())
}

#[allow(dead_code)]
fn validate_kdf(k: &VaultKdf, label: &str) -> Result<(), String> {
    if k.alg != "argon2id" {
        return Err(format!("unsupported {label} kdf {}", k.alg));
    }
    if k.salt_b64.is_empty() {
        return Err(format!("missing {label} kdf salt"));
    }
    Ok(())
}

fn find_authorized_ops<'a>(
    state: &'a HubVaultState,
    ops_vk_b58: &str,
) -> Result<&'a AuthorizedOps, String> {
    let list = state
        .authorized_ops
        .as_ref()
        .ok_or_else(|| "ops signature but no authorized_ops".to_string())?;
    list.iter()
        .find(|e| e.ops_vk_b58 == ops_vk_b58)
        .ok_or_else(|| "ops verifying key not authorized".to_string())
}

fn validate_vault_state(state: &HubVaultState, expected_vault_id: &str) -> Result<(), String> {
    if state.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported schema_version {}", state.schema_version));
    }
    if state.vault_id.to_ascii_lowercase() != expected_vault_id {
        return Err("vault_id does not match contract params".into());
    }
    if state.username.is_empty() || state.username.len() > 128 {
        return Err("username length invalid".into());
    }
    validate_cipher(
        &VaultCipher {
            alg: state.identity_dek_wrap.alg.clone(),
            nonce_b64: state.identity_dek_wrap.nonce_b64.clone(),
            blob_b64: state.identity_dek_wrap.blob_b64.clone(),
        },
        "identity_dek_wrap",
    )?;
    if state.envelopes.is_empty() {
        return Err("envelopes must not be empty".into());
    }
    for (name, cipher) in &state.envelopes {
        if name.is_empty() || name.len() > 64 {
            return Err("invalid envelope name".into());
        }
        validate_cipher(cipher, name)?;
    }
    let payload = signing_payload(state)?;
    match state.sig_kind.as_str() {
        SIG_KIND_OWNER => {
            let id_vk = identity_vk_from_fingerprint(&state.identity_fingerprint)?;
            verify_ed25519(&id_vk, &state.sig, &payload)?;
        }
        SIG_KIND_OPS => {
            // Ops signer must appear in authorized_ops; which envelope they may
            // change is checked on update vs previous state.
            let ops_list = state
                .authorized_ops
                .as_ref()
                .filter(|o| !o.is_empty())
                .ok_or_else(|| "ops signature requires authorized_ops".to_string())?;
            let mut ok = false;
            let mut last_err = "ops signature verification failed".to_string();
            for entry in ops_list {
                let vk = match decode_vk_b58(&entry.ops_vk_b58) {
                    Ok(v) => v,
                    Err(e) => {
                        last_err = e;
                        continue;
                    }
                };
                if verify_ed25519(&vk, &state.sig, &payload).is_ok() {
                    ok = true;
                    break;
                }
            }
            if !ok {
                return Err(last_err);
            }
        }
        other => return Err(format!("unsupported sig_kind {other}")),
    }
    Ok(())
}

fn ops_envelope_delta_allowed(prev: &HubVaultState, next: &HubVaultState) -> Result<(), String> {
    if next.identity_fingerprint != prev.identity_fingerprint {
        return Err("ops update cannot change identity_fingerprint".into());
    }
    if next.username != prev.username {
        return Err("ops update cannot change username".into());
    }
    if next.identity_dek_wrap != prev.identity_dek_wrap {
        return Err("ops update cannot change identity_dek_wrap".into());
    }
    if next.api_key_wraps != prev.api_key_wraps {
        return Err("ops update cannot change api_key_wraps".into());
    }
    if next.authorized_ops != prev.authorized_ops {
        return Err("ops update cannot change authorized_ops".into());
    }

    // Resolve which authorized entry signed `next`.
    let ops_list = next
        .authorized_ops
        .as_ref()
        .ok_or_else(|| "missing authorized_ops".to_string())?;
    let payload = signing_payload(next)?;
    let mut signer: Option<&AuthorizedOps> = None;
    for entry in ops_list {
        let vk = decode_vk_b58(&entry.ops_vk_b58)?;
        if verify_ed25519(&vk, &next.sig, &payload).is_ok() {
            signer = Some(entry);
            break;
        }
    }
    let signer = signer.ok_or_else(|| "could not identify ops signer".to_string())?;
    let _ = find_authorized_ops(next, &signer.ops_vk_b58)?;

    let prev_keys: Vec<&String> = prev.envelopes.keys().collect();
    let next_keys: Vec<&String> = next.envelopes.keys().collect();
    if prev_keys != next_keys {
        return Err("ops update cannot add/remove envelope ids".into());
    }
    for (name, next_cipher) in &next.envelopes {
        let prev_cipher = prev
            .envelopes
            .get(name)
            .ok_or_else(|| format!("missing previous envelope {name}"))?;
        if prev_cipher == next_cipher {
            continue;
        }
        if !signer.scopes.iter().any(|s| s == name) {
            return Err(format!(
                "ops key not scoped for envelope '{name}' (scopes: {:?})",
                signer.scopes
            ));
        }
    }
    Ok(())
}

fn parse_state(bytes: &[u8]) -> Result<Option<HubVaultState>, ContractError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|e| ContractError::Deser(e.to_string()))
}

fn apply_upsert(
    current: Option<HubVaultState>,
    next: HubVaultState,
    expected_vault_id: &str,
) -> Result<HubVaultState, ContractError> {
    validate_vault_state(&next, expected_vault_id).map_err(ContractError::Other)?;
    match current {
        None => {
            if next.sig_kind != SIG_KIND_OWNER {
                return Err(ContractError::Other(
                    "first vault put must be owner-signed".into(),
                ));
            }
            Ok(next)
        }
        Some(prev) => {
            if prev.identity_fingerprint != next.identity_fingerprint {
                return Err(ContractError::Other(
                    "different identity cannot overwrite vault".into(),
                ));
            }
            if next.seq <= prev.seq {
                return Err(ContractError::Other(format!(
                    "seq must increase (have {}, got {})",
                    prev.seq, next.seq
                )));
            }
            if next.sig_kind == SIG_KIND_OPS {
                ops_envelope_delta_allowed(&prev, &next).map_err(ContractError::Other)?;
            }
            Ok(next)
        }
    }
}

fn apply_update_bytes(
    current: Option<HubVaultState>,
    bytes: &[u8],
    expected_vault_id: &str,
) -> Result<Option<HubVaultState>, ContractError> {
    if bytes.is_empty() {
        return Ok(current);
    }
    if let Ok(wrap) = serde_json::from_slice::<UpsertEnvelope>(bytes) {
        return Ok(Some(apply_upsert(current, wrap.upsert, expected_vault_id)?));
    }
    if let Ok(s) = serde_json::from_slice::<HubVaultState>(bytes) {
        return Ok(Some(apply_upsert(current, s, expected_vault_id)?));
    }
    Ok(current)
}

pub struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let expected = vault_id_from_params(&parameters)?;
        match parse_state(state.as_ref())? {
            None => Ok(ValidateResult::Valid),
            Some(s) => {
                validate_vault_state(&s, &expected).map_err(ContractError::Other)?;
                Ok(ValidateResult::Valid)
            }
        }
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let expected = vault_id_from_params(&parameters)?;
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
            Some(s) => serde_json::to_vec(&s).map_err(|e| ContractError::Deser(e.to_string()))?,
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
                "vault_id": s.vault_id,
                "identity_fingerprint": s.identity_fingerprint,
                "username": s.username,
                "seq": s.seq,
                "sig_kind": s.sig_kind,
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn sample_cipher() -> VaultCipher {
        VaultCipher {
            alg: "xchacha20poly1305".into(),
            nonce_b64: "bm9uY2U=".into(),
            blob_b64: "YmxvYg==".into(),
        }
    }


    fn sample_identity_dek_wrap() -> IdentityDekWrap {
        IdentityDekWrap {
            alg: "xchacha20poly1305".into(),
            nonce_b64: "bm9uY2U=".into(),
            blob_b64: "YmxvYg==".into(),
        }
    }

    #[test]
    fn owner_sig_round_trip() {
        let id = SigningKey::from_bytes(&[3u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let mut envelopes = BTreeMap::new();
        envelopes.insert("repos".into(), sample_cipher());
        let mut state = HubVaultState {
            schema_version: SCHEMA_VERSION,
            vault_id: "ab".repeat(32),
            envelopes,
            identity_dek_wrap: sample_identity_dek_wrap(),
            api_key_wraps: None,
            authorized_ops: None,
            identity_fingerprint: format!("freenet:id:{}", bs58::encode(&id_vk).into_string()),
            username: "alice".into(),
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
            sig_kind: SIG_KIND_OWNER.into(),
            sig: String::new(),
        };
        let payload = signing_payload(&state).unwrap();
        state.sig = hex::encode(id.sign(&payload).to_bytes());
        validate_vault_state(&state, &state.vault_id).expect("valid");
    }

    #[test]
    fn ops_cannot_change_identity() {
        let id = SigningKey::from_bytes(&[3u8; 32]);
        let ops = SigningKey::from_bytes(&[7u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let ops_vk = ops.verifying_key().to_bytes();
        let ops_b58 = bs58::encode(&ops_vk).into_string();
        let mut envelopes = BTreeMap::new();
        envelopes.insert("repos".into(), sample_cipher());
        let authorized = vec![AuthorizedOps {
            id: "k1".into(),
            ops_vk_b58: ops_b58.clone(),
            scopes: vec!["repos".into()],
            created_at: "2026-01-01T00:00:00Z".into(),
        }];
        let mut prev = HubVaultState {
            schema_version: SCHEMA_VERSION,
            vault_id: "ab".repeat(32),
            envelopes: envelopes.clone(),
            identity_dek_wrap: sample_identity_dek_wrap(),
            api_key_wraps: None,
            authorized_ops: Some(authorized.clone()),
            identity_fingerprint: format!("freenet:id:{}", bs58::encode(&id_vk).into_string()),
            username: "alice".into(),
            seq: 1,
            updated_at: "2026-01-01T00:00:00Z".into(),
            sig_kind: SIG_KIND_OWNER.into(),
            sig: String::new(),
        };
        let payload = signing_payload(&prev).unwrap();
        prev.sig = hex::encode(id.sign(&payload).to_bytes());

        let mut next = prev.clone();
        next.seq = 2;
        next.sig_kind = SIG_KIND_OPS.into();
        next.username = "bob".into();
        let payload2 = signing_payload(&next).unwrap();
        next.sig = hex::encode(ops.sign(&payload2).to_bytes());
        assert!(ops_envelope_delta_allowed(&prev, &next).is_err());
    }
}
