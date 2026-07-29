//! FreenetHub Pages delegate — website signing keys for GitAtlas Pages.
//!
//! Holds per-repo ed25519 secrets (`pages_sk:<prefix>`); compresses ustar → xz
//! and signs WebContainerMetadata (version || archive).
//! ExportKeys returns signing material for HubVault seal / local fdev use
//! (owner-driven ApplicationMessage only).

#![allow(unexpected_cfgs)]

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::Cursor;

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

struct HubPagesDelegate;

const SECRET_INDEX: &[u8] = b"pages_index_json";

/// Matches freenet-core website-contract / fdev WebContainerMetadata (CBOR).
#[derive(Serialize, Deserialize)]
struct WebContainerMetadata {
    version: u32,
    signature: Signature,
}

#[derive(Serialize, Deserialize, Clone)]
struct IndexEntry {
    prefix: String,
    label: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Request {
    EnsureKey {
        nonce: String,
        prefix: String,
    },
    CompressAndSign {
        nonce: String,
        prefix: String,
        version: u32,
        tar_hex: String,
    },
    /// List prefixes that have a pages signing key on this node.
    ListKeys {
        nonce: String,
    },
    /// Export all pages signing secrets (for HubVault seal / fdev).
    ExportKeys {
        nonce: String,
    },
    /// Import / overwrite a pages signing key (vault pull).
    ImportKey {
        nonce: String,
        prefix: String,
        secret_key: String,
        #[serde(default)]
        label: String,
    },
}

#[derive(Serialize, Deserialize)]
struct ExportedPageKey {
    prefix: String,
    secret_hex: String,
    label: String,
    verifying_key_hex: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum Response {
    PagesKey {
        nonce: String,
        prefix: String,
        verifying_key_hex: String,
        key_name: String,
        created: bool,
    },
    SignedWebsite {
        nonce: String,
        prefix: String,
        verifying_key_hex: String,
        version: u32,
        metadata_hex: String,
        archive_hex: String,
    },
    KeyList {
        nonce: String,
        keys: Vec<IndexEntry>,
    },
    ExportedKeys {
        nonce: String,
        keys: Vec<ExportedPageKey>,
    },
    ImportedKey {
        nonce: String,
        prefix: String,
        verifying_key_hex: String,
        label: String,
    },
    Error {
        message: String,
        nonce: Option<String>,
    },
}

fn secret_key_for(prefix: &str) -> Vec<u8> {
    format!("pages_sk:{prefix}").into_bytes()
}

fn website_key_name(prefix: &str) -> String {
    let safe: String = prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-')
        .take(24)
        .collect();
    let safe = if safe.is_empty() {
        "repo".to_string()
    } else {
        safe
    };
    format!("hub-pages-{safe}")
}

fn load_index(ctx: &DelegateCtx) -> Vec<IndexEntry> {
    match ctx.get_secret(SECRET_INDEX) {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        None => Vec::new(),
    }
}

fn save_index(ctx: &mut DelegateCtx, entries: &[IndexEntry]) {
    if let Ok(bytes) = serde_json::to_vec(entries) {
        ctx.set_secret(SECRET_INDEX, &bytes);
    }
}

fn index_upsert(ctx: &mut DelegateCtx, prefix: &str, label: &str) {
    let mut entries = load_index(ctx);
    if let Some(e) = entries.iter_mut().find(|e| e.prefix == prefix) {
        if !label.is_empty() {
            e.label = label.to_string();
        }
    } else {
        entries.push(IndexEntry {
            prefix: prefix.to_string(),
            label: if label.is_empty() {
                website_key_name(prefix)
            } else {
                label.to_string()
            },
        });
    }
    save_index(ctx, &entries);
}

fn load_or_create_sk(ctx: &mut DelegateCtx, prefix: &str) -> Result<(SigningKey, bool), String> {
    let secret_id = secret_key_for(prefix);
    if let Some(bytes) = ctx.get_secret(&secret_id) {
        if bytes.len() != 32 {
            return Err("pages signing key corrupt (expected 32 bytes)".into());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        return Ok((SigningKey::from_bytes(&arr), false));
    }
    let mut key_bytes = [0u8; 32];
    let rnd = freenet_stdlib::rand::rand_bytes(32);
    key_bytes.copy_from_slice(&rnd[..32]);
    let sk = SigningKey::from_bytes(&key_bytes);
    ctx.set_secret(&secret_id, &key_bytes);
    index_upsert(ctx, prefix, "");
    Ok((sk, true))
}

fn ensure_key(ctx: &mut DelegateCtx, nonce: &str, prefix: &str) -> Response {
    if prefix.trim().is_empty() {
        return Response::Error {
            message: "prefix required".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    match load_or_create_sk(ctx, prefix) {
        Ok((sk, created)) => {
            if created {
                index_upsert(ctx, prefix, "");
            }
            let vk = sk.verifying_key();
            Response::PagesKey {
                nonce: nonce.to_string(),
                prefix: prefix.to_string(),
                verifying_key_hex: hex::encode(vk.to_bytes()),
                key_name: website_key_name(prefix),
                created,
            }
        }
        Err(message) => Response::Error {
            message,
            nonce: Some(nonce.to_string()),
        },
    }
}

fn list_keys(ctx: &DelegateCtx, nonce: &str) -> Response {
    Response::KeyList {
        nonce: nonce.to_string(),
        keys: load_index(ctx),
    }
}

fn export_keys(ctx: &DelegateCtx, nonce: &str) -> Response {
    let index = load_index(ctx);
    let mut keys = Vec::new();
    for entry in index {
        let secret_id = secret_key_for(&entry.prefix);
        let Some(bytes) = ctx.get_secret(&secret_id) else {
            continue;
        };
        if bytes.len() != 32 {
            continue;
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        let sk = SigningKey::from_bytes(&arr);
        keys.push(ExportedPageKey {
            prefix: entry.prefix.clone(),
            secret_hex: hex::encode(sk.to_bytes()),
            label: entry.label.clone(),
            verifying_key_hex: hex::encode(sk.verifying_key().to_bytes()),
        });
    }
    Response::ExportedKeys {
        nonce: nonce.to_string(),
        keys,
    }
}

fn import_key(ctx: &mut DelegateCtx, nonce: &str, prefix: &str, secret_key: &str, label: &str) -> Response {
    if prefix.trim().is_empty() {
        return Response::Error {
            message: "prefix required".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let bytes = match hex::decode(secret_key.trim()) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "secret_key is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    if bytes.len() != 32 {
        return Response::Error {
            message: format!("secret_key must be 32 bytes, got {}", bytes.len()),
            nonce: Some(nonce.to_string()),
        };
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    let sk = SigningKey::from_bytes(&arr);
    ctx.set_secret(&secret_key_for(prefix), &arr);
    let key_label = if label.trim().is_empty() {
        website_key_name(prefix)
    } else {
        label.trim().to_string()
    };
    index_upsert(ctx, prefix, &key_label);
    Response::ImportedKey {
        nonce: nonce.to_string(),
        prefix: prefix.to_string(),
        verifying_key_hex: hex::encode(sk.verifying_key().to_bytes()),
        label: key_label,
    }
}

fn compress_and_sign(
    ctx: &mut DelegateCtx,
    nonce: &str,
    prefix: &str,
    version: u32,
    tar_hex: &str,
) -> Response {
    if prefix.trim().is_empty() {
        return Response::Error {
            message: "prefix required".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    let tar = match hex::decode(tar_hex.trim()) {
        Ok(b) => b,
        Err(_) => {
            return Response::Error {
                message: "tar_hex is not valid hex".into(),
                nonce: Some(nonce.to_string()),
            };
        }
    };
    if tar.is_empty() {
        return Response::Error {
            message: "empty tar archive".into(),
            nonce: Some(nonce.to_string()),
        };
    }
    const MAX_TAR: usize = 80 * 1024 * 1024;
    if tar.len() > MAX_TAR {
        return Response::Error {
            message: format!("tar archive too large ({} bytes)", tar.len()),
            nonce: Some(nonce.to_string()),
        };
    }

    let sk = match load_or_create_sk(ctx, prefix) {
        Ok((k, _)) => k,
        Err(message) => {
            return Response::Error {
                message,
                nonce: Some(nonce.to_string()),
            };
        }
    };

    let mut compressed = Vec::new();
    if let Err(e) = lzma_rs::xz_compress(&mut Cursor::new(&tar), &mut compressed) {
        return Response::Error {
            message: format!("xz compress failed: {e}"),
            nonce: Some(nonce.to_string()),
        };
    }

    let mut message = version.to_be_bytes().to_vec();
    message.extend_from_slice(&compressed);
    let signature = sk.sign(&message);
    let metadata = WebContainerMetadata { version, signature };
    let mut metadata_bytes = Vec::new();
    if let Err(e) = ciborium::ser::into_writer(&metadata, &mut metadata_bytes) {
        return Response::Error {
            message: format!("metadata CBOR failed: {e}"),
            nonce: Some(nonce.to_string()),
        };
    }

    let vk: VerifyingKey = sk.verifying_key();
    Response::SignedWebsite {
        nonce: nonce.to_string(),
        prefix: prefix.to_string(),
        verifying_key_hex: hex::encode(vk.to_bytes()),
        version,
        metadata_hex: hex::encode(metadata_bytes),
        archive_hex: hex::encode(compressed),
    }
}

#[delegate]
impl DelegateInterface for HubPagesDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        _parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        match &origin {
            Some(MessageOrigin::WebApp(_)) | None => {}
            Some(MessageOrigin::Delegate(_)) => {
                return Err(DelegateError::Other(
                    "hub-pages does not accept inter-delegate calls".into(),
                ));
            }
            other => {
                return Err(DelegateError::Other(format!(
                    "hub-pages rejects origin {other:?}"
                )));
            }
        }

        match message {
            InboundDelegateMsg::ApplicationMessage(app_msg) => {
                let request: Request = serde_json::from_slice(&app_msg.payload)
                    .map_err(|e| DelegateError::Other(format!("invalid request: {e}")))?;

                let response = match request {
                    Request::EnsureKey { nonce, prefix } => ensure_key(ctx, &nonce, &prefix),
                    Request::CompressAndSign {
                        nonce,
                        prefix,
                        version,
                        tar_hex,
                    } => compress_and_sign(ctx, &nonce, &prefix, version, &tar_hex),
                    Request::ListKeys { nonce } => list_keys(ctx, &nonce),
                    Request::ExportKeys { nonce } => export_keys(ctx, &nonce),
                    Request::ImportKey {
                        nonce,
                        prefix,
                        secret_key,
                        label,
                    } => import_key(ctx, &nonce, &prefix, &secret_key, &label),
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
