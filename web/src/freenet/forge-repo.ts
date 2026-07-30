/**
 * ForgeRepoMeta — per-prefix settings + public/private channels.
 * Address: gitforge-repo-v1:{repo_prefix}
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import { x25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import bs58 from "bs58";
import {
  FORGE_REPO_PARAMS_PREFIX,
  FORGE_REPO_WASM_HASH_B58,
  forgeRepoReady,
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
  "gitforge.repo-meta.seal-x25519-v1\0",
);
const WRITE_TIMEOUT_MS = 45_000;

export interface ForgeRepoSealedBlobJson {
  alg: string;
  nonce_b64: string;
  blob_b64: string;
}

export interface ForgeRepoChannelMessageJson {
  id: string;
  body_b64?: string | null;
  ciphertext_b64?: string | null;
  created_at: string;
  sender_vk: string;
  sender_sig: string;
  thread_id?: string | null;
}

export interface ForgeRepoMetaStateJson {
  schema_version: number;
  repo_prefix: string;
  repo_owner_vk: string;
  seal_pk: string;
  public_settings: Record<string, string>;
  sealed_settings?: ForgeRepoSealedBlobJson | null;
  channels: {
    public: ForgeRepoChannelMessageJson[];
    private: ForgeRepoChannelMessageJson[];
  };
  identity_fingerprint: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}

export function repoMetaParamsUtf8(prefix: string): string {
  return `${FORGE_REPO_PARAMS_PREFIX}${prefix}`;
}

function paramsBytesForPrefix(prefix: string): Uint8Array {
  return new TextEncoder().encode(repoMetaParamsUtf8(prefix));
}

export function forgeRepoKeyForPrefix(prefix: string): ContractKey | null {
  if (!FORGE_REPO_WASM_HASH_B58 || !prefix) return null;
  const params = paramsBytesForPrefix(prefix);
  const instance = deriveInstanceId(FORGE_REPO_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(FORGE_REPO_WASM_HASH_B58);
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

function parseRepoMetaState(bytes: Uint8Array): ForgeRepoMetaStateJson | null {
  if (!bytes.length) return null;
  const data = JSON.parse(new TextDecoder().decode(bytes)) as ForgeRepoMetaStateJson;
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

export async function fetchForgeRepoMeta(
  prefix: string,
): Promise<ForgeRepoMetaStateJson | null> {
  if (!forgeRepoReady()) return null;
  const key = forgeRepoKeyForPrefix(prefix);
  if (!key) return null;
  const raw = await tryGetContractState(key);
  if (!raw) return null;
  return parseRepoMetaState(raw);
}

/** Re-PUT a previously signed ForgeRepoMeta snapshot (backup rescue). */
export async function restoreForgeRepoMetaSnapshot(
  state: ForgeRepoMetaStateJson,
): Promise<void> {
  await putOrUpdateForgeRepoMeta(state);
}

/** Subscribe + fetch WASM so this node can host before Update fallback. */
async function primeForgeRepoHosting(prefix: string): Promise<void> {
  const key = forgeRepoKeyForPrefix(prefix);
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
      "[forge-repo] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function putOrUpdateForgeRepoMeta(
  state: ForgeRepoMetaStateJson,
): Promise<void> {
  if (!forgeRepoReady() || !FORGE_REPO_WASM_HASH_B58) {
    throw new Error(
      "ForgeRepoMeta WASM not built — run scripts/build-forge-owner-tools.sh",
    );
  }
  const key = forgeRepoKeyForPrefix(state.repo_prefix);
  if (!key) throw new Error("could not derive ForgeRepoMeta key");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Put initial = JSON.stringify({ upsert: state })
  // — validate_state only parses ForgeRepoMetaState, so Put Deser-fails / times out.
  // NEW CODE - TESTING: Put full state (like ForgeProfile); Update uses upsert envelope
  const stateBytes = new TextEncoder().encode(JSON.stringify(state));
  const upsertDelta = new TextEncoder().encode(
    JSON.stringify({ upsert: state }),
  );
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_repo.wasm");
  const req = buildPutRequest(
    wasm,
    FORGE_REPO_WASM_HASH_B58,
    paramsBytesForPrefix(state.repo_prefix),
    stateBytes,
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await withWriteTimeout(putContract(req, key), "ForgeRepoMeta Put");
      return;
    } catch (putErr) {
      lastErr = putErr;
      console.warn(
        `[forge-repo] Put failed (attempt ${attempt}/3):`,
        putErr instanceof Error ? putErr.message : putErr,
      );
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  console.warn(
    "[forge-repo] Put exhausted, trying Update after prime:",
    lastErr instanceof Error ? lastErr.message : lastErr,
  );
  await primeForgeRepoHosting(state.repo_prefix);
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, upsertDelta), key),
    "ForgeRepoMeta Update",
  );
}

/**
 * Ensure ForgeRepoMeta exists with seal_pk provisioned from the site key.
 * Preserves existing channel bags on re-upsert.
 */
export async function ensureForgeRepoMeta(prefix: string): Promise<ForgeRepoMetaStateJson> {
  if (!forgeRepoReady()) {
    throw new Error(
      "ForgeRepoMeta WASM not built — run scripts/build-forge-owner-tools.sh",
    );
  }
  const existing = await fetchForgeRepoMeta(prefix);
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
  const state: ForgeRepoMetaStateJson = {
    ...signed,
    channels: existing?.channels ?? { public: [], private: [] },
  };
  await putOrUpdateForgeRepoMeta(state);
  return state;
}

/**
 * Owner-only: ensure ForgeRepoMeta for a prefix that already has a site key.
 * Does **not** auto-register on GFR unless `allowRegister: true` (explicit
 * Register flows only). Tip/backup/Settings call without that flag — no listing
 * means no ForgeRepoMeta create.
 * Deduped per prefix — safe to call from the global worker and from UI.
 */
const ownerProvisionInflight = new Map<
  string,
  Promise<{
    registration: import("../api").ForgeRegistration | null;
    meta: ForgeRepoMetaStateJson | null;
    createdRegistration: boolean;
    createdMeta: boolean;
  }>
>();

export type OwnerRepoProvisionResult = {
  registration: import("../api").ForgeRegistration | null;
  meta: ForgeRepoMetaStateJson | null;
  createdRegistration: boolean;
  createdMeta: boolean;
};

export function onOwnerRepoProvisioned(
  handler: (detail: {
    prefix: string;
    registration: import("../api").ForgeRegistration | null;
    createdRegistration: boolean;
    createdMeta: boolean;
  }) => void,
): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.prefix) handler(detail);
  };
  window.addEventListener("gitforge-owner-repo-provisioned", fn);
  return () =>
    window.removeEventListener("gitforge-owner-repo-provisioned", fn);
}

export async function ensureOwnerRepoSideContracts(input: {
  prefix: string;
  label: string;
  name?: string | null;
  description?: string | null;
  /** When true, skip ForgeRegistry Put if missing (meta-only). Default behavior. */
  skipRegister?: boolean;
  /** Explicit Register only — list on GFR when missing. */
  allowRegister?: boolean;
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
    let registration: import("../api").ForgeRegistration | null = null;
    try {
      const {
        peekCachedRegistry,
        upsertCachedRegistryEntry,
        isLocallyRemovedRegistryPrefix,
      } = await import("./discover-cache");
      const { fetchForgeRegistry } = await import("./forge-registry");
      registration =
        peekCachedRegistry()?.find((r) => r.repo_prefix === prefix) ?? null;
      if (!registration) {
        const { repos: live } = await fetchForgeRegistry().catch(() => ({
          repos: [] as import("../api").ForgeRegistration[],
        }));
        registration = live.find((r) => r.repo_prefix === prefix) ?? null;
      }
      if (
        !registration &&
        input.allowRegister === true &&
        input.skipRegister !== true &&
        !isLocallyRemovedRegistryPrefix(prefix)
      ) {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // Settings / tip worker auto-listed any owned prefix on ForgeRegistry.
        // NEW CODE - TESTING: only explicit allowRegister registers
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
          "[freenet-forge] registered owner repo on ForgeRegistry",
          prefix.slice(0, 12),
        );
      }
      // No GFR listing → do not create ForgeRepoMeta (Settings is register-gated)
      if (!registration) {
        return {
          registration: null,
          meta: null,
          createdRegistration: false,
          createdMeta: false,
        };
      }
    } catch (e) {
      console.warn(
        "[freenet-forge] ensure ForgeRegistry listing:",
        e instanceof Error ? e.message : e,
      );
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Ensured ForgeRepoMeta even when GFR listing was missing (Settings auto-path).
    // NEW CODE - TESTING: meta only after a live/cached registration
    if (!registration) {
      return {
        registration: null,
        meta: null,
        createdRegistration: false,
        createdMeta: false,
      };
    }

    let createdMeta = false;
    let meta: ForgeRepoMetaStateJson | null = null;
    try {
      const before = await fetchForgeRepoMeta(prefix);
      meta = await ensureForgeRepoMeta(prefix);
      createdMeta = !before?.seal_pk || !before?.repo_owner_vk;
      if (createdMeta) {
        console.info(
          "[freenet-forge] provisioned ForgeRepoMeta for",
          prefix.slice(0, 12),
        );
      }
    } catch (e) {
      console.warn(
        "[freenet-forge] ensure ForgeRepoMeta:",
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
        new CustomEvent("gitforge-owner-repo-provisioned", {
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
        if (createdRegistration) bits.push("GitForge listing");
        if (createdMeta) bits.push("settings contract");
        await notifySelfSystem(SYSTEM_KIND_REPO_CONTRACTS_PROVISIONED, {
          title: "Repository contracts restored",
          detail: `Created missing ${bits.join(" and ")} for ${prefix}.`,
          prefix,
        });
      } catch (err) {
        console.warn("[freenet-forge] provision notify failed", err);
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
 * Background pass: provision missing ForgeRegistry / ForgeRepoMeta for every
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
  if (!forgeRepoReady()) {
    console.warn(
      "[freenet-forge] owner provision pass skipped: ForgeRepoMeta WASM missing",
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
        "[freenet-forge] owner provision",
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
      "[freenet-forge] owner provision pass",
      { checked, createdRegistration, createdMeta },
    );
  }

  return { checked, createdRegistration, createdMeta };
}

/** Prefixes queued for post-tip / idle ForgeRepoMeta ensure (dedupe). */
const tipProvisionPending = new Set<string>();

/**
 * Background: ensure ForgeRegistry + ForgeRepoMeta for one owned prefix.
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
        "[freenet-forge] enqueue owner provision:",
        e instanceof Error ? e.message : e,
      );
    } finally {
      tipProvisionPending.delete(p);
    }
  })();
}

let tipProvisionListenerInstalled = false;

/** Install once — tip pushes also kick ForgeRepoMeta ensure (not page-gated). */
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
export async function upsertForgeRepoMeta(input: {
  prefix: string;
  public_settings?: Record<string, string>;
  sealed_settings?: ForgeRepoSealedBlobJson | null;
  seal_pk?: string;
  /** When set, replaces channel bags (owner prune). Otherwise preserves. */
  channels?: ForgeRepoMetaStateJson["channels"];
}): Promise<ForgeRepoMetaStateJson> {
  const existing = await fetchForgeRepoMeta(input.prefix);
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
  const state: ForgeRepoMetaStateJson = {
    ...signed,
    channels:
      input.channels ?? existing?.channels ?? { public: [], private: [] },
  };
  await putOrUpdateForgeRepoMeta(state);
  return state;
}
