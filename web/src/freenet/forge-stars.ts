/**
 * ForgeStars singleton contract GET / star / unstar over Freenet WS.
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import {
  FORGE_STARS_PARAMS_UTF8,
  FORGE_STARS_WASM_HASH_B58,
  forgeStarsReady,
} from "./owner-constants";
import { deriveInstanceId } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import {
  nativeGetIdentity,
  nativeSignStar,
  nativeSignUnstar,
} from "./owner-api";
import { putContract, tryGetContractState, updateContract } from "./ws";

export interface StarEntryJson {
  starred_at: string;
  label?: string;
  sig: string;
}

export interface ForgeStarsStateJson {
  schema_version: number;
  by_repo: Record<string, Record<string, StarEntryJson>>;
}

function paramsBytes(): Uint8Array {
  return new TextEncoder().encode(FORGE_STARS_PARAMS_UTF8);
}

export function forgeStarsKey(): ContractKey | null {
  if (!FORGE_STARS_WASM_HASH_B58) return null;
  const params = paramsBytes();
  const instance = deriveInstanceId(FORGE_STARS_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(FORGE_STARS_WASM_HASH_B58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

function parseState(bytes: Uint8Array): ForgeStarsStateJson {
  if (!bytes.length) {
    return { schema_version: 1, by_repo: {} };
  }
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as ForgeStarsStateJson;
  if (!data.by_repo || typeof data.by_repo !== "object") {
    return { schema_version: 1, by_repo: {} };
  }
  return { schema_version: data.schema_version ?? 1, by_repo: data.by_repo };
}

export async function fetchForgeStars(): Promise<{
  state: ForgeStarsStateJson;
  note?: string;
  source: "contract" | "unavailable";
}> {
  if (!forgeStarsReady()) {
    return {
      state: { schema_version: 1, by_repo: {} },
      note: "ForgeStars WASM not built yet — run scripts/build-forge-owner-tools.sh",
      source: "unavailable",
    };
  }
  const key = forgeStarsKey();
  if (!key) {
    return {
      state: { schema_version: 1, by_repo: {} },
      source: "unavailable",
    };
  }
  const raw = await tryGetContractState(key);
  if (!raw) {
    return {
      state: { schema_version: 1, by_repo: {} },
      note: "ForgeStars not on this node yet (first star publishes).",
      source: "contract",
    };
  }
  return { state: parseState(raw), source: "contract" };
}

export function starCountForRepo(
  state: ForgeStarsStateJson,
  repoPrefix: string,
): number {
  const map = state.by_repo[repoPrefix];
  return map ? Object.keys(map).length : 0;
}

export function isStarredBy(
  state: ForgeStarsStateJson,
  repoPrefix: string,
  fingerprint: string,
): boolean {
  return Boolean(state.by_repo[repoPrefix]?.[fingerprint]);
}

export function reposStarredBy(
  state: ForgeStarsStateJson,
  fingerprint: string,
): Array<{ repo_prefix: string; starred_at: string; label?: string }> {
  const out: Array<{
    repo_prefix: string;
    starred_at: string;
    label?: string;
  }> = [];
  for (const [prefix, map] of Object.entries(state.by_repo)) {
    const entry = map[fingerprint];
    if (entry) {
      out.push({
        repo_prefix: prefix,
        starred_at: entry.starred_at,
        label: entry.label,
      });
    }
  }
  return out.sort((a, b) => b.starred_at.localeCompare(a.starred_at));
}

export async function ensureForgeStarsExists(): Promise<ContractKey> {
  const key = forgeStarsKey();
  if (!key || !FORGE_STARS_WASM_HASH_B58) {
    throw new Error("ForgeStars constants missing — build owner contracts first");
  }
  const existing = await tryGetContractState(key);
  if (existing) return key;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./hub_stars.wasm");
  // if (!resp.ok) {
  //   throw new Error(`failed to fetch hub_stars.wasm: ${resp.status}`);
  // }
  // const wasm = new Uint8Array(await resp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_stars.wasm");
  const initial = new TextEncoder().encode(
    JSON.stringify({ schema_version: 1, by_repo: {} }),
  );
  const req = buildPutRequest(
    wasm,
    FORGE_STARS_WASM_HASH_B58,
    paramsBytes(),
    initial,
  );
  await putContract(req, key);
  return key;
}

export async function starRepo(
  repoPrefix: string,
  label?: string | null,
): Promise<void> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before starring");
  const starred_at = new Date().toISOString();
  const signed = await nativeSignStar({
    repo_prefix: repoPrefix,
    label: label ?? null,
    starred_at,
  });
  const key = await ensureForgeStarsExists();
  const delta = new TextEncoder().encode(
    JSON.stringify({
      star: {
        repo_prefix: signed.repo_prefix,
        fingerprint: signed.fingerprint,
        starred_at: signed.starred_at,
        sig: signed.sig,
        label: signed.label ?? undefined,
      },
    }),
  );
  await updateContract(wrapDeltaUpdate(key, delta), key);
}

export async function unstarRepo(repoPrefix: string): Promise<void> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before unstarring");
  const starred_at = new Date().toISOString();
  const signed = await nativeSignUnstar({
    repo_prefix: repoPrefix,
    starred_at,
  });
  const key = await ensureForgeStarsExists();
  const delta = new TextEncoder().encode(
    JSON.stringify({
      unstar: {
        repo_prefix: signed.repo_prefix,
        fingerprint: signed.fingerprint,
        starred_at: signed.starred_at,
        sig: signed.sig,
      },
    }),
  );
  await updateContract(wrapDeltaUpdate(key, delta), key);
}
