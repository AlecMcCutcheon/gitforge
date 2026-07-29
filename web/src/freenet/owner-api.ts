/**
 * Native owner tools: identity delegate + HubRegistry Update + empty repo Put.
 */
import { REPO_WASM_HASH_B58 } from "./constants";
import {
  HUB_IDENTITY_CODE_HASH_BYTES,
  HUB_IDENTITY_KEY_BYTES,
  hubOwnerContractsReady,
} from "./owner-constants";
import { sendDelegateMessage } from "./delegate-api";
import {
  addHubRegistryContributor,
  addHubRegistryPendingInvite,
  removeHubRegistryContributor,
  removeHubRegistryEntry,
  removeHubRegistryPendingInvite,
  upsertHubRegistryEntry,
  type HubRegistryContributorOp,
  type HubRegistryPendingInviteOp,
} from "./hub-registry";

/** Owner-issued invite coupon (sealed with site key secret). */
export interface ContributorInviteCoupon {
  schema_version: number;
  repo_prefix: string;
  identity_fingerprint: string;
  repo_owner_vk: string;
  attestation: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}
import { repoContractKey, encodeRepoParams } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import { clearRepoStateCache, fetchRepoState } from "./tip-fetch";
import { loadPublicWasm } from "./wasm-cache";
import {
  getContractState,
  getFreenetApi,
  onDelegatePayloads,
  onFreenetConnDrop,
  onFreenetHostError,
  putContract,
  updateContract,
} from "./ws";
import type { HubRegistration } from "../api";

const RENAME_WRITE_TIMEOUT_MS = 45_000;

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${RENAME_WRITE_TIMEOUT_MS}ms`),
        ),
      RENAME_WRITE_TIMEOUT_MS,
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

function hexDecode(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

export interface HubIdentityInfo {
  fingerprint: string;
  name: string;
  email: string;
  public_key_b58: string;
}

export interface CreatedRepoResult {
  prefix: string;
  label: string;
  url: string;
}

function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isNoIdentityError(p: { type?: string; message?: string }): boolean {
  return (
    p.type === "Error" &&
    typeof p.message === "string" &&
    /no identity/i.test(p.message)
  );
}

/**
 * Wait for a matching delegate payload. Does not treat unrelated Errors as
 * failures (concurrent GetIdentity / Sign* share the same WS fan-out).
 * Rejects early if the Freenet command WS drops (common under __sandbox=1).
 * Rejects on HostError (e.g. delegate origin rejection) instead of hanging.
 */
function waitForDelegate<T extends { type?: string; nonce?: string; message?: string }>(
  match: (p: T) => boolean,
  timeoutMs = 30_000,
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
    const timer = setTimeout(() => {
      finish(() => reject(new Error("delegate response timeout")));
    }, timeoutMs);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const unsub = onDelegatePayloads(...); // no WS drop / host error
    // NEW CODE - TESTING
    const unsubDrop = onFreenetConnDrop((err) => {
      finish(() => reject(err));
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

async function withDelegate(): Promise<{
  api: Awaited<ReturnType<typeof getFreenetApi>>;
  key: number[];
  codeHash: number[];
}> {
  if (!hubOwnerContractsReady()) {
    throw new Error(
      "Owner contracts not built — run scripts/build-hub-owner-tools.sh and republish the Hub website",
    );
  }
  const api = await getFreenetApi();
  return {
    api,
    key: HUB_IDENTITY_KEY_BYTES,
    codeHash: HUB_IDENTITY_CODE_HASH_BYTES,
  };
}

export async function nativeGetIdentity(): Promise<HubIdentityInfo | null> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<
    HubIdentityInfo & { type: string; message?: string }
  >(
    (p) => p.type === "Identity" || isNoIdentityError(p),
    12_000,
  );
  await sendDelegateMessage(api, key, codeHash, { type: "GetIdentity" });
  try {
    const id = await pending;
    if (id.type === "Error" || isNoIdentityError(id)) return null;
    return {
      fingerprint: id.fingerprint,
      name: id.name,
      email: id.email,
      public_key_b58: id.public_key_b58,
    };
  } catch (err) {
    // Propagate transport failures so callers keep a session cache.
    if (
      err instanceof Error &&
      /timeout|Connection closed|1006|WebSocket|network/i.test(err.message)
    ) {
      throw err;
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function nativeCreateIdentity(
  name: string,
  email: string,
): Promise<HubIdentityInfo> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<HubIdentityInfo & { type: string }>(
    (p) => p.type === "Identity",
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "CreateIdentity",
    name,
    email,
  });
  const id = await pending;
  return {
    fingerprint: id.fingerprint,
    name: id.name,
    email: id.email,
    public_key_b58: id.public_key_b58,
  };
}

export async function nativeListRepos(): Promise<
  Array<{ prefix: string; label: string }>
> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    repos: Array<{ prefix: string; label: string }>;
    message?: string;
  }>((p) => p.type === "RepoList" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, { type: "ListRepos" });
  const res = await pending;
  return res.repos ?? [];
}

export async function nativeRegisterRepo(input: {
  prefix: string;
  label: string;
  name?: string;
  description?: string;
  website?: string | null;
  topics?: string[];
  public_meta?: Record<string, string>;
}): Promise<HubRegistration> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry: HubRegistration;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRegister" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRegister",
    nonce: n,
    prefix: input.prefix,
    label: input.label,
    name: input.name ?? null,
    description: input.description ?? null,
    // NEW CODE - TESTING
    website: input.website?.trim() || null,
    topics: input.topics ?? [],
    public_meta_json: JSON.stringify(input.public_meta ?? {}),
    seq: Date.now(),
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "register sign failed");
  }
  await upsertHubRegistryEntry(signed.entry);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Callers invalidated the whole registry cache after register (race on navigate).
  // NEW CODE - TESTING: seed warm cache so repo page sees Registered immediately
  try {
    const { upsertCachedRegistryEntry } = await import("./discover-cache");
    upsertCachedRegistryEntry(signed.entry);
  } catch {
    /* optional */
  }
  // NEW CODE - TESTING: provision HubRepoMeta + seal_pk on register
  try {
    const { ensureHubRepoMeta } = await import("./hub-repo");
    await ensureHubRepoMeta(input.prefix);
  } catch (e) {
    console.warn("[owner] register ok; HubRepoMeta ensure skipped:", e);
  }
  return signed.entry;
}

/** Soft-unregister from HubRegistry Discover (owner dual-sig). */
export async function nativeUnregisterRepo(input: {
  prefix: string;
  /** Must be greater than the live listing seq when present. */
  seq?: number;
}): Promise<void> {
  // NEW CODE - TESTING: Pages must come down before leaving Discover
  try {
    const { ensurePagesTakenDown } = await import("./native-pages");
    await ensurePagesTakenDown(input.prefix);
  } catch (err) {
    throw new Error(
      `Cannot unregister while Pages cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }. Disable Pages in Settings first, then try again.`,
    );
  }

  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    op: {
      schema_version: number;
      repo_prefix: string;
      identity_fingerprint: string;
      repo_owner_vk: string;
      attestation: string;
      identity_sig: string;
      repo_owner_sig: string;
      seq: number;
      updated_at: string;
    };
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedUnregister" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignUnregister",
    nonce: n,
    prefix: input.prefix,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error") {
    throw new Error(signed.message ?? "unregister failed");
  }
  await removeHubRegistryEntry(signed.op);
}

/** Dual-sign + write HubRegistry contributor grant (after site-key import). */
export async function nativeAddContributor(input: {
  prefix: string;
  seq?: number;
}): Promise<HubRegistryContributorOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry: HubRegistryContributorOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedContributorAdd" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignContributorAdd",
    nonce: n,
    prefix: input.prefix,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "contributor sign failed");
  }
  await addHubRegistryContributor(signed.entry);
  return signed.entry;
}

/** Owner: site-key-sign invite coupon for a fixed invitee fingerprint. */
export async function nativeSignContributorInvite(input: {
  prefix: string;
  inviteeFingerprint: string;
  seq?: number;
}): Promise<ContributorInviteCoupon> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    coupon?: ContributorInviteCoupon;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedContributorInvite" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignContributorInvite",
    nonce: n,
    prefix: input.prefix,
    invitee_fingerprint: input.inviteeFingerprint,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.coupon) {
    throw new Error(signed.message ?? "contributor invite sign failed");
  }
  return signed.coupon;
}

/**
 * Invitee: identity-sign owner coupon + Put HubRegistry grant (before site key).
 */
export async function nativeAcceptContributorCoupon(
  coupon: ContributorInviteCoupon,
): Promise<HubRegistryContributorOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry?: HubRegistryContributorOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedContributorAcceptCoupon" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignContributorAcceptCoupon",
    nonce: n,
    prefix: coupon.repo_prefix,
    invitee_fingerprint: coupon.identity_fingerprint,
    repo_owner_vk: coupon.repo_owner_vk,
    repo_owner_sig: coupon.repo_owner_sig,
    seq: coupon.seq,
    updated_at: coupon.updated_at,
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "contributor coupon accept failed");
  }
  await addHubRegistryContributor(signed.entry);
  return signed.entry;
}

/** Dual-sign + remove HubRegistry contributor grant (self-leave). */
export async function nativeRemoveContributor(input: {
  prefix: string;
  /** Defaults to signed-in identity (self-leave). */
  contributorFingerprint?: string;
  seq?: number;
}): Promise<HubRegistryContributorOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry: HubRegistryContributorOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedContributorRemove" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignContributorRemove",
    nonce: n,
    prefix: input.prefix,
    contributor_fingerprint: input.contributorFingerprint ?? null,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "contributor remove sign failed");
  }
  await removeHubRegistryContributor(signed.entry);
  return signed.entry;
}

/** Owner: dual-sign + Put HubRegistry pending invite. */
export async function nativeAddPendingInvite(input: {
  prefix: string;
  inviteeFingerprint: string;
  seq?: number;
}): Promise<HubRegistryPendingInviteOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry?: HubRegistryPendingInviteOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedPendingInviteAdd" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignPendingInviteAdd",
    nonce: n,
    prefix: input.prefix,
    invitee_fingerprint: input.inviteeFingerprint,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "pending invite add sign failed");
  }
  await addHubRegistryPendingInvite(signed.entry);
  return signed.entry;
}

/** Owner: dual-sign cancel of a pending invite. */
export async function nativeCancelPendingInvite(input: {
  prefix: string;
  inviteeFingerprint: string;
  seq?: number;
}): Promise<HubRegistryPendingInviteOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry?: HubRegistryPendingInviteOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedPendingInviteCancel" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignPendingInviteCancel",
    nonce: n,
    prefix: input.prefix,
    invitee_fingerprint: input.inviteeFingerprint,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "pending invite cancel sign failed");
  }
  await removeHubRegistryPendingInvite(signed.entry);
  return signed.entry;
}

/** Invitee: identity-sign decline + remove HubRegistry pending invite. */
export async function nativeDeclinePendingInvite(input: {
  prefix: string;
  inviteeFingerprint: string;
  repoOwnerVk: string;
  seq?: number;
}): Promise<HubRegistryPendingInviteOp> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry?: HubRegistryPendingInviteOp;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedPendingInviteDecline" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  const seq = input.seq ?? Date.now();
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignPendingInviteDecline",
    nonce: n,
    prefix: input.prefix,
    invitee_fingerprint: input.inviteeFingerprint,
    repo_owner_vk: input.repoOwnerVk,
    seq,
    updated_at: new Date().toISOString(),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "pending invite decline sign failed");
  }
  await removeHubRegistryPendingInvite(signed.entry);
  return signed.entry;
}

/** Sign HubProfile inbox append — proves sender holds this identity. */
export async function nativeSignInboxAppend(input: {
  recipientFingerprint: string;
  id: string;
  ciphertext_b64: string;
  created_at: string;
}): Promise<{ sender_vk: string; sender_sig: string }> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    sender_vk?: string;
    sender_sig?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedInboxAppend" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignInboxAppend",
    nonce: n,
    recipient_fingerprint: input.recipientFingerprint,
    id: input.id,
    ciphertext_b64: input.ciphertext_b64,
    created_at: input.created_at,
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.sender_vk || !signed.sender_sig) {
    throw new Error(signed.message ?? "inbox append sign failed");
  }
  return { sender_vk: signed.sender_vk, sender_sig: signed.sender_sig };
}

/**
 * Soft-delete: RepoState tombstone (deleted extension + [deleted] description)
 * then HubRegistry remove. Does not erase Freenet pack history.
 * After that is confirmed, drops the repo owner key from hub-identity.
 * If HubVault was already in_sync with the delegate, auto-pushes the reduced
 * set; otherwise leaves vault for the user to sync in Settings.
 */
export async function nativeSoftDeleteRepo(input: {
  prefix: string;
  /** Listing seq to beat when unregistering (Date.now() if unknown). */
  registrySeq?: number;
}): Promise<void> {
  // NEW CODE - TESTING: take down Pages website before tombstone / unregister
  try {
    const { ensurePagesTakenDown } = await import("./native-pages");
    await ensurePagesTakenDown(input.prefix);
  } catch (err) {
    throw new Error(
      `Cannot delete while Pages cleanup failed: ${
        err instanceof Error ? err.message : String(err)
      }. Disable Pages in Settings first, then try again.`,
    );
  }

  // Capture vault↔delegate status before mutating local keys.
  let syncBefore: string | null = null;
  try {
    const { compareVaultAndDelegate } = await import("./auth-api");
    const status = await compareVaultAndDelegate();
    syncBefore = status.kind;
  } catch {
    syncBefore = null;
  }

  const stateBytes = await fetchRepoState(input.prefix);
  const stateHex = [...stateBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const deletedAt = new Date().toISOString();
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    delta_hex?: string;
    state_hex?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRepoTombstone" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRepoTombstone",
    nonce: n,
    prefix: input.prefix,
    state_hex: stateHex,
    deleted_at: deletedAt,
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.delta_hex) {
    throw new Error(signed.message ?? "tombstone sign failed");
  }
  const repoKey = repoContractKey(input.prefix);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await updateContract(wrapDeltaUpdate(repoKey, delta), repoKey);
  // hangs: stdlib "Request timeout" (~30s)
  // NEW CODE - TESTING: Put merged RepoState first (same as rename / tip push)
  if (signed.state_hex) {
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const wasmResp = await fetch("./repo-contract.wasm");
      // if (!wasmResp.ok) {
      //   throw new Error("failed to fetch repo-contract.wasm");
      // }
      // const repoWasm = new Uint8Array(await wasmResp.arrayBuffer());
      // NEW CODE - TESTING: wasm-cache
      const repoWasm = await loadPublicWasm("./repo-contract.wasm");
      const putReq = buildPutRequest(
        repoWasm,
        REPO_WASM_HASH_B58,
        encodeRepoParams(input.prefix),
        hexDecode(signed.state_hex),
      );
      await withWriteTimeout(putContract(putReq, repoKey), "repo tombstone Put");
    } catch (putErr) {
      console.warn(
        "[owner] tombstone Put failed, trying Update:",
        putErr instanceof Error ? putErr.message : putErr,
      );
      try {
        await getContractState(repoKey, {
          priority: "high",
          timeoutMs: 12_000,
          maxAttempts: 2,
          fetchContract: true,
          subscribe: true,
          scope: input.prefix,
        });
      } catch {
        /* prime best-effort */
      }
      await withWriteTimeout(
        updateContract(
          wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
          repoKey,
        ),
        "repo tombstone Update",
      );
    }
  } else {
    await withWriteTimeout(
      updateContract(
        wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
        repoKey,
      ),
      "repo tombstone Update",
    );
  }
  clearRepoStateCache(input.prefix);

  try {
    await nativeUnregisterRepo({
      prefix: input.prefix,
      seq: input.registrySeq ?? Date.now(),
    });
    const { invalidateRegistryCache } = await import("./discover-cache");
    invalidateRegistryCache();
  } catch (e) {
    console.warn("[owner] tombstone ok; unregister failed:", e);
    throw e;
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Soft-delete left the owner key in hub-identity (and vault untouched).
  // NEW CODE - TESTING: drop key after confirmed soft-delete; vault push if in_sync
  await nativeRemoveRepoKey(input.prefix);
  if (syncBefore === "in_sync") {
    try {
      const { pushDelegateReposToVault } = await import("./auth-api");
      await pushDelegateReposToVault();
    } catch (e) {
      console.warn(
        "[owner] soft-delete removed local key; vault auto-push failed — sync in Settings:",
        e,
      );
    }
  }
}

/**
 * Rename: owner-signed RepoState.name — Put full merged state (preferred),
 * Update delta fallback. Prefix stays fixed.
 */
export async function nativeRenameRepo(input: {
  prefix: string;
  name: string;
  description?: string | null;
  registrySeq?: number;
}): Promise<{ label: string; name: string }> {
  const nextName = input.name.trim();
  if (!nextName) throw new Error("Repository name must not be empty");

  const stateBytes = await fetchRepoState(input.prefix);
  const stateHex = [...stateBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    delta_hex?: string;
    state_hex?: string;
    label?: string;
    name?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRepoRename" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
    45_000,
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRepoRename",
    nonce: n,
    prefix: input.prefix,
    state_hex: stateHex,
    name: nextName,
  });
  const signed = await pending;
  if (
    signed.type === "Error" ||
    !signed.delta_hex ||
    !signed.label ||
    !signed.name
  ) {
    throw new Error(signed.message ?? "rename sign failed");
  }
  const repoKey = repoContractKey(input.prefix);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await updateContract(wrapDeltaUpdate(repoKey, delta), repoKey);
  // hangs: stdlib "Request timeout" (~30s)
  // NEW CODE - TESTING: Put merged RepoState first (same as tip push / HubRegistry)
  if (signed.state_hex) {
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const wasmResp = await fetch("./repo-contract.wasm");
      // if (!wasmResp.ok) {
      //   throw new Error("failed to fetch repo-contract.wasm");
      // }
      // const repoWasm = new Uint8Array(await wasmResp.arrayBuffer());
      // NEW CODE - TESTING: wasm-cache
      const repoWasm = await loadPublicWasm("./repo-contract.wasm");
      const putReq = buildPutRequest(
        repoWasm,
        REPO_WASM_HASH_B58,
        encodeRepoParams(input.prefix),
        hexDecode(signed.state_hex),
      );
      await withWriteTimeout(putContract(putReq, repoKey), "repo rename Put");
    } catch (putErr) {
      console.warn(
        "[owner] rename Put failed, trying Update:",
        putErr instanceof Error ? putErr.message : putErr,
      );
      try {
        await getContractState(repoKey, {
          priority: "high",
          timeoutMs: 12_000,
          maxAttempts: 2,
          fetchContract: true,
          subscribe: true,
          scope: input.prefix,
        });
      } catch {
        /* prime best-effort */
      }
      await withWriteTimeout(
        updateContract(
          wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
          repoKey,
        ),
        "repo rename Update",
      );
    }
  } else {
    // Older hub-identity without state_hex — Update only
    await withWriteTimeout(
      updateContract(
        wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
        repoKey,
      ),
      "repo rename Update",
    );
  }
  clearRepoStateCache(input.prefix);

  try {
    // Preserve About website/topics when refreshing the listing after rename.
    let website: string | null = null;
    let topics: string[] = [];
    try {
      const { fetchHubRegistry } = await import("./hub-registry");
      const { repos } = await fetchHubRegistry();
      const live = repos.find((r) => r.repo_prefix === input.prefix);
      website = live?.website ?? null;
      topics = live?.topics ?? [];
    } catch {
      /* leave empty */
    }
    await nativeRegisterRepo({
      prefix: input.prefix,
      label: signed.label,
      name: signed.name,
      description: input.description ?? undefined,
      website,
      topics,
    });
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const { invalidateRegistryCache } = await import("./discover-cache");
    // invalidateRegistryCache();
    // NEW CODE - TESTING: nativeRegisterRepo already upserts the warm cache
  } catch (e) {
    console.warn("[owner] rename Put ok; register failed:", e);
  }

  try {
    const { compareVaultAndDelegate, pushDelegateReposToVault } = await import(
      "./auth-api"
    );
    const status = await compareVaultAndDelegate();
    if (status.kind === "in_sync") {
      await pushDelegateReposToVault();
    }
  } catch (e) {
    console.warn("[owner] rename ok; vault label sync skipped:", e);
  }

  return { label: signed.label, name: signed.name };
}

/**
 * About edit: write RepoState.description, then HubRegistry upsert with
 * description + website + topics (Discover mirror). Registry-owner SPA gate.
 */
export async function nativeUpdateRepoAbout(input: {
  prefix: string;
  label: string;
  name?: string | null;
  description: string;
  website?: string | null;
  topics?: string[];
}): Promise<{
  description: string;
  registration: HubRegistration;
}> {
  const desc = input.description.trim();
  if (desc.length > 350) {
    throw new Error(`description exceeds 350 characters (got ${desc.length})`);
  }

  const stateBytes = await fetchRepoState(input.prefix);
  const stateHex = [...stateBytes]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    delta_hex?: string;
    state_hex?: string;
    description?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRepoDescription" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRepoDescription",
    nonce: n,
    prefix: input.prefix,
    state_hex: stateHex,
    description: desc,
  });
  const signed = await pending;
  if (
    signed.type === "Error" ||
    !signed.delta_hex ||
    signed.description === undefined
  ) {
    throw new Error(signed.message ?? "description sign failed");
  }
  const repoKey = repoContractKey(input.prefix);

  if (signed.state_hex) {
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const wasmResp = await fetch("./repo-contract.wasm");
      // if (!wasmResp.ok) {
      //   throw new Error("failed to fetch repo-contract.wasm");
      // }
      // const repoWasm = new Uint8Array(await wasmResp.arrayBuffer());
      // NEW CODE - TESTING: wasm-cache
      const repoWasm = await loadPublicWasm("./repo-contract.wasm");
      const putReq = buildPutRequest(
        repoWasm,
        REPO_WASM_HASH_B58,
        encodeRepoParams(input.prefix),
        hexDecode(signed.state_hex),
      );
      await withWriteTimeout(
        putContract(putReq, repoKey),
        "repo description Put",
      );
    } catch (putErr) {
      console.warn(
        "[owner] description Put failed, trying Update:",
        putErr instanceof Error ? putErr.message : putErr,
      );
      try {
        await getContractState(repoKey, {
          priority: "high",
          timeoutMs: 12_000,
          maxAttempts: 2,
          fetchContract: true,
          subscribe: true,
          scope: input.prefix,
        });
      } catch {
        /* prime best-effort */
      }
      await withWriteTimeout(
        updateContract(
          wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
          repoKey,
        ),
        "repo description Update",
      );
    }
  } else {
    await withWriteTimeout(
      updateContract(
        wrapDeltaUpdate(repoKey, hexDecode(signed.delta_hex)),
        repoKey,
      ),
      "repo description Update",
    );
  }
  clearRepoStateCache(input.prefix);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const registration = await nativeRegisterRepo({ … no public_meta … });
  // NEW CODE - TESTING: preserve public_meta (e.g. lang cache) on About upsert
  let existingMeta: Record<string, string> = {};
  try {
    const { peekCachedRegistry } = await import("./discover-cache");
    const { fetchHubRegistry } = await import("./hub-registry");
    const hit =
      peekCachedRegistry()?.find((r) => r.repo_prefix === input.prefix) ??
      (
        await fetchHubRegistry().catch(() => ({
          repos: [] as HubRegistration[],
        }))
      ).repos.find((r) => r.repo_prefix === input.prefix);
    existingMeta = hit?.public_meta ?? {};
  } catch {
    existingMeta = {};
  }

  const registration = await nativeRegisterRepo({
    prefix: input.prefix,
    label: input.label,
    name: input.name ?? undefined,
    description: signed.description,
    website: input.website ?? null,
    topics: input.topics ?? [],
    public_meta: existingMeta,
  });
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // try {
  //   const { invalidateRegistryCache } = await import("./discover-cache");
  //   invalidateRegistryCache();
  // } catch {
  //   /* optional */
  // }
  // NEW CODE - TESTING: nativeRegisterRepo already upserts the warm cache

  return { description: signed.description, registration };
}

export async function nativeCreateRepo(
  name: string,
  description?: string,
): Promise<CreatedRepoResult & { registration?: HubRegistration }> {
  // Capture vault↔delegate status before adding a local repo key.
  let syncBefore: string | null = null;
  try {
    const { compareVaultAndDelegate } = await import("./auth-api");
    const status = await compareVaultAndDelegate();
    syncBefore = status.kind;
  } catch {
    syncBefore = null;
  }

  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    prefix: string;
    label: string;
    url: string;
    params_hex: string;
    state_hex: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "CreatedRepo" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "CreateRepo",
    nonce: n,
    name,
    description: description ?? "",
    default_branch: "refs/heads/main",
  });
  const created = await pending;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const wasmResp = await fetch("./repo-contract.wasm");
  // if (!wasmResp.ok) {
  //   throw new Error(
  //     `failed to fetch repo-contract.wasm: ${wasmResp.status} (copy freenet-git repo-contract.wasm into web/public/)`,
  //   );
  // }
  // const wasm = new Uint8Array(await wasmResp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  let wasm: Uint8Array;
  try {
    wasm = await loadPublicWasm("./repo-contract.wasm");
  } catch (e) {
    throw new Error(
      `failed to fetch repo-contract.wasm: ${
        e instanceof Error ? e.message : String(e)
      } (copy freenet-git repo-contract.wasm into web/public/)`,
    );
  }
  const paramsFull = hexDecode(created.params_hex);
  const stateFull = hexDecode(created.state_hex);
  const req = buildPutRequest(
    wasm,
    REPO_WASM_HASH_B58,
    paramsFull,
    stateFull,
  );
  await putContract(req);

  let registration: HubRegistration | undefined;
  try {
    registration = await nativeRegisterRepo({
      prefix: created.prefix,
      label: created.label,
      name,
      description,
    });
  } catch (e) {
    console.warn("[owner] create Put ok; register failed:", e);
  }

  // NEW CODE - TESTING: auto-push when vault was already aligned (or only behind)
  if (syncBefore === "in_sync" || syncBefore === "vault_behind") {
    try {
      const { pushDelegateReposToVault } = await import("./auth-api");
      await pushDelegateReposToVault();
    } catch (e) {
      console.warn("[owner] create ok; vault auto-push skipped:", e);
    }
  }

  return {
    prefix: created.prefix,
    label: created.label,
    url: created.url,
    registration,
  };
}

export async function nativeExportIdentity(): Promise<{
  secret_key: string;
  fingerprint: string;
  name: string;
  email: string;
}> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    secret_key: string;
    fingerprint: string;
    name: string;
    email: string;
    message?: string;
  }>((p) => p.type === "ExportedIdentity" || isNoIdentityError(p));
  await sendDelegateMessage(api, key, codeHash, { type: "ExportIdentity" });
  return pending;
}

export async function nativeExportRepos(): Promise<
  Array<{ prefix: string; label: string; secret_hex: string }>
> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    repos: Array<{ prefix: string; label: string; secret_hex: string }>;
  }>((p) => p.type === "ExportedRepos");
  await sendDelegateMessage(api, key, codeHash, { type: "ExportRepos" });
  const res = await pending;
  return res.repos ?? [];
}

export async function nativeImportIdentity(
  secretKeyHex: string,
  name: string,
  email: string,
): Promise<HubIdentityInfo> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<HubIdentityInfo & { type: string }>(
    (p) => p.type === "Identity",
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "ImportIdentity",
    secret_key: secretKeyHex,
    name,
    email,
  });
  const id = await pending;
  return {
    fingerprint: id.fingerprint,
    name: id.name,
    email: id.email,
    public_key_b58: id.public_key_b58,
  };
}

export async function nativeImportRepoKey(
  prefix: string,
  secretKeyHex: string,
  label = "",
): Promise<Array<{ prefix: string; label: string }>> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    repos: Array<{ prefix: string; label: string }>;
    message?: string;
  }>((p) => p.type === "RepoList" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "ImportRepoKey",
    prefix,
    secret_key: secretKeyHex,
    label,
  });
  const res = await pending;
  return res.repos ?? [];
}

/** Drop a repo owner key from hub-identity (after soft-delete is confirmed). */
export async function nativeRemoveRepoKey(
  prefix: string,
): Promise<Array<{ prefix: string; label: string }>> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    repos: Array<{ prefix: string; label: string }>;
    message?: string;
  }>((p) => p.type === "RepoList" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "RemoveRepoKey",
    prefix,
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "RemoveRepoKey failed");
  }
  return res.repos ?? [];
}

/** Sign a tip-push delta (SinglePack + ref + bundle-tip). SPA Puts the pack first. */
export async function nativeSignPush(input: {
  prefix: string;
  stateHex: string;
  packHashHex?: string;
  sizeBytes: number;
  refName: string;
  tipHex: string;
  /** When set, signs ChunkedPack (sizeBytes = total_size). */
  manifestHashHex?: string;
  chunkCount?: number;
}): Promise<{ delta_hex: string; state_hex: string }> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    delta_hex?: string;
    state_hex?: string;
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedPush" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await sendDelegateMessage(api, key, codeHash, {
  //   type: "SignPush",
  //   nonce: n,
  //   prefix: input.prefix,
  //   state_hex: input.stateHex,
  //   pack_hash_hex: input.packHashHex,
  //   size_bytes: input.sizeBytes,
  //   ref_name: input.refName,
  //   tip_hex: input.tipHex,
  // });
  // NEW CODE - TESTING: optional ChunkedPack fields
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignPush",
    nonce: n,
    prefix: input.prefix,
    state_hex: input.stateHex,
    pack_hash_hex: input.packHashHex ?? "",
    size_bytes: input.sizeBytes,
    ref_name: input.refName,
    tip_hex: input.tipHex,
    ...(input.manifestHashHex
      ? {
          manifest_hash_hex: input.manifestHashHex,
          chunk_count: input.chunkCount,
        }
      : {}),
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.delta_hex || !signed.state_hex) {
    throw new Error(signed.message ?? "SignPush failed");
  }
  return { delta_hex: signed.delta_hex, state_hex: signed.state_hex };
}

export async function nativeLogout(): Promise<void> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{ type: string }>((p) => p.type === "LoggedOut");
  await sendDelegateMessage(api, key, codeHash, { type: "Logout" });
  await pending;
}

export async function nativeSignVault(input: {
  vault_id: string;
  username: string;
  identity_fingerprint: string;
  envelopes_json: string;
  identity_dek_wrap_json: string;
  api_key_wraps_json?: string;
  authorized_ops_json?: string;
  seq: number;
  updated_at: string;
  sig_kind?: string;
}): Promise<string> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{ type: string; owner_sig: string; message?: string }>(
    (p) =>
      p.type === "SignedVault" ||
      (p.type === "Error" && !isNoIdentityError(p)),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignVault",
    vault_id: input.vault_id,
    username: input.username,
    identity_fingerprint: input.identity_fingerprint,
    envelopes_json: input.envelopes_json,
    identity_dek_wrap_json: input.identity_dek_wrap_json,
    api_key_wraps_json: input.api_key_wraps_json ?? "[]",
    authorized_ops_json: input.authorized_ops_json ?? "[]",
    seq: input.seq,
    updated_at: input.updated_at,
    sig_kind: input.sig_kind ?? "owner",
  });
  const signed = await pending;
  return signed.owner_sig;
}

export async function nativeSignProfile(input: {
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  inbox_pk_hex?: string;
  inbox_messages_json?: string;
  public_meta?: Record<string, string>;
  seq: number;
  updated_at: string;
}): Promise<{
  identity_fingerprint: string;
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  inbox_pk_hex: string;
  inbox_messages_json: string;
  public_meta: Record<string, string>;
  seq: number;
  updated_at: string;
  owner_sig: string;
}> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    identity_fingerprint: string;
    username: string;
    public_email: string;
    bio: string;
    url: string;
    avatar: string;
    inbox_pk_hex?: string;
    inbox_messages_json?: string;
    public_meta_json?: string;
    seq: number;
    updated_at: string;
    owner_sig: string;
    message?: string;
  }>(
    (p) =>
      p.type === "SignedProfile" ||
      (p.type === "Error" && !isNoIdentityError(p)),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignProfile",
    username: input.username,
    public_email: input.public_email,
    bio: input.bio,
    url: input.url,
    avatar: input.avatar,
    inbox_pk_hex: input.inbox_pk_hex ?? "",
    // Owner sig always covers empty message list (see profile contract).
    inbox_messages_json: "[]",
    public_meta_json: JSON.stringify(input.public_meta ?? {}),
    seq: input.seq,
    updated_at: input.updated_at,
  });
  const signed = await pending;
  if (signed.type === "Error") {
    throw new Error(signed.message ?? "SignProfile failed");
  }
  let public_meta: Record<string, string> = input.public_meta ?? {};
  if (signed.public_meta_json) {
    try {
      public_meta = JSON.parse(signed.public_meta_json) as Record<
        string,
        string
      >;
    } catch {
      /* keep input */
    }
  }
  return {
    identity_fingerprint: signed.identity_fingerprint,
    username: signed.username,
    public_email: signed.public_email,
    bio: signed.bio,
    url: signed.url,
    avatar: signed.avatar,
    inbox_pk_hex: signed.inbox_pk_hex ?? input.inbox_pk_hex ?? "",
    inbox_messages_json: signed.inbox_messages_json ?? "[]",
    public_meta,
    seq: signed.seq,
    updated_at: signed.updated_at,
    owner_sig: signed.owner_sig,
  };
}

export async function nativeSignRepoMetaUpsert(input: {
  prefix: string;
  seal_pk: string;
  public_settings?: Record<string, string>;
  sealed_settings?: {
    alg: string;
    nonce_b64: string;
    blob_b64: string;
  } | null;
  seq: number;
  updated_at: string;
}): Promise<{
  schema_version: number;
  repo_prefix: string;
  repo_owner_vk: string;
  seal_pk: string;
  public_settings: Record<string, string>;
  sealed_settings?: {
    alg: string;
    nonce_b64: string;
    blob_b64: string;
  } | null;
  identity_fingerprint: string;
  attestation: string;
  identity_sig: string;
  repo_owner_sig: string;
  seq: number;
  updated_at: string;
}> {
  const { api, key, codeHash } = await withDelegate();
  const n = nonce();
  const pending = waitForDelegate<{
    type: string;
    nonce: string;
    entry?: {
      schema_version: number;
      repo_prefix: string;
      repo_owner_vk: string;
      seal_pk: string;
      public_settings: Record<string, string>;
      sealed_settings?: {
        alg: string;
        nonce_b64: string;
        blob_b64: string;
      } | null;
      identity_fingerprint: string;
      attestation: string;
      identity_sig: string;
      repo_owner_sig: string;
      seq: number;
      updated_at: string;
    };
    message?: string;
  }>(
    (p) =>
      (p.type === "SignedRepoMetaUpsert" && p.nonce === n) ||
      (p.type === "Error" && p.nonce === n),
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignRepoMetaUpsert",
    nonce: n,
    prefix: input.prefix,
    seal_pk: input.seal_pk,
    public_settings_json: JSON.stringify(input.public_settings ?? {}),
    sealed_settings_json:
      input.sealed_settings == null
        ? ""
        : JSON.stringify(input.sealed_settings),
    seq: input.seq,
    updated_at: input.updated_at,
  });
  const signed = await pending;
  if (signed.type === "Error" || !signed.entry) {
    throw new Error(signed.message ?? "SignRepoMetaUpsert failed");
  }
  return signed.entry;
}

export async function nativeSignStar(input: {
  repo_prefix: string;
  label?: string | null;
  starred_at: string;
}): Promise<{
  fingerprint: string;
  repo_prefix: string;
  label?: string | null;
  starred_at: string;
  sig: string;
}> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    fingerprint: string;
    repo_prefix: string;
    label?: string | null;
    starred_at: string;
    sig: string;
  }>((p) => p.type === "SignedStar" || (p.type === "Error" && !isNoIdentityError(p)));
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignStar",
    repo_prefix: input.repo_prefix,
    label: input.label ?? null,
    starred_at: input.starred_at,
  });
  return pending;
}

export async function nativeSignUnstar(input: {
  repo_prefix: string;
  starred_at: string;
}): Promise<{
  fingerprint: string;
  repo_prefix: string;
  starred_at: string;
  sig: string;
}> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    fingerprint: string;
    repo_prefix: string;
    starred_at: string;
    sig: string;
  }>((p) => p.type === "SignedUnstar" || (p.type === "Error" && !isNoIdentityError(p)));
  await sendDelegateMessage(api, key, codeHash, {
    type: "SignUnstar",
    repo_prefix: input.repo_prefix,
    starred_at: input.starred_at,
  });
  return pending;
}

/** Durable backup pin index on the identity delegate (survives Freenet sandbox reloads). */
export async function nativeUpsertRepoBackupPin(pin: unknown): Promise<void> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    prefix?: string;
    message?: string;
  }>((p) => p.type === "RepoBackupOk" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "UpsertRepoBackupPin",
    pin_json: JSON.stringify(pin),
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "UpsertRepoBackupPin failed");
  }
}

export async function nativeRemoveRepoBackupPin(
  prefix: string,
  reason?: string | null,
): Promise<void> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    prefix?: string;
    message?: string;
  }>((p) => p.type === "RepoBackupOk" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "RemoveRepoBackupPin",
    prefix,
    reason: reason ?? null,
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "RemoveRepoBackupPin failed");
  }
}

export async function nativeListRepoBackupPins(): Promise<unknown[]> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    pins_json?: string;
    message?: string;
  }>((p) => p.type === "RepoBackupPins" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "ListRepoBackupPins",
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "ListRepoBackupPins failed");
  }
  try {
    const parsed = JSON.parse(res.pins_json ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist tip-pack bytes on the identity delegate (content-addressed). */
export async function nativeUpsertRepoBackupBlob(
  hashHex: string,
  bytes: Uint8Array,
): Promise<void> {
  // Avoid keys.bytesToHex (spread) on multi-MB packs.
  let bytesHex = "";
  const hex = "0123456789abcdef";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    bytesHex += hex[(b >>> 4) & 0xf]! + hex[b & 0xf]!;
  }
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    hash_hex?: string;
    message?: string;
  }>((p) => p.type === "RepoBackupBlobOk" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "UpsertRepoBackupBlob",
    hash_hex: hashHex.trim().toLowerCase(),
    bytes_hex: bytesHex,
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "UpsertRepoBackupBlob failed");
  }
}

export async function nativeGetRepoBackupBlob(
  hashHex: string,
): Promise<Uint8Array | null> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    hash_hex?: string;
    bytes_hex?: string;
    message?: string;
  }>(
    (p) =>
      p.type === "RepoBackupBlob" ||
      p.type === "RepoBackupBlobMissing" ||
      p.type === "Error",
  );
  await sendDelegateMessage(api, key, codeHash, {
    type: "GetRepoBackupBlob",
    hash_hex: hashHex.trim().toLowerCase(),
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "GetRepoBackupBlob failed");
  }
  if (res.type === "RepoBackupBlobMissing" || !res.bytes_hex) return null;
  // hexToBytes() is for 32-byte hashes only — packs are arbitrary length.
  const clean = res.bytes_hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export async function nativeRemoveRepoBackupBlob(hashHex: string): Promise<void> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    hash_hex?: string;
    message?: string;
  }>((p) => p.type === "RepoBackupBlobOk" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "RemoveRepoBackupBlob",
    hash_hex: hashHex.trim().toLowerCase(),
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "RemoveRepoBackupBlob failed");
  }
}

export async function nativeListRepoBackupBlobHashes(): Promise<string[]> {
  const { api, key, codeHash } = await withDelegate();
  const pending = waitForDelegate<{
    type: string;
    hashes?: string[];
    message?: string;
  }>((p) => p.type === "RepoBackupBlobHashes" || p.type === "Error");
  await sendDelegateMessage(api, key, codeHash, {
    type: "ListRepoBackupBlobHashes",
  });
  const res = await pending;
  if (res.type === "Error") {
    throw new Error(res.message ?? "ListRepoBackupBlobHashes failed");
  }
  return Array.isArray(res.hashes) ? res.hashes.map((h) => h.toLowerCase()) : [];
}
