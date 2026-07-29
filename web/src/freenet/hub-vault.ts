/**
 * HubVault contract GET / Put / Update over Freenet WS.
 * Locator is seed-derived vault_id (64 hex), not email.
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import {
  HUB_VAULT_WASM_HASH_B58,
  hubVaultReady,
} from "./owner-constants";
import { deriveInstanceId } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import {
  getContractState,
  putContract,
  tryGetContractState,
  updateContract,
} from "./ws";
import {
  type HubVaultPublicState,
  normalizeVaultId,
  vaultParamsUtf8,
} from "./vault-crypto";

/** Same class of hang as GitAtlas profile — Update often never ACKs on this gateway. */
const VAULT_WRITE_TIMEOUT_MS = 45_000;

function paramsBytesForVaultId(vaultId: string): Uint8Array {
  return new TextEncoder().encode(vaultParamsUtf8(vaultId));
}

export function hubVaultKeyForId(vaultId: string): ContractKey | null {
  if (!HUB_VAULT_WASM_HASH_B58) return null;
  const params = paramsBytesForVaultId(vaultId);
  const instance = deriveInstanceId(HUB_VAULT_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(HUB_VAULT_WASM_HASH_B58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

function parseVaultState(bytes: Uint8Array): HubVaultPublicState | null {
  if (!bytes.length) return null;
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as HubVaultPublicState;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!data?.vault_id || !data.identity_cipher?.blob_b64) return null;
  // NEW CODE - TESTING: passwordless v4 requires identity_dek_wrap
  if (!data?.vault_id || !data.identity_dek_wrap?.blob_b64) return null;
  if (!data.envelopes || typeof data.envelopes !== "object") return null;
  return data;
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${VAULT_WRITE_TIMEOUT_MS}ms`),
        ),
      VAULT_WRITE_TIMEOUT_MS,
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

export async function fetchHubVault(
  vaultId: string,
): Promise<HubVaultPublicState | null> {
  if (!hubVaultReady()) {
    throw new Error(
      "GitAtlas vault WASM not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const id = normalizeVaultId(vaultId);
  if (id.length !== 64) {
    throw new Error("vault id must be 64 hex characters");
  }
  const key = hubVaultKeyForId(id);
  if (!key) return null;
  const raw = await tryGetContractState(key);
  if (!raw) return null;
  return parseVaultState(raw);
}

async function loadHubVaultWasm(): Promise<Uint8Array> {
  // Browser (published website): cached relative fetch.
  try {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const resp = await fetch("./hub_vault.wasm");
    // if (resp.ok) {
    //   return new Uint8Array(await resp.arrayBuffer());
    // }
    // NEW CODE - TESTING: wasm-cache
    const { loadPublicWasm } = await import("./wasm-cache");
    return await loadPublicWasm("./hub_vault.wasm");
  } catch {
    /* Node CLI has no document-relative fetch / missing asset */
  }
  // NEW CODE - TESTING: Node / tsx CLI reads packaged WASM from disk
  if (typeof process !== "undefined" && process.versions?.node) {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const fromModule = fileURLToPath(new URL("../../public/hub_vault.wasm", import.meta.url));
    const candidates = [
      fromModule,
      resolve(process.cwd(), "web/public/hub_vault.wasm"),
      resolve(process.cwd(), "public/hub_vault.wasm"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return new Uint8Array(readFileSync(p));
      }
    }
  }
  throw new Error(
    "failed to load hub_vault.wasm (browser: publish site; CLI: run npm run build:owner)",
  );
}

async function putHubVaultState(
  vaultId: string,
  state: HubVaultPublicState,
): Promise<void> {
  const id = normalizeVaultId(vaultId);
  const key = hubVaultKeyForId(id);
  if (!key || !HUB_VAULT_WASM_HASH_B58) {
    throw new Error("could not derive HubVault key");
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./hub_vault.wasm");
  // ...
  // NEW CODE - TESTING
  const wasm = await loadHubVaultWasm();
  const initial = new TextEncoder().encode(JSON.stringify(state));
  const req = buildPutRequest(
    wasm,
    HUB_VAULT_WASM_HASH_B58,
    paramsBytesForVaultId(id),
    initial,
  );
  await withWriteTimeout(putContract(req, key), "HubVault put");
}

async function updateHubVaultState(
  vaultId: string,
  state: HubVaultPublicState,
): Promise<void> {
  const id = normalizeVaultId(vaultId);
  const key = hubVaultKeyForId(id);
  if (!key) throw new Error("could not derive HubVault key");
  const delta = new TextEncoder().encode(JSON.stringify({ upsert: state }));
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, delta), key),
    "HubVault update",
  );
}

/** Subscribe + fetch WASM so this node can host before Update fallback. */
async function primeHubVaultHosting(vaultId: string): Promise<void> {
  const key = hubVaultKeyForId(normalizeVaultId(vaultId));
  if (!key) return;
  try {
    await getContractState(key, {
      priority: "high",
      timeoutMs: 12_000,
      maxAttempts: 2,
      fetchContract: true,
      subscribe: true,
    });
  } catch (err) {
    console.warn(
      "[hub-vault] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function putOrUpdateHubVault(
  vaultId: string,
  state: HubVaultPublicState,
): Promise<void> {
  if (!hubVaultReady() || !HUB_VAULT_WASM_HASH_B58) {
    throw new Error("HubVault constants missing — build owner contracts first");
  }
  const id = normalizeVaultId(vaultId);
  if (!hubVaultKeyForId(id)) throw new Error("could not derive HubVault key");

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Soft GET → Update when present. On this gateway, Update often never returns
  // UpdateResponse/UpdateNotification (stdlib "Request timeout" ~30s) — mint /
  // push / password-change all hung. HubProfile already prefers Put.
  // const existing = await tryGetContractState(key);
  // if (!existing) { await put...; return; }
  // await updateContract(...);
  // NEW CODE - TESTING: always Put with subscribe; Update only as last resort
  try {
    await putHubVaultState(id, state);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-vault] Put failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubVaultHosting(id);
    await updateHubVaultState(id, state);
  }
}
