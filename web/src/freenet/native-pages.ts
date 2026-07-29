/**
 * Freenet-native GitAtlas Pages: tip extract → pages-delegate sign → website Put
 * → RepoState `pages` extension.
 */
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { ContractKey } from "@freenetorg/freenet-stdlib";
import type { HubPagesConfig } from "../api";
import { sendDelegateMessage } from "./delegate-api";
import {
  HUB_IDENTITY_CODE_HASH_BYTES,
  HUB_IDENTITY_KEY_BYTES,
  hubOwnerContractsReady,
} from "./owner-constants";
import { hubPagesReady, HUB_PAGES_CODE_HASH_BYTES, HUB_PAGES_KEY_BYTES } from "./pages-constants";
import {
  extractSiteFromTip,
  tombstoneSiteFiles,
} from "./pages-extract";
import {
  emptyRepoPagesMeta,
  loadPagesAutoSync,
  loadPagesMetaLocal,
  pagesSiteUrl,
  parseRepoPagesMeta,
  savePagesAutoSync,
  savePagesMetaLocal,
  serializeRepoPagesMeta,
  websiteKeyNameFor,
  type RepoPagesMeta,
} from "./pages-types";
import {
  buildUstarArchive,
  bytesToHex,
  hexToBytes,
  packWebAppState,
} from "./pages-ustar";
import { buildPutRequest } from "./put";
import { deriveInstanceId } from "./keys";
import { encodeRepoParams, repoContractKey } from "./keys";
import { REPO_WASM_HASH_B58 } from "./constants";
import { summarizeRepoState } from "../tip-browse/decode-wasm";
import { clearRepoStateCache, fetchRepoState } from "./tip-fetch";
import {
  getFreenetApi,
  onDelegatePayloads,
  onFreenetConnDrop,
  onFreenetHostError,
  putContract,
} from "./ws";

const PAGES_WRITE_TIMEOUT_MS = 600_000;

function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${PAGES_WRITE_TIMEOUT_MS}ms`),
        ),
      PAGES_WRITE_TIMEOUT_MS,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function waitForDelegate<T extends { type?: string; nonce?: string; message?: string }>(
  match: (p: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      unsubDrop();
      unsubHost();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("delegate response timeout"))),
      timeoutMs,
    );
    const unsubDrop = onFreenetConnDrop(() => {
      finish(() => reject(new Error("Connection closed")));
    });
    const unsubHost = onFreenetHostError((err) => {
      finish(() => reject(err));
    });
    const unsub = onDelegatePayloads((payloads) => {
      for (const raw of payloads) {
        const p = raw as T;
        if (!match(p)) continue;
        finish(() => {
          if (p.type === "Error") {
            reject(new Error(p.message ?? "delegate error"));
            return;
          }
          resolve(p);
        });
        return;
      }
    });
  });
}

async function withIdentityDelegate(): Promise<{
  api: Awaited<ReturnType<typeof getFreenetApi>>;
  key: number[];
  codeHash: number[];
}> {
  if (!hubOwnerContractsReady()) {
    throw new Error(
      "Owner contracts not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const api = await getFreenetApi();
  return {
    api,
    key: HUB_IDENTITY_KEY_BYTES,
    codeHash: HUB_IDENTITY_CODE_HASH_BYTES,
  };
}

async function withPagesDelegate(): Promise<{
  api: Awaited<ReturnType<typeof getFreenetApi>>;
  key: number[];
  codeHash: number[];
}> {
  if (!hubPagesReady()) {
    throw new Error(
      "Pages delegate not built — run scripts/build-hub-owner-tools.sh and publish hub-pages",
    );
  }
  const api = await getFreenetApi();
  return {
    api,
    key: HUB_PAGES_KEY_BYTES,
    codeHash: HUB_PAGES_CODE_HASH_BYTES,
  };
}

async function loadRepoPagesMeta(prefix: string): Promise<RepoPagesMeta | null> {
  try {
    const state = await fetchRepoState(prefix);
    const summary = (await summarizeRepoState(state)) as { pages?: string | null };
    const fromChain = parseRepoPagesMeta(summary.pages ?? null);
    if (fromChain) return fromChain;
  } catch {
    /* fall through to local mirror */
  }
  return loadPagesMetaLocal(prefix);
}

/**
 * Pages Enable / Sync / Disable require:
 * 1. Signed-in GitAtlas identity
 * 2. Repo site key on that identity
 * 3. Live HubRegistry listing owned by that identity (registered on GitAtlas)
 */
export async function assertPagesAuthority(prefix: string): Promise<{
  fingerprint: string;
  label: string;
}> {
  const { nativeGetIdentity, nativeListRepos } = await import("./owner-api");
  const id = await nativeGetIdentity();
  if (!id?.fingerprint) {
    throw new Error(
      "Sign in with a GitAtlas identity to manage Pages for this repository",
    );
  }
  const localRepos = await nativeListRepos();
  if (!localRepos.some((r) => r.prefix === prefix)) {
    throw new Error(
      "This repository’s site key is not on your identity — Import the key, then Register on GitAtlas before enabling Pages",
    );
  }
  const { fetchHubRegistry } = await import("./hub-registry");
  const { repos } = await fetchHubRegistry();
  const listing = repos.find((r) => r.repo_prefix === prefix);
  if (!listing) {
    throw new Error(
      "Repository must be registered on GitAtlas (Discover) before you can enable or update Pages",
    );
  }
  if (listing.identity_fingerprint !== id.fingerprint) {
    throw new Error(
      "Only the GitAtlas registry owner for this repository can manage Pages",
    );
  }
  return { fingerprint: id.fingerprint, label: listing.label };
}

/**
 * Before unregister / soft-delete: if Pages is enabled, disable + tombstone the
 * website contract so lifecycle cannot leave a live GitAtlas site behind.
 */
export async function ensurePagesTakenDown(prefix: string): Promise<void> {
  const meta = await loadRepoPagesMeta(prefix);
  if (!meta?.enabled) return;
  let label = "repo";
  try {
    const auth = await assertPagesAuthority(prefix);
    label = auth.label;
  } catch (err) {
    // Still try take-down if we have the pages key (best-effort before delete).
    console.warn(
      "[pages] authority check before take-down:",
      err instanceof Error ? err.message : err,
    );
  }
  await nativePagesDisable(prefix, label, {
    tombstone: true,
    skipAuthorityCheck: true,
  });
}

function metaToConfig(
  prefix: string,
  label: string,
  meta: RepoPagesMeta | null,
  extras?: Partial<HubPagesConfig>,
): HubPagesConfig {
  const m = meta ?? emptyRepoPagesMeta();
  const autoSync = loadPagesAutoSync(prefix, true);
  const contractKey = m.contract_key;
  return {
    repo_prefix: prefix,
    label,
    enabled: Boolean(m.enabled && contractKey),
    autoSync,
    branch: m.branch || "main",
    rootPath: m.root_path || "",
    websiteKeyName: websiteKeyNameFor(prefix),
    contractKey,
    siteUrl: contractKey ? pagesSiteUrl(contractKey) : null,
    lastPublishedCommit: m.last_commit,
    lastPublishedAt: m.updated_at,
    status: m.enabled && contractKey ? "ready" : "off",
    lastError: null,
    version: 0,
    ...extras,
  };
}

export async function nativePagesStatus(
  prefix: string,
  label: string,
  autoSync = false,
): Promise<HubPagesConfig> {
  const meta = await loadRepoPagesMeta(prefix);
  let cfg = metaToConfig(prefix, label, meta);
  if (autoSync && cfg.enabled && cfg.autoSync) {
    try {
      cfg = await nativePagesSync(prefix, label);
    } catch (err) {
      cfg = {
        ...cfg,
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return cfg;
}

async function compressAndSignWebsite(
  prefix: string,
  files: Map<string, Uint8Array>,
): Promise<{
  verifying_key_hex: string;
  version: number;
  metadata: Uint8Array;
  archive: Uint8Array;
}> {
  const tar = buildUstarArchive(files);
  const version = Math.floor(Date.now() / 1000);
  const { api, key, codeHash } = await withPagesDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    verifying_key_hex?: string;
    version?: number;
    metadata_hex?: string;
    archive_hex?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedWebsite" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
    PAGES_WRITE_TIMEOUT_MS,
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "CompressAndSign",
    nonce: n,
    prefix,
    version,
    tar_hex: bytesToHex(tar),
  });
  const signed = await pending;
  if (
    signed.type === "Error" ||
    !signed.verifying_key_hex ||
    !signed.metadata_hex ||
    !signed.archive_hex ||
    signed.version == null
  ) {
    throw new Error(signed.message ?? "CompressAndSign failed");
  }
  return {
    verifying_key_hex: signed.verifying_key_hex,
    version: signed.version,
    metadata: hexToBytes(signed.metadata_hex),
    archive: hexToBytes(signed.archive_hex),
  };
}

async function putWebsiteContract(
  verifyingKeyHex: string,
  metadata: Uint8Array,
  archive: Uint8Array,
): Promise<{ contractKey: string; siteKey: ContractKey }> {
  const wasmResp = await fetch("./website_contract.wasm");
  if (!wasmResp.ok) {
    throw new Error(
      "failed to fetch website_contract.wasm — copy from freenet-core fdev resources into web/public/",
    );
  }
  const wasm = new Uint8Array(await wasmResp.arrayBuffer());
  const codeHash = blake3(wasm);
  const codeHashB58 = bs58.encode(codeHash);
  const params = hexToBytes(verifyingKeyHex);
  if (params.length !== 32) {
    throw new Error(`website verifying key must be 32 bytes, got ${params.length}`);
  }
  const state = packWebAppState(metadata, archive);
  const MAX_STATE = 50 * 1024 * 1024;
  if (state.length > MAX_STATE) {
    throw new Error(
      `Website is ${(state.length / (1024 * 1024)).toFixed(1)} MiB after pack, exceeding Freenet's 50 MiB limit`,
    );
  }
  const instance = deriveInstanceId(codeHashB58, params);
  const siteKey = new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeHash,
  );
  const putReq = buildPutRequest(wasm, codeHashB58, params, state);
  await withWriteTimeout(putContract(putReq, siteKey), "website Pages Put");
  return { contractKey: instance.base58, siteKey };
}

async function signAndPutRepoPages(
  prefix: string,
  meta: RepoPagesMeta,
): Promise<void> {
  const stateBytes = await fetchRepoState(prefix);
  const stateHex = bytesToHex(stateBytes);
  const pagesJson = serializeRepoPagesMeta(meta);
  const { api, key, codeHash } = await withIdentityDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    delta_hex?: string;
    state_hex?: string;
    pages_json?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRepoPages" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRepoPages",
    nonce: n,
    prefix,
    state_hex: stateHex,
    pages_json: pagesJson,
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.state_hex) {
    throw new Error(signed.message ?? "SignRepoPages failed");
  }
  const repoKey = repoContractKey(prefix);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const wasmResp = await fetch("./repo-contract.wasm");
  // if (!wasmResp.ok) {
  //   throw new Error("failed to fetch repo-contract.wasm");
  // }
  // const repoWasm = new Uint8Array(await wasmResp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  const { loadPublicWasm } = await import("./wasm-cache");
  const repoWasm = await loadPublicWasm("./repo-contract.wasm");
  const putReq = buildPutRequest(
    repoWasm,
    REPO_WASM_HASH_B58,
    encodeRepoParams(prefix),
    hexToBytes(signed.state_hex),
  );
  await withWriteTimeout(putContract(putReq, repoKey), "repo pages meta Put");
  clearRepoStateCache(prefix);
}

async function publishSiteFiles(
  prefix: string,
  files: Map<string, Uint8Array>,
  branch: string,
  rootPath: string,
  commit: string | null,
  enabled: boolean,
  identityFingerprint: string | null,
): Promise<RepoPagesMeta> {
  const signed = await compressAndSignWebsite(prefix, files);
  const { contractKey } = await putWebsiteContract(
    signed.verifying_key_hex,
    signed.metadata,
    signed.archive,
  );
  const meta: RepoPagesMeta = {
    enabled,
    contract_key: contractKey,
    branch,
    root_path: rootPath,
    last_commit: commit,
    updated_at: new Date().toISOString(),
    verifying_key_hex: signed.verifying_key_hex,
    identity_fingerprint: identityFingerprint,
  };
  await signAndPutRepoPages(prefix, meta);
  savePagesMetaLocal(prefix, meta);
  return meta;
}

export async function nativePagesEnable(
  prefix: string,
  label: string,
  body: { branch?: string; rootPath?: string; autoSync?: boolean } = {},
): Promise<HubPagesConfig> {
  const auth = await assertPagesAuthority(prefix);
  const branch = (body.branch ?? "main").trim() || "main";
  const rootPath = (body.rootPath ?? "").trim();
  if (body.autoSync != null) savePagesAutoSync(prefix, body.autoSync);
  else savePagesAutoSync(prefix, true);

  // Ensure key exists (Create on first Enable)
  {
    const { api, key, codeHash } = await withPagesDelegate();
    const n = nonce();
    const pending = waitForDelegate<{
      type: string;
      nonce: string;
      message?: string;
    }>(
      (p) =>
        (p.type === "PagesKey" && p.nonce === n) ||
        (p.type === "Error" && p.nonce === n),
    );
    await sendDelegateMessage(api, key, codeHash, {
      type: "EnsureKey",
      nonce: n,
      prefix,
    });
    const ensured = await pending;
    if (ensured.type === "Error") {
      throw new Error(ensured.message ?? "EnsureKey failed");
    }
  }

  const extracted = await extractSiteFromTip(prefix, branch, rootPath);
  const meta = await publishSiteFiles(
    prefix,
    extracted.files,
    extracted.branch,
    extracted.rootPath,
    extracted.commit,
    true,
    auth.fingerprint,
  );
  return metaToConfig(prefix, label || auth.label, meta, {
    status: "ready",
    version: 1,
  });
}

export async function nativePagesSync(
  prefix: string,
  label: string,
): Promise<HubPagesConfig> {
  const auth = await assertPagesAuthority(prefix);
  const existing = await loadRepoPagesMeta(prefix);
  if (!existing?.enabled || !existing.contract_key) {
    throw new Error("Pages are not enabled for this repository");
  }
  const branch = existing.branch || "main";
  const rootPath = existing.root_path || "";
  try {
    const extracted = await extractSiteFromTip(prefix, branch, rootPath);
    if (
      existing.last_commit &&
      extracted.commit === existing.last_commit.toLowerCase()
    ) {
      return metaToConfig(prefix, label, existing, { status: "ready" });
    }
    const meta = await publishSiteFiles(
      prefix,
      extracted.files,
      extracted.branch,
      extracted.rootPath,
      extracted.commit,
      true,
      auth.fingerprint,
    );
    return metaToConfig(prefix, label, meta, { status: "ready" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
}

export async function nativePagesDisable(
  prefix: string,
  label: string,
  body: { tombstone?: boolean; skipAuthorityCheck?: boolean } = {},
): Promise<HubPagesConfig> {
  let fingerprint: string | null = null;
  if (!body.skipAuthorityCheck) {
    const auth = await assertPagesAuthority(prefix);
    fingerprint = auth.fingerprint;
  } else {
    fingerprint = (await loadRepoPagesMeta(prefix))?.identity_fingerprint ?? null;
  }
  const existing = await loadRepoPagesMeta(prefix);
  const branch = existing?.branch || "main";
  const rootPath = existing?.root_path || "";
  let contractKey = existing?.contract_key ?? null;
  let vk = existing?.verifying_key_hex ?? null;
  let commit = existing?.last_commit ?? null;

  if (body.tombstone !== false && existing?.enabled && existing.contract_key) {
    try {
      const files = tombstoneSiteFiles();
      const signed = await compressAndSignWebsite(prefix, files);
      const put = await putWebsiteContract(
        signed.verifying_key_hex,
        signed.metadata,
        signed.archive,
      );
      contractKey = put.contractKey;
      vk = signed.verifying_key_hex;
      commit = null;
    } catch (err) {
      console.warn(
        "[pages] tombstone site update failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const meta: RepoPagesMeta = {
    enabled: false,
    contract_key: contractKey,
    branch,
    root_path: rootPath,
    last_commit: commit,
    updated_at: new Date().toISOString(),
    verifying_key_hex: vk,
    identity_fingerprint: fingerprint,
  };
  await signAndPutRepoPages(prefix, meta);
  savePagesAutoSync(prefix, false);
  savePagesMetaLocal(prefix, meta);
  return metaToConfig(prefix, label, meta, { status: "off", autoSync: false });
}

export interface ExportedPagesKey {
  prefix: string;
  secret_hex: string;
  label: string;
  verifying_key_hex?: string;
}

/** Export all pages website signing keys from pages-delegate (for HubVault). */
export async function nativeExportPagesKeys(): Promise<ExportedPagesKey[]> {
  const { api, key, codeHash } = await withPagesDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    keys?: ExportedPagesKey[];
    message?: string;
  }>(
    (p) =>
      (p.type === "ExportedKeys" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "ExportKeys",
    nonce: n,
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "ExportKeys failed");
  }
  return res.keys ?? [];
}

export async function nativeImportPagesKey(
  prefix: string,
  secretHex: string,
  label = "",
): Promise<void> {
  const { api, key, codeHash } = await withPagesDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "ImportedKey" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "ImportKey",
    nonce: n,
    prefix,
    secret_key: secretHex,
    label,
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "ImportKey failed");
  }
}
