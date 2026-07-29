/**
 * HubRegistry contract GET / upsert over Freenet WS.
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import type { HubRegistration } from "../api";
import {
  HUB_REGISTRY_PARAMS_UTF8,
  HUB_REGISTRY_WASM_HASH_B58,
  hubOwnerContractsReady,
} from "./owner-constants";
import { deriveInstanceId } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import {
  getContractState,
  putContract,
  tryGetContractState,
  updateContract,
} from "./ws";

/** Same hang as HubVault/HubProfile — Update often never ACKs on this gateway. */
const REGISTRY_WRITE_TIMEOUT_MS = 45_000;

export interface HubRegistryRemoveOp {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}

/** Dual-signed contributor grant on HubRegistry. */
export interface HubRegistryContributorOp {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}

/** Pending collaborator invite on HubRegistry (repo-level). */
export interface HubRegistryPendingInviteOp {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig?: string;
  seq: number;
  updated_at: string;
}

export interface HubRegistryStateJson {
  schema_version: number;
  repos: Record<string, HubRegistration>;
  /** Soft-unregister tombstones (optional on older states). */
  removed?: Record<string, HubRegistryRemoveOp>;
  /** Accepted contributors: prefix → fingerprint → grant */
  contributors?: Record<string, Record<string, HubRegistryContributorOp>>;
  /** Outstanding invites: prefix → invitee fingerprint → invite */
  pending_invites?: Record<string, Record<string, HubRegistryPendingInviteOp>>;
}

function paramsBytes(): Uint8Array {
  return new TextEncoder().encode(HUB_REGISTRY_PARAMS_UTF8);
}

export function hubRegistryKey(): ContractKey | null {
  if (!HUB_REGISTRY_WASM_HASH_B58) return null;
  const params = paramsBytes();
  const instance = deriveInstanceId(HUB_REGISTRY_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(HUB_REGISTRY_WASM_HASH_B58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

function parseState(bytes: Uint8Array): HubRegistryStateJson {
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as HubRegistryStateJson;
  if (!data.repos || typeof data.repos !== "object") {
    return { schema_version: 1, repos: {} };
  }
  return {
    schema_version: data.schema_version ?? 1,
    repos: data.repos,
    removed: data.removed,
    contributors: data.contributors,
    pending_invites: data.pending_invites,
  };
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${REGISTRY_WRITE_TIMEOUT_MS}ms`),
        ),
      REGISTRY_WRITE_TIMEOUT_MS,
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

export async function fetchHubRegistry(): Promise<{
  repos: HubRegistration[];
  contributors: Record<string, Record<string, HubRegistryContributorOp>>;
  pending_invites: Record<string, Record<string, HubRegistryPendingInviteOp>>;
  note?: string;
  source: "contract" | "unavailable";
}> {
  if (!hubOwnerContractsReady()) {
    return {
      repos: [],
      contributors: {},
      pending_invites: {},
      note: "HubRegistry WASM not built yet — run scripts/build-hub-owner-tools.sh",
      source: "unavailable",
    };
  }
  const key = hubRegistryKey();
  if (!key) {
    return {
      repos: [],
      contributors: {},
      pending_invites: {},
      source: "unavailable",
    };
  }
  const raw = await tryGetContractState(key);
  if (!raw) {
    return {
      repos: [],
      contributors: {},
      pending_invites: {},
      note: "HubRegistry not on this node yet (publish or first Register).",
      source: "contract",
    };
  }
  const state = parseState(raw);
  const repos = Object.values(state.repos).sort((a, b) =>
    a.repo_prefix.localeCompare(b.repo_prefix),
  );
  return {
    repos,
    contributors: state.contributors ?? {},
    pending_invites: state.pending_invites ?? {},
    source: "contract",
  };
}

export async function ensureHubRegistryExists(): Promise<ContractKey> {
  const key = hubRegistryKey();
  if (!key || !HUB_REGISTRY_WASM_HASH_B58) {
    throw new Error("HubRegistry constants missing — build owner contracts first");
  }
  const existing = await tryGetContractState(key);
  if (existing) return key;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./hub_registry.wasm");
  // if (!resp.ok) {
  //   throw new Error(`failed to fetch hub_registry.wasm: ${resp.status}`);
  // }
  // const wasm = new Uint8Array(await resp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_registry.wasm");
  const initial = new TextEncoder().encode(
    JSON.stringify({ schema_version: 1, repos: {} }),
  );
  const req = buildPutRequest(
    wasm,
    HUB_REGISTRY_WASM_HASH_B58,
    paramsBytes(),
    initial,
  );
  await putContract(req, key);
  return key;
}

/** Subscribe + fetch WASM so this node can host before Update fallback. */
async function primeHubRegistryHosting(): Promise<void> {
  const key = hubRegistryKey();
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
      "[hub-registry] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function putHubRegistryPartialState(
  state: HubRegistryStateJson,
): Promise<void> {
  const key = hubRegistryKey();
  if (!key || !HUB_REGISTRY_WASM_HASH_B58) {
    throw new Error("HubRegistry constants missing — build owner contracts first");
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./hub_registry.wasm");
  // if (!resp.ok) {
  //   throw new Error(`failed to fetch hub_registry.wasm: ${resp.status}`);
  // }
  // const wasm = new Uint8Array(await resp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_registry.wasm");
  const initial = new TextEncoder().encode(JSON.stringify(state));
  const req = buildPutRequest(
    wasm,
    HUB_REGISTRY_WASM_HASH_B58,
    paramsBytes(),
    initial,
  );
  await withWriteTimeout(putContract(req, key), "HubRegistry put");
}

async function updateHubRegistryDelta(deltaObj: unknown): Promise<void> {
  const key = await ensureHubRegistryExists();
  const delta = new TextEncoder().encode(JSON.stringify(deltaObj));
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, delta), key),
    "HubRegistry update",
  );
}

export async function upsertHubRegistryEntry(
  entry: HubRegistration,
): Promise<void> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const key = await ensureHubRegistryExists();
  // const delta = … { upsert: entry };
  // await updateContract(…); // hangs: stdlib "Request timeout" (~30s)
  // NEW CODE - TESTING: Put (merge) first like HubProfile/HubVault; Update last
  const partial: HubRegistryStateJson = {
    schema_version: 1,
    repos: { [entry.repo_prefix]: entry },
  };
  try {
    await putHubRegistryPartialState(partial);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-registry] Put failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubRegistryHosting();
    await updateHubRegistryDelta({ upsert: entry });
  }
}

/** Soft-unregister: drop from Discover; tombstone prevents stale resurrect. */
export async function removeHubRegistryEntry(
  op: HubRegistryRemoveOp,
): Promise<void> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await updateContract({ remove: op });
  // NEW CODE - TESTING: Put merge with removed map; Update fallback
  const partial: HubRegistryStateJson = {
    schema_version: 1,
    repos: {},
    removed: { [op.repo_prefix]: op },
  };
  try {
    await putHubRegistryPartialState(partial);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-registry] Put remove failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubRegistryHosting();
    await updateHubRegistryDelta({ remove: op });
  }
}

/** Write verified contributor grant (invite accept). */
export async function addHubRegistryContributor(
  entry: HubRegistryContributorOp,
): Promise<void> {
  const partial: HubRegistryStateJson = {
    schema_version: 1,
    repos: {},
    contributors: {
      [entry.repo_prefix]: { [entry.identity_fingerprint]: entry },
    },
  };
  try {
    await putHubRegistryPartialState(partial);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-registry] Put add_contributor failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubRegistryHosting();
    await updateHubRegistryDelta({ add_contributor: entry });
  }
}

/** Remove contributor grant (self-leave or owner revoke). */
export async function removeHubRegistryContributor(
  entry: HubRegistryContributorOp,
): Promise<void> {
  await primeHubRegistryHosting();
  await updateHubRegistryDelta({ remove_contributor: entry });
}

/** Write pending collaborator invite (owner send). */
export async function addHubRegistryPendingInvite(
  entry: HubRegistryPendingInviteOp,
): Promise<void> {
  const partial: HubRegistryStateJson = {
    schema_version: 1,
    repos: {},
    pending_invites: {
      [entry.repo_prefix]: { [entry.identity_fingerprint]: entry },
    },
  };
  try {
    await putHubRegistryPartialState(partial);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-registry] Put add_pending_invite failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubRegistryHosting();
    await updateHubRegistryDelta({ add_pending_invite: entry });
  }
}

/** Remove pending invite (owner cancel or invitee decline). */
export async function removeHubRegistryPendingInvite(
  entry: HubRegistryPendingInviteOp,
): Promise<void> {
  await primeHubRegistryHosting();
  await updateHubRegistryDelta({ remove_pending_invite: entry });
}
