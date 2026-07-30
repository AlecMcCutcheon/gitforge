//! ForgeStars Freenet contract — per-repo star maps signed by identity.

#![allow(unexpected_cfgs)]

use ed25519_compact::{PublicKey, Signature};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const STAR_DOMAIN: &[u8] = b"gitforge.star.v1\0";
const UNSTAR_DOMAIN: &[u8] = b"gitforge.unstar.v1\0";
const MIN_PREFIX_LEN: usize = 8;
const MAX_PREFIX_LEN: usize = 24;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StarEntry {
    pub starred_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub sig: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct ForgeStarsState {
    pub schema_version: u32,
    pub by_repo: BTreeMap<String, BTreeMap<String, StarEntry>>,
}

impl ForgeStarsState {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            by_repo: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StarOp {
    pub repo_prefix: String,
    pub fingerprint: String,
    pub starred_at: String,
    pub sig: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UnstarOp {
    pub repo_prefix: String,
    pub fingerprint: String,
    pub starred_at: String,
    pub sig: String,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum UpdateEnvelope {
    Star { star: StarOp },
    Unstar { unstar: UnstarOp },
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    out.push(0);
}

pub fn star_signing_payload(op: &StarOp) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(STAR_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.fingerprint.as_bytes());
    push_field(
        &mut out,
        op.label.as_deref().unwrap_or("").as_bytes(),
    );
    push_field(&mut out, op.starred_at.as_bytes());
    out
}

pub fn unstar_signing_payload(op: &UnstarOp) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(UNSTAR_DOMAIN);
    push_field(&mut out, op.repo_prefix.as_bytes());
    push_field(&mut out, op.fingerprint.as_bytes());
    push_field(&mut out, op.starred_at.as_bytes());
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
        .ok_or_else(|| "fingerprint must start with freenet:id:".to_string())?;
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

fn check_prefix(prefix: &str) -> Result<(), String> {
    let plen = prefix.len();
    if !(MIN_PREFIX_LEN..=MAX_PREFIX_LEN).contains(&plen) {
        return Err(format!("repo_prefix length {plen} out of range"));
    }
    Ok(())
}

fn apply_star(state: &mut ForgeStarsState, op: StarOp) -> Result<(), ContractError> {
    check_prefix(&op.repo_prefix).map_err(ContractError::Other)?;
    let vk = identity_vk_from_fingerprint(&op.fingerprint).map_err(ContractError::Other)?;
    let payload = star_signing_payload(&op);
    verify_ed25519(&vk, &op.sig, &payload).map_err(ContractError::Other)?;
    let entry = StarEntry {
        starred_at: op.starred_at,
        label: op.label,
        sig: op.sig,
    };
    state
        .by_repo
        .entry(op.repo_prefix)
        .or_default()
        .insert(op.fingerprint, entry);
    Ok(())
}

fn apply_unstar(state: &mut ForgeStarsState, op: UnstarOp) -> Result<(), ContractError> {
    check_prefix(&op.repo_prefix).map_err(ContractError::Other)?;
    let vk = identity_vk_from_fingerprint(&op.fingerprint).map_err(ContractError::Other)?;
    let payload = unstar_signing_payload(&op);
    verify_ed25519(&vk, &op.sig, &payload).map_err(ContractError::Other)?;
    if let Some(map) = state.by_repo.get_mut(&op.repo_prefix) {
        map.remove(&op.fingerprint);
        if map.is_empty() {
            state.by_repo.remove(&op.repo_prefix);
        }
    }
    Ok(())
}

fn parse_state(bytes: &[u8]) -> Result<ForgeStarsState, ContractError> {
    if bytes.is_empty() {
        return Ok(ForgeStarsState::empty());
    }
    serde_json::from_slice(bytes).map_err(|e| ContractError::Deser(e.to_string()))
}

fn apply_bytes(state: &mut ForgeStarsState, bytes: &[u8]) -> Result<(), ContractError> {
    if bytes.is_empty() {
        return Ok(());
    }
    if let Ok(env) = serde_json::from_slice::<UpdateEnvelope>(bytes) {
        match env {
            UpdateEnvelope::Star { star } => apply_star(state, star)?,
            UpdateEnvelope::Unstar { unstar } => apply_unstar(state, unstar)?,
        }
        return Ok(());
    }
    // Soft-merge full states from peers: only keep entries that verify.
    if let Ok(incoming) = serde_json::from_slice::<ForgeStarsState>(bytes) {
        for (prefix, map) in incoming.by_repo {
            for (fp, entry) in map {
                let op = StarOp {
                    repo_prefix: prefix.clone(),
                    fingerprint: fp.clone(),
                    starred_at: entry.starred_at.clone(),
                    sig: entry.sig.clone(),
                    label: entry.label.clone(),
                };
                if apply_star(state, op).is_err() {
                    continue;
                }
            }
        }
    }
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
        for (prefix, map) in &parsed.by_repo {
            check_prefix(prefix).map_err(ContractError::Other)?;
            for (fp, entry) in map {
                let op = StarOp {
                    repo_prefix: prefix.clone(),
                    fingerprint: fp.clone(),
                    starred_at: entry.starred_at.clone(),
                    sig: entry.sig.clone(),
                    label: entry.label.clone(),
                };
                let vk = identity_vk_from_fingerprint(fp).map_err(ContractError::Other)?;
                let payload = star_signing_payload(&op);
                verify_ed25519(&vk, &entry.sig, &payload).map_err(ContractError::Other)?;
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
                    apply_bytes(&mut current, s.as_ref())?;
                }
                UpdateData::Delta(s) => {
                    apply_bytes(&mut current, s.as_ref())?;
                }
                UpdateData::StateAndDelta { state: st, delta } => {
                    apply_bytes(&mut current, st.as_ref())?;
                    apply_bytes(&mut current, delta.as_ref())?;
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
        let total: usize = parsed.by_repo.values().map(|m| m.len()).sum();
        let summary = serde_json::json!({
            "schema_version": parsed.schema_version,
            "repos": parsed.by_repo.len(),
            "stars": total,
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn star_and_unstar() {
        let id = SigningKey::from_bytes(&[7u8; 32]);
        let id_vk = id.verifying_key().to_bytes();
        let fp = format!("freenet:id:{}", bs58::encode(&id_vk).into_string());
        let mut star = StarOp {
            repo_prefix: "abcdefghijkl".into(),
            fingerprint: fp.clone(),
            starred_at: "2026-01-01T00:00:00Z".into(),
            sig: String::new(),
            label: Some("demo".into()),
        };
        star.sig = hex::encode(id.sign(&star_signing_payload(&star)).to_bytes());
        let mut state = ForgeStarsState::empty();
        apply_star(&mut state, star).unwrap();
        assert_eq!(state.by_repo["abcdefghijkl"].len(), 1);

        let mut un = UnstarOp {
            repo_prefix: "abcdefghijkl".into(),
            fingerprint: fp,
            starred_at: "2026-01-02T00:00:00Z".into(),
            sig: String::new(),
        };
        un.sig = hex::encode(id.sign(&unstar_signing_payload(&un)).to_bytes());
        apply_unstar(&mut state, un).unwrap();
        assert!(state.by_repo.is_empty());
    }
}
