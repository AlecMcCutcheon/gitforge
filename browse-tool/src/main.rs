//! Tip-only Freenet pack fetch for GitForge.
//!
//! Skips legacy (untipped) bundles that stock `git-remote-freenet` always
//! downloads. Used for GitHub-style browse: one tip pack → tree/blob decode.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use freenet_git_cli::{chunked, ids, wsclient, PACK_CONTRACT_WASM, REPO_CONTRACT_WASM};
use freenet_git_tip::ensure_tip_in_cache;
use freenet_git_types::signing::{
    MIRROR_MODE_EXTENSION_KEY, MIRROR_MODE_VALUE_HISTORY, MIRROR_MODE_VALUE_SNAPSHOT,
};
use freenet_git_types::{ObjectBundle, RepoParams, RepoState};
use freenet_stdlib::client_api::WebApi;
use serde::Serialize;
use tokio::sync::Mutex;

#[derive(Parser)]
#[command(name = "freenet-forge-tip", about = "Tip-only Freenet git pack browse helper")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Fetch tip pack for prefix/ref into a cache git dir; print JSON summary.
    Ensure {
        #[arg(long)]
        prefix: String,
        /// Branch or tag short name, or refs/heads/…, or "HEAD"
        #[arg(long, default_value = "HEAD")]
        git_ref: String,
        #[arg(long, env = "GITFORGE_TIP_CACHE")]
        cache_root: Option<PathBuf>,
        #[arg(long, env = "FREENET_GIT_WS_URL", default_value = wsclient::DEFAULT_WS_URL)]
        ws_url: String,
        #[arg(long, env = "FREENET_GIT_WS_TIMEOUT_SECS", default_value_t = 90)]
        timeout_secs: u64,
        #[arg(long, default_value_t = 3)]
        retries: u32,
    },
    /// GET RepoState only; print signed name/description (no pack download).
    Meta {
        #[arg(long)]
        prefix: String,
        /// Cosmetic URL label to compare against RepoState.name
        #[arg(long)]
        label: Option<String>,
        #[arg(long, env = "FREENET_GIT_WS_URL", default_value = wsclient::DEFAULT_WS_URL)]
        ws_url: String,
        #[arg(long, env = "FREENET_GIT_WS_TIMEOUT_SECS", default_value_t = 90)]
        timeout_secs: u64,
    },
}

#[derive(Serialize)]
struct EnsureOut {
    prefix: String,
    git_ref: String,
    commit: String,
    bundle_id: String,
    git_dir: String,
    pack_path: String,
    mirror_mode: Option<String>,
    tip_pack_size: u64,
    tipped_packs: usize,
    default_branch: Option<String>,
    name: Option<String>,
    description: Option<String>,
}

fn default_cache_root() -> PathBuf {
    dirs_fallback_home()
        .join(".local")
        .join("share")
        .join("freenet-hub")
        .join("tips")
}

fn dirs_fallback_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn ws_timeout(secs: u64) -> Duration {
    Duration::from_secs(secs.max(5))
}

fn mirror_mode(state: &RepoState) -> Option<String> {
    let entry = state.extensions.get(MIRROR_MODE_EXTENSION_KEY)?;
    if entry.value.as_slice() == MIRROR_MODE_VALUE_SNAPSHOT {
        Some("snapshot".into())
    } else if entry.value.as_slice() == MIRROR_MODE_VALUE_HISTORY {
        Some("history".into())
    } else {
        None
    }
}

async fn download_bundle(
    api: &mut WebApi,
    ws_url: &str,
    bundle: &ObjectBundle,
    timeout: Duration,
    retries: u32,
) -> Result<Vec<u8>> {
    let mut last_err = None;
    for attempt in 1..=retries.max(1) {
        let result = match bundle {
            ObjectBundle::SinglePack {
                pack_hash,
                size_bytes,
            } => {
                eprintln!(
                    "tip-browse: downloading SinglePack ({} bytes) attempt {attempt}/{retries}",
                    size_bytes
                );
                wsclient::get_pack(api, PACK_CONTRACT_WASM, *pack_hash, timeout).await
            }
            ObjectBundle::ChunkedPack {
                manifest_hash,
                total_size,
                chunk_count,
            } => {
                eprintln!(
                    "tip-browse: downloading ChunkedPack {chunk_count} chunks ({} bytes) attempt {attempt}/{retries}",
                    total_size
                );
                chunked::fetch_chunked_pack_with_progress(
                    ws_url,
                    PACK_CONTRACT_WASM,
                    *manifest_hash,
                    *total_size,
                    *chunk_count,
                    chunked::parallelism_from_env(),
                    timeout,
                    |done, total| {
                        eprintln!("tip-browse: chunk {done}/{total}");
                    },
                )
                .await
            }
        };
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(e) => {
                eprintln!("tip-browse: attempt {attempt} failed: {e:#}");
                last_err = Some(e);
                *api = wsclient::connect(ws_url).await?;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("download failed")))
}

async fn fetch_repo_state(
    api: &mut WebApi,
    prefix: &str,
    timeout: Duration,
) -> Result<RepoState> {
    let contract_id = ids::repo_contract_id_from_prefix(REPO_CONTRACT_WASM, prefix);
    eprintln!("tip-browse: repo instance {contract_id}");
    let params = RepoParams {
        prefix: prefix.to_string(),
    };
    let params_bytes = params.to_bytes();
    let legacy: Vec<&[u8; 32]> = freenet_git_cli::legacy::LEGACY_REPO_CONTRACT_WASM_HASHES
        .iter()
        .map(|(h, _)| *h)
        .collect();

    let legacy_get = wsclient::get_state_with_legacy_fallback(
        api,
        contract_id,
        &params_bytes,
        &legacy,
        timeout,
    )
    .await
    .context("GET RepoState")?;

    RepoState::from_bytes(&legacy_get.state).map_err(|e| anyhow!("decode RepoState: {e}"))
}

async fn ensure(
    prefix: String,
    git_ref: String,
    cache_root: PathBuf,
    ws_url: String,
    timeout_secs: u64,
    retries: u32,
) -> Result<()> {
    let timeout = ws_timeout(timeout_secs);
    let api = wsclient::connect(&ws_url).await?;
    let api_cell = Arc::new(Mutex::new(api));
    let state = {
        let mut guard = api_cell.lock().await;
        fetch_repo_state(&mut guard, &prefix, timeout).await?
    };

    let ws_url_c = ws_url.clone();
    let tip = ensure_tip_in_cache(&prefix, &state, &git_ref, &cache_root, {
        let api_cell = api_cell.clone();
        move |bundle| {
            let api_cell = api_cell.clone();
            let ws_url = ws_url_c.clone();
            async move {
                let mut guard = api_cell.lock().await;
                download_bundle(&mut guard, &ws_url, &bundle, timeout, retries).await
            }
        }
    })
    .await?;

    let default_branch = state.default_branch.as_ref().map(|f| f.value.to_string());
    let name = state.name.as_ref().map(|f| f.value.clone());
    let description = state.description.as_ref().map(|f| f.value.clone());
    let head_pack = tip
        .git_dir
        .parent()
        .unwrap()
        .join("packs")
        .join(format!("{}.pack", tip.bundle_id));

    let out = EnsureOut {
        prefix: tip.prefix,
        git_ref: tip.git_ref,
        commit: tip.commit,
        bundle_id: tip.bundle_id,
        git_dir: tip.git_dir.display().to_string(),
        pack_path: head_pack.display().to_string(),
        mirror_mode: mirror_mode(&state),
        tip_pack_size: tip.tip_pack_size,
        tipped_packs: tip.tipped_packs,
        default_branch,
        name,
        description,
    };
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

#[derive(Serialize)]
struct MetaOut {
    prefix: String,
    label: Option<String>,
    name: Option<String>,
    description: Option<String>,
    default_branch: Option<String>,
    refs_count: usize,
    empty: bool,
    label_matches_name: Option<bool>,
}

async fn meta(
    prefix: String,
    label: Option<String>,
    ws_url: String,
    timeout_secs: u64,
) -> Result<()> {
    let timeout = ws_timeout(timeout_secs);
    let mut api = wsclient::connect(&ws_url).await?;
    let state = fetch_repo_state(&mut api, &prefix, timeout).await?;

    let name = state.name.as_ref().map(|f| f.value.clone());
    let label_matches_name = label.as_ref().map(|l| Some(l.as_str()) == name.as_deref());

    let out = MetaOut {
        prefix,
        label,
        name,
        description: state.description.as_ref().map(|f| f.value.clone()),
        default_branch: state.default_branch.as_ref().map(|f| f.value.to_string()),
        refs_count: state.refs.len(),
        empty: state.refs.is_empty() && state.object_index.is_empty(),
        label_matches_name,
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Ensure {
            prefix,
            git_ref,
            cache_root,
            ws_url,
            timeout_secs,
            retries,
        } => {
            ensure(
                prefix,
                git_ref,
                cache_root.unwrap_or_else(default_cache_root),
                ws_url,
                timeout_secs,
                retries,
            )
            .await
        }
        Cmd::Meta {
            prefix,
            label,
            ws_url,
            timeout_secs,
        } => meta(prefix, label, ws_url, timeout_secs).await,
    }
}
