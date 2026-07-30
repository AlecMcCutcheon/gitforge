//! Browser-facing RepoState tip summary for GitForge.
//!
//! Compiles to wasm (`cdylib`) so the Freenet website SPA can pick a tip pack
//! without Node/`git`. Pack bytes are decoded in TypeScript.

use freenet_git_types::{ObjectBundle, RepoState};

const BUNDLE_TIP_PREFIX: &str = "bundle-tip:";

fn parse_bundle_tip_extension_key(ext_key: &str) -> Option<[u8; 32]> {
    let hex = ext_key.strip_prefix(BUNDLE_TIP_PREFIX)?;
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        let s = hex.get(i * 2..i * 2 + 2)?;
        *byte = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
struct TipBundleJson {
    bundle_id: String,
    tip_commit: String,
    kind: String,
    pack_hash: Option<String>,
    size_bytes: Option<u64>,
    manifest_hash: Option<String>,
    total_size: Option<u64>,
    chunk_count: Option<u32>,
}

#[derive(Serialize, Deserialize)]
struct RefJson {
    name: String,
    target: String,
}

#[derive(Serialize, Deserialize)]
struct SummaryJson {
    refs: Vec<RefJson>,
    default_branch: Option<String>,
    mirror_mode: Option<String>,
    /// Soft-delete extension JSON value when present (UTF-8).
    deleted: Option<String>,
    /// GitForge Pages extension JSON when present (UTF-8).
    pages: Option<String>,
    /// Owner-signed display name from RepoState.
    name: Option<String>,
    /// Owner-signed description (for `[deleted]` fallback).
    description: Option<String>,
    tipped_bundles: Vec<TipBundleJson>,
    legacy_untipped_count: usize,
}

fn err(msg: impl ToString) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// Decode freenet-git `RepoState` bytes into a JSON tip-browse summary.
#[wasm_bindgen]
pub fn summarize_repo_state(state_bytes: &[u8]) -> Result<String, JsValue> {
    let state = RepoState::from_bytes(state_bytes).map_err(|e| err(format!("{e}")))?;

    let mut tipped = Vec::new();
    for (key, entry) in &state.extensions {
        let Some(bundle_id) = parse_bundle_tip_extension_key(key) else {
            continue;
        };
        let tip: [u8; 20] = entry
            .value
            .as_slice()
            .try_into()
            .map_err(|_| err("bundle-tip value is not a 20-byte commit"))?;
        let Some(record) = state.object_index.get(&bundle_id) else {
            continue;
        };
        tipped.push(bundle_to_json(bundle_id, tip, &record.bundle));
    }

    let tipped_ids: std::collections::HashSet<_> =
        tipped.iter().map(|t| t.bundle_id.clone()).collect();
    let legacy_untipped_count = state
        .object_index
        .keys()
        .filter(|id| !tipped_ids.contains(&hex::encode(id)))
        .count();

    let refs = state
        .refs
        .iter()
        .map(|(name, entry)| RefJson {
            name: name.clone(),
            target: hex::encode(entry.target),
        })
        .collect();

    let mirror_mode = state.extensions.get("mirror-mode").and_then(|e| {
        let v = e.value.as_slice();
        if v == b"snapshot" {
            Some("snapshot".into())
        } else if v == b"history" {
            Some("history".into())
        } else {
            None
        }
    });

    let deleted = state.extensions.get("deleted").and_then(|e| {
        if e.value.is_empty() {
            None
        } else {
            String::from_utf8(e.value.clone()).ok()
        }
    });

    // NEW CODE - TESTING: Pages public meta for Open site / status
    let pages = state.extensions.get("pages").and_then(|e| {
        if e.value.is_empty() {
            None
        } else {
            String::from_utf8(e.value.clone()).ok()
        }
    });

    let summary = SummaryJson {
        refs,
        default_branch: state.default_branch.as_ref().map(|f| f.value.clone()),
        mirror_mode,
        deleted,
        pages,
        name: state.name.as_ref().map(|f| f.value.clone()),
        description: state.description.as_ref().map(|f| f.value.clone()),
        tipped_bundles: tipped,
        legacy_untipped_count,
    };
    serde_json::to_string(&summary).map_err(|e| err(e.to_string()))
}

/// Pick the tip bundle for a branch/ref short name or "HEAD". Returns JSON
/// `{ commit, bundle }` or an error if tip-browse is unsupported.
#[wasm_bindgen]
pub fn pick_tip_bundle(state_bytes: &[u8], git_ref: &str) -> Result<String, JsValue> {
    let state = RepoState::from_bytes(state_bytes).map_err(|e| err(format!("{e}")))?;
    let summary_raw = summarize_repo_state(state_bytes)?;
    let summary: SummaryJson =
        serde_json::from_str(&summary_raw).map_err(|e| err(e.to_string()))?;

    let commit = resolve_commit(&state, git_ref)?;
    let commit_hex = hex::encode(commit);
    let legacy_untipped = summary.legacy_untipped_count;
    let default_branch = summary.default_branch.clone();
    let mirror_mode = summary.mirror_mode.clone();

    let bundle = summary
        .tipped_bundles
        .into_iter()
        .find(|b| b.tip_commit == commit_hex)
        .ok_or_else(|| {
            err(format!(
                "tip-browse unsupported: no bundle-tip for commit {commit_hex}. \
                 tipped_bundles missing; legacy_untipped={legacy_untipped}"
            ))
        })?;

    serde_json::to_string(&serde_json::json!({
        "commit": commit_hex,
        "bundle": bundle,
        "default_branch": default_branch,
        "mirror_mode": mirror_mode,
    }))
    .map_err(|e| err(e.to_string()))
}

/// Decode a ChunkedPack manifest (bincode) to JSON `{ chunk_size, total_size, chunk_count, chunk_hashes: string[] }`.
#[wasm_bindgen]
pub fn decode_chunked_manifest(manifest_bytes: &[u8]) -> Result<String, JsValue> {
    let m = freenet_git_types::chunked::ChunkedPackManifestV1::from_bytes(manifest_bytes)
        .map_err(|e| err(format!("{e}")))?;
    let hashes: Vec<String> = m.chunk_hashes.iter().map(hex::encode).collect();
    serde_json::to_string(&serde_json::json!({
        "version": m.version,
        "chunk_size": m.chunk_size,
        "total_size": m.total_size,
        "chunk_count": m.chunk_count,
        "chunk_hashes": hashes,
    }))
    .map_err(|e| err(e.to_string()))
}

/// Split `pack_bytes` and encode a ChunkedPackManifestV1 (bincode). Wire format
/// must match freenet-git `types::chunked` — do not hand-roll bincode in TS.
#[wasm_bindgen]
pub fn encode_chunked_manifest(pack_bytes: &[u8], chunk_size: u32) -> Result<Vec<u8>, JsValue> {
    if pack_bytes.is_empty() {
        return Err(err("encode_chunked_manifest: empty pack"));
    }
    if chunk_size == 0 {
        return Err(err("encode_chunked_manifest: zero chunk_size"));
    }
    let chunks = freenet_git_types::chunked::split_pack(pack_bytes, chunk_size);
    let m = freenet_git_types::chunked::ChunkedPackManifestV1::from_chunks(chunk_size, &chunks);
    m.validate()
        .map_err(|e| err(format!("manifest self-check: {e}")))?;
    Ok(m.to_bytes())
}

fn resolve_commit(state: &RepoState, git_ref: &str) -> Result<[u8; 20], JsValue> {
    let normalized = git_ref.trim();
    if normalized.eq_ignore_ascii_case("HEAD") {
        let branch = state
            .default_branch
            .as_ref()
            .map(|f| f.value.clone())
            .unwrap_or_else(|| "refs/heads/main".to_string());
        return state
            .refs
            .get(&branch)
            .map(|e| e.target)
            .ok_or_else(|| err(format!("HEAD default branch {branch} missing")));
    }
    for c in [
        normalized.to_string(),
        format!("refs/heads/{normalized}"),
        format!("refs/tags/{normalized}"),
    ] {
        if let Some(entry) = state.refs.get(&c) {
            return Ok(entry.target);
        }
    }
    if normalized.len() == 40 {
        if let Ok(bytes) = hex::decode(normalized) {
            if bytes.len() == 20 {
                let mut h = [0u8; 20];
                h.copy_from_slice(&bytes);
                return Ok(h);
            }
        }
    }
    Err(err(format!("ref {normalized:?} not found")))
}

fn bundle_to_json(bundle_id: [u8; 32], tip: [u8; 20], bundle: &ObjectBundle) -> TipBundleJson {
    match bundle {
        ObjectBundle::SinglePack {
            pack_hash,
            size_bytes,
        } => TipBundleJson {
            bundle_id: hex::encode(bundle_id),
            tip_commit: hex::encode(tip),
            kind: "single".into(),
            pack_hash: Some(hex::encode(pack_hash)),
            size_bytes: Some(*size_bytes),
            manifest_hash: None,
            total_size: None,
            chunk_count: None,
        },
        ObjectBundle::ChunkedPack {
            manifest_hash,
            total_size,
            chunk_count,
        } => TipBundleJson {
            bundle_id: hex::encode(bundle_id),
            tip_commit: hex::encode(tip),
            kind: "chunked".into(),
            pack_hash: None,
            size_bytes: None,
            manifest_hash: Some(hex::encode(manifest_hash)),
            total_size: Some(*total_size),
            chunk_count: Some(*chunk_count),
        },
    }
}
