/**
 * HubRepoMeta — per-prefix settings + public/private channels.
 * Address: gitatlas-repo-v1:{repo_prefix}
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import { x25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import bs58 from "bs58";
import {
  HUB_REPO_PARAMS_PREFIX,
  HUB_REPO_WASM_HASH_B58,
  hubRepoReady,
} from "./owner-constants";
import { deriveInstanceId } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import {
  putContract,
  tryGetContractState,
  updateContract,
  getContractState,
} from "./ws";

const REPO_SEAL_DOMAIN = new TextEncoder().encode(
  "gitatlas.repo-meta.seal-x25519-v1\0",
);
const WRITE_TIMEOUT_MS = 45_000;

export interface HubRepoSealedBlobJson {
  alg: string;
  nonce_b64: string;
  blob_b64: string;
}

export interface HubRepoChannelMessageJson {
  id: string;
  body_b64?: string | null;
  ciphertext_b64?: string | null;
  created_at: string;
  sender_vk: string;
  sender_sig: string;
  thread_id?: string | null;
}

export interface HubRepoMetaStateJson {
  schema_version: number;
  repo_prefix: string;
  repo_owner_vk: string;
  seal_pk: string;
  public_settings: Record<string, string>;
  sealed_settings?: HubRepoSealedBlobJson | null;
  channels: {
    public: HubRepoChannelMessageJson[];
    private: HubRepoChannelMessageJson[];
  };
  identity_fingerprint: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}

export function repoMetaParamsUtf8(prefix: string): string {
  return `${HUB_REPO_PARAMS_PREFIX}${prefix}`;
}

function paramsBytesForPrefix(prefix: string): Uint8Array {
  return new TextEncoder().encode(repoMetaParamsUtf8(prefix));
}

export function hubRepoKeyForPrefix(prefix: string): ContractKey | null {
  if (!HUB_REPO_WASM_HASH_B58 || !prefix) return null;
  const params = paramsBytesForPrefix(prefix);
  const instance = deriveInstanceId(HUB_REPO_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(HUB_REPO_WASM_HASH_B58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

/** Derive X25519 seal secret from the repo site-key seed (deterministic). */
export function repoSealSkFromSiteSecretHex(secretHex: string): Uint8Array {
  const seed = hexToBytes(secretHex.trim().toLowerCase().replace(/^0x/, ""));
  if (seed.length !== 32) throw new Error("site secret must be 32 bytes");
  const concat = new Uint8Array(REPO_SEAL_DOMAIN.length + seed.length);
  concat.set(REPO_SEAL_DOMAIN, 0);
  concat.set(seed, REPO_SEAL_DOMAIN.length);
  return blake3(concat);
}

export function repoSealPkHexFromSiteSecretHex(secretHex: string): string {
  const sk = repoSealSkFromSiteSecretHex(secretHex);
  return bytesToHex(x25519.getPublicKey(sk));
}

function parseRepoMetaState(bytes: Uint8Array): HubRepoMetaStateJson | null {
  if (!bytes.length) return null;
  const data = JSON.parse(new TextDecoder().decode(bytes)) as HubRepoMetaStateJson;
  if (!data?.repo_prefix || typeof data.seq !== "number") return null;
  return {
    schema_version: data.schema_version ?? 1,
    repo_prefix: data.repo_prefix,
    repo_owner_vk: data.repo_owner_vk ?? "",
    seal_pk: data.seal_pk ?? "",
    public_settings: data.public_settings ?? {},
    sealed_settings: data.sealed_settings ?? null,
    channels: {
      public: Array.isArray(data.channels?.public) ? data.channels.public : [],
      private: Array.isArray(data.channels?.private)
        ? data.channels.private
        : [],
    },
    identity_fingerprint: data.identity_fingerprint ?? "",
    attestation: data.attestation ?? "",
    identity_sig: data.identity_sig ?? "",
    repo_owner_sig: data.repo_owner_sig ?? "",
    seq: data.seq,
    updated_at: data.updated_at ?? "",
  };
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${WRITE_TIMEOUT_MS}ms`)),
      WRITE_TIMEOUT_MS,
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

export async function fetchHubRepoMeta(
  prefix: string,
): Promise<HubRepoMetaStateJson | null> {
  if (!hubRepoReady()) return null;
  const key = hubRepoKeyForPrefix(prefix);
  if (!key) return null;
  const raw = await tryGetContractState(key);
  if (!raw) return null;
  return parseRepoMetaState(raw);
}

/** Re-PUT a previously signed HubRepoMeta snapshot (backup rescue). */
export async function restoreHubRepoMetaSnapshot(
  state: HubRepoMetaStateJson,
): Promise<void> {
  await putOrUpdateHubRepoMeta(state);
}

/** Subscribe + fetch WASM so this node can host before Update fallback. */
async function primeHubRepoHosting(prefix: string): Promise<void> {
  const key = hubRepoKeyForPrefix(prefix);
  if (!key) return;
  try {
    await getContractState(key, {
      priority: "high",
      timeoutMs: 12_000,
      maxAttempts: 2,
      fetchContract: true,
      subscribe: true,
      scope: prefix,
    });
  } catch (err) {
    console.warn(
      "[hub-repo] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function putOrUpdateHubRepoMeta(
  state: HubRepoMetaStateJson,
): Promise<void> {
  if (!hubRepoReady() || !HUB_REPO_WASM_HASH_B58) {
    throw new Error(
      "HubRepoMeta WASM not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const key = hubRepoKeyForPrefix(state.repo_prefix);
  if (!key) throw new Error("could not derive HubRepoMeta key");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Put initial = JSON.stringify({ upsert: state })
  // — validate_state only parses HubRepoMetaState, so Put Deser-fails / times out.
  // NEW CODE - TESTING: Put full state (like HubProfile); Update uses upsert envelope
  const stateBytes = new TextEncoder().encode(JSON.stringify(state));
  const upsertDelta = new TextEncoder().encode(
    JSON.stringify({ upsert: state }),
  );
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_repo.wasm");
  const req = buildPutRequest(
    wasm,
    HUB_REPO_WASM_HASH_B58,
    paramsBytesForPrefix(state.repo_prefix),
    stateBytes,
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await withWriteTimeout(putContract(req, key), "HubRepoMeta Put");
      return;
    } catch (putErr) {
      lastErr = putErr;
      console.warn(
        `[hub-repo] Put failed (attempt ${attempt}/3):`,
        putErr instanceof Error ? putErr.message : putErr,
      );
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  console.warn(
    "[hub-repo] Put exhausted, trying Update after prime:",
    lastErr instanceof Error ? lastErr.message : lastErr,
  );
  await primeHubRepoHosting(state.repo_prefix);
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, upsertDelta), key),
    "HubRepoMeta Update",
  );
}

/**
 * Ensure HubRepoMeta exists with seal_pk provisioned from the site key.
 * Preserves existing channel bags on re-upsert.
 */
export async function ensureHubRepoMeta(prefix: string): Promise<HubRepoMetaStateJson> {
  if (!hubRepoReady()) {
    throw new Error(
      "HubRepoMeta WASM not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const existing = await fetchHubRepoMeta(prefix);
  if (existing?.seal_pk && existing.repo_owner_vk) {
    return existing;
  }

  const repos = await (await import("./owner-api")).nativeExportRepos();
  const row = repos.find((r) => r.prefix === prefix);
  if (!row?.secret_hex) {
    throw new Error(`site key for ${prefix} not on this identity`);
  }
  const seal_pk = repoSealPkHexFromSiteSecretHex(row.secret_hex);
  const seq = (existing?.seq ?? 0) + 1;
  const updated_at = new Date().toISOString();
  const signed = await (
    await import("./owner-api")
  ).nativeSignRepoMetaUpsert({
    prefix,
    seal_pk,
    public_settings: existing?.public_settings ?? {},
    sealed_settings: existing?.sealed_settings ?? null,
    seq,
    updated_at,
  });
  const state: HubRepoMetaStateJson = {
    ...signed,
    channels: existing?.channels ?? { public: [], private: [] },
  };
  await putOrUpdateHubRepoMeta(state);
  return state;
}

/**
 * Owner-only: for repos created before HubRegistry / HubRepoMeta existed,
 * register the listing (if missing) and provision HubRepoMeta + seal_pk.
 * No-op when the site key is not on this identity.
 * Deduped per prefix — safe to call from the global worker and from UI.
 */
const ownerProvisionInflight = new Map<
  string,
  Promise<{
    registration: import("../api").HubRegistration | null;
    meta: HubRepoMetaStateJson | null;
    createdRegistration: boolean;
    createdMeta: boolean;
  }>
>();

export type OwnerRepoProvisionResult = {
  registration: import("../api").HubRegistration | null;
  meta: HubRepoMetaStateJson | null;
  createdRegistration: boolean;
  createdMeta: boolean;
};

export function onOwnerRepoProvisioned(
  handler: (detail: {
    prefix: string;
    registration: import("../api").HubRegistration | null;
    createdRegistration: boolean;
    createdMeta: boolean;
  }) => void,
): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.prefix) handler(detail);
  };
  window.addEventListener("freenethub-owner-repo-provisioned", fn);
  return () =>
    window.removeEventListener("freenethub-owner-repo-provisioned", fn);
}

export async function ensureOwnerRepoSideContracts(input: {
  prefix: string;
  label: string;
  name?: string | null;
  description?: string | null;
  /** When true, skip HubRegistry Put if missing (meta-only). */
  skipRegister?: boolean;
}): Promise<OwnerRepoProvisionResult> {
  const prefix = input.prefix.trim();
  const empty: OwnerRepoProvisionResult = {
    registration: null,
    meta: null,
    createdRegistration: false,
    createdMeta: false,
  };
  if (!prefix) return empty;

  const existing = ownerProvisionInflight.get(prefix);
  if (existing) return existing;

  const job = (async (): Promise<OwnerRepoProvisionResult> => {
    const { nativeExportRepos, nativeRegisterRepo } = await import(
      "./owner-api"
    );
    const repos = await nativeExportRepos();
    const row = repos.find((r) => r.prefix === prefix);
    if (!row?.secret_hex) return empty;

    let createdRegistration = false;
    let registration: import("../api").HubRegistration | null = null;
    try {
      const {
        peekCachedRegistry,
        upsertCachedRegistryEntry,
        isLocallyRemovedRegistryPrefix,
      } = await import("./discover-cache");
      const { fetchHubRegistry } = await import("./hub-registry");
      registration =
        peekCachedRegistry()?.find((r) => r.repo_prefix === prefix) ?? null;
      if (!registration) {
        const { repos: live } = await fetchHubRegistry().catch(() => ({
          repos: [] as import("../api").HubRegistration[],
        }));
        registration = live.find((r) => r.repo_prefix === prefix) ?? null;
      }
      if (
        !registration &&
        !input.skipRegister &&
        !isLocallyRemovedRegistryPrefix(prefix)
      ) {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // Settings stayed "Register first" for pre-registry repos forever.
        // NEW CODE - TESTING: owner with site key auto-lists on HubRegistry
        registration = await nativeRegisterRepo({
          prefix,
          label: (input.label || row.label || prefix).trim() || prefix,
          name: input.name?.trim() || row.label || undefined,
          description: input.description?.trim() || undefined,
        });
        createdRegistration = true;
        try {
          upsertCachedRegistryEntry(registration);
        } catch {
          /* optional */
        }
        console.info(
          "[freenet-hub] auto-registered owner repo on HubRegistry",
          prefix.slice(0, 12),
        );
      }
    } catch (e) {
      console.warn(
        "[freenet-hub] ensure HubRegistry listing:",
        e instanceof Error ? e.message : e,
      );
    }

    let createdMeta = false;
    let meta: HubRepoMetaStateJson | null = null;
    try {
      const before = await fetchHubRepoMeta(prefix);
      meta = await ensureHubRepoMeta(prefix);
      createdMeta = !before?.seal_pk || !before?.repo_owner_vk;
      if (createdMeta) {
        console.info(
          "[freenet-hub] provisioned HubRepoMeta for",
          prefix.slice(0, 12),
        );
      }
    } catch (e) {
      console.warn(
        "[freenet-hub] ensure HubRepoMeta:",
        e instanceof Error ? e.message : e,
      );
    }

    const result: OwnerRepoProvisionResult = {
      registration,
      meta,
      createdRegistration,
      createdMeta,
    };
    try {
      window.dispatchEvent(
        new CustomEvent("freenethub-owner-repo-provisioned", {
          detail: {
            prefix,
            registration,
            createdRegistration,
            createdMeta,
          },
        }),
      );
    } catch {
      /* optional */
    }
    // NEW CODE - TESTING: tip/worker single-prefix path never hit the bulk notify
    if (createdRegistration || createdMeta) {
      try {
        const {
          notifySelfSystem,
          SYSTEM_KIND_REPO_CONTRACTS_PROVISIONED,
        } = await import("./system-notify");
        const bits: string[] = [];
        if (createdRegistration) bits.push("GitAtlas listing");
        if (createdMeta) bits.push("settings contract");
        await notifySelfSystem(SYSTEM_KIND_REPO_CONTRACTS_PROVISIONED, {
          title: "Repository contracts restored",
          detail: `Created missing ${bits.join(" and ")} for ${prefix}.`,
          prefix,
        });
      } catch (err) {
        console.warn("[freenet-hub] provision notify failed", err);
      }
    }
    return result;
  })().finally(() => {
    ownerProvisionInflight.delete(prefix);
  });

  ownerProvisionInflight.set(prefix, job);
  return job;
}

/**
 * Background pass: provision missing HubRegistry / HubRepoMeta for every
 * site key on this identity. Survives SPA navigation (module-level work).
 */
export async function runOwnerReposProvisionPass(opts?: {
  signal?: AbortSignal;
  gapMs?: number;
  onItem?: (prefix: string, note: string) => void;
}): Promise<{
  checked: number;
  createdRegistration: number;
  createdMeta: number;
}> {
  const { getCachedIdentity } = await import("./auth-api");
  if (!getCachedIdentity()) {
    return { checked: 0, createdRegistration: 0, createdMeta: 0 };
  }
  if (!hubRepoReady()) {
    console.warn(
      "[freenet-hub] owner provision pass skipped: HubRepoMeta WASM missing",
    );
    return { checked: 0, createdRegistration: 0, createdMeta: 0 };
  }

  const { nativeExportRepos } = await import("./owner-api");
  const repos = await nativeExportRepos();
  const gapMs = opts?.gapMs ?? 1_200;
  let createdRegistration = 0;
  let createdMeta = 0;
  let checked = 0;

  for (let i = 0; i < repos.length; i++) {
    if (opts?.signal?.aborted) break;
    const row = repos[i]!;
    if (!row.prefix || !row.secret_hex) continue;
    checked += 1;
    opts?.onItem?.(row.prefix, `Checking contracts for ${row.label || row.prefix}…`);
    try {
      const result = await ensureOwnerRepoSideContracts({
        prefix: row.prefix,
        label: row.label || row.prefix,
      });
      if (result.createdRegistration) createdRegistration += 1;
      if (result.createdMeta) createdMeta += 1;
    } catch (e) {
      console.warn(
        "[freenet-hub] owner provision",
        row.prefix.slice(0, 12),
        e instanceof Error ? e.message : e,
      );
    }
    if (i + 1 < repos.length && gapMs > 0) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  if (createdRegistration > 0 || createdMeta > 0) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // await notifySelfSystem(...) summary here — duplicated once ensureOwner
    // started notifying per prefix; skip bulk summary.
    console.info(
      "[freenet-hub] owner provision pass",
      { checked, createdRegistration, createdMeta },
    );
  }

  return { checked, createdRegistration, createdMeta };
}

/** Prefixes queued for post-tip / idle HubRepoMeta ensure (dedupe). */
const tipProvisionPending = new Set<string>();

/**
 * Background: ensure HubRegistry + HubRepoMeta for one owned prefix.
 * Delayed so tip paint / backup don't share the write lock immediately.
 */
export function enqueueOwnerRepoProvision(prefix: string, label?: string): void {
  const p = prefix.trim();
  if (!p || tipProvisionPending.has(p)) return;
  tipProvisionPending.add(p);
  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, 3_500));
      await ensureOwnerRepoSideContracts({
        prefix: p,
        label: (label || p).trim() || p,
      });
    } catch (e) {
      console.warn(
        "[freenet-hub] enqueue owner provision:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      tipProvisionPending.delete(p);
    }
  })();
}

let tipProvisionListenerInstalled = false;

/** Install once — tip pushes also kick HubRepoMeta ensure (not page-gated). */
export function ensureOwnerProvisionTipListener(): void {
  if (tipProvisionListenerInstalled) return;
  tipProvisionListenerInstalled = true;
  void import("./tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
    onRepoTipPushed((prefix) => {
      enqueueOwnerRepoProvision(prefix);
    });
  });
}

/** Owner upsert of public_settings (and optional sealed_settings / seal_pk). */
export async function upsertHubRepoMeta(input: {
  prefix: string;
  public_settings?: Record<string, string>;
  sealed_settings?: HubRepoSealedBlobJson | null;
  seal_pk?: string;
  /** When set, replaces channel bags (owner prune). Otherwise preserves. */
  channels?: HubRepoMetaStateJson["channels"];
}): Promise<HubRepoMetaStateJson> {
  const existing = await fetchHubRepoMeta(input.prefix);
  let seal_pk = input.seal_pk ?? existing?.seal_pk ?? "";
  if (!seal_pk) {
    const repos = await (await import("./owner-api")).nativeExportRepos();
    const row = repos.find((r) => r.prefix === input.prefix);
    if (!row?.secret_hex) {
      throw new Error(`site key for ${input.prefix} not on this identity`);
    }
    seal_pk = repoSealPkHexFromSiteSecretHex(row.secret_hex);
  }
  const seq = (existing?.seq ?? 0) + 1;
  const updated_at = new Date().toISOString();
  const signed = await (
    await import("./owner-api")
  ).nativeSignRepoMetaUpsert({
    prefix: input.prefix,
    seal_pk,
    public_settings: input.public_settings ?? existing?.public_settings ?? {},
    sealed_settings:
      input.sealed_settings !== undefined
        ? input.sealed_settings
        : (existing?.sealed_settings ?? null),
    seq,
    updated_at,
  });
  const state: HubRepoMetaStateJson = {
    ...signed,
    channels:
      input.channels ?? existing?.channels ?? { public: [], private: [] },
  };
  await putOrUpdateHubRepoMeta(state);
  return state;
}
