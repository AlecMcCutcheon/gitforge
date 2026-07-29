/**
 * HubProfile contract GET / Put / Update — public bio/avatar/url by fingerprint.
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import {
  HUB_PROFILE_PARAMS_PREFIX,
  HUB_PROFILE_WASM_HASH_B58,
  hubProfileReady,
} from "./owner-constants";
import { deriveInstanceId } from "./keys";
import { buildPutRequest, wrapDeltaUpdate } from "./put";
import { nativeGetIdentity, nativeSignInboxAppend, nativeSignProfile } from "./owner-api";
import {
  getContractState,
  putContract,
  tryGetContractState,
  updateContract,
} from "./ws";

/** Soft listing GETs stay short; writes need a real existence check. */
/** Align with FreenetWsApi REQUEST_TIMEOUT_MS (30s) + small margin. */
const PROFILE_WRITE_TIMEOUT_MS = 35_000;

export interface InboxMessageJson {
  id: string;
  ciphertext_b64: string;
  created_at: string;
  sender_vk?: string;
  /** Required on append — identity ed25519 over inbox-append payload. */
  sender_sig?: string;
}

export interface HubProfileStateJson {
  schema_version: number;
  identity_fingerprint: string;
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  inbox_pk: string;
  inbox_messages: InboxMessageJson[];
  /** Adaptive public bag (status, pinned, …). */
  public_meta: Record<string, string>;
  seq: number;
  updated_at: string;
  owner_sig: string;
}

/** SPA convention keys inside public_meta (WASM does not interpret). */
export const PROFILE_META_STATUS = "status";
export const PROFILE_META_PINNED = "pinned";
export const PROFILE_PINNED_MAX = 12;

export interface ProfileStatusMeta {
  text: string;
  emoji: string;
  updated_at: string;
}

export function parseProfileStatus(
  meta: Record<string, string> | undefined,
): ProfileStatusMeta | null {
  const raw = meta?.[PROFILE_META_STATUS];
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as ProfileStatusMeta;
    if (!data || typeof data !== "object") return null;
    return {
      text: typeof data.text === "string" ? data.text : "",
      emoji: typeof data.emoji === "string" ? data.emoji : "",
      updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
    };
  } catch {
    return null;
  }
}

export function encodeProfileStatus(status: {
  text: string;
  emoji?: string;
}): string {
  return JSON.stringify({
    text: status.text.trim().slice(0, 140),
    emoji: (status.emoji ?? "").trim().slice(0, 16),
    updated_at: new Date().toISOString(),
  } satisfies ProfileStatusMeta);
}

export function parsePinnedPrefixes(
  meta: Record<string, string> | undefined,
): string[] {
  const raw = meta?.[PROFILE_META_PINNED];
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .slice(0, PROFILE_PINNED_MAX);
  } catch {
    return [];
  }
}

export function encodePinnedPrefixes(prefixes: string[]): string {
  const cleaned = [
    ...new Set(prefixes.map((p) => p.trim()).filter(Boolean)),
  ].slice(0, PROFILE_PINNED_MAX);
  return JSON.stringify(cleaned);
}

export function profileParamsUtf8(fingerprint: string): string {
  return `${HUB_PROFILE_PARAMS_PREFIX}${fingerprint}`;
}

function paramsBytesForFingerprint(fingerprint: string): Uint8Array {
  return new TextEncoder().encode(profileParamsUtf8(fingerprint));
}

export function hubProfileKeyForFingerprint(
  fingerprint: string,
): ContractKey | null {
  if (!HUB_PROFILE_WASM_HASH_B58 || !fingerprint) return null;
  const params = paramsBytesForFingerprint(fingerprint);
  const instance = deriveInstanceId(HUB_PROFILE_WASM_HASH_B58, params);
  const codeBytes = bs58.decode(HUB_PROFILE_WASM_HASH_B58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

function parseProfileState(bytes: Uint8Array): HubProfileStateJson | null {
  if (!bytes.length) return null;
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as HubProfileStateJson;
  if (!data?.identity_fingerprint || typeof data.seq !== "number") return null;
  return {
    schema_version: data.schema_version ?? 3,
    identity_fingerprint: data.identity_fingerprint,
    username: data.username ?? "",
    public_email: data.public_email ?? "",
    bio: data.bio ?? "",
    url: data.url ?? "",
    avatar: data.avatar ?? "",
    inbox_pk: data.inbox_pk ?? "",
    inbox_messages: Array.isArray(data.inbox_messages) ? data.inbox_messages : [],
    public_meta:
      data.public_meta && typeof data.public_meta === "object"
        ? data.public_meta
        : {},
    seq: data.seq,
    updated_at: data.updated_at ?? "",
    owner_sig: data.owner_sig ?? "",
  };
}

function withWriteTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${PROFILE_WRITE_TIMEOUT_MS}ms`),
        ),
      PROFILE_WRITE_TIMEOUT_MS,
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

function isMissingProfileError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Contract not found|empty state/i.test(msg);
}

/**
 * Fetch HubProfile.
 * - soft (default): fast fail for people listings / browse
 * - reliable: high-priority retries for restore / seq (no subscribe — that hangs
 *   on missing contracts when combined with fetchContract)
 */
export async function fetchHubProfile(
  fingerprint: string,
  opts?: { reliable?: boolean },
): Promise<HubProfileStateJson | null> {
  if (!hubProfileReady() || !fingerprint) {
    return null;
  }
  const key = hubProfileKeyForFingerprint(fingerprint);
  if (!key) return null;
  if (opts?.reliable) {
    try {
      const raw = await getContractState(key, {
        priority: "high",
        timeoutMs: 12_000,
        maxAttempts: 2,
        // Do NOT set fetchContract+subscribe here — missing contracts hang the WS.
      });
      return parseProfileState(raw);
    } catch (err) {
      if (isMissingProfileError(err)) return null;
      // Soft-fail transport for seq lookup; caller can still Put.
      if (/timed out|timeout|Connection closed|1006/i.test(
        err instanceof Error ? err.message : String(err),
      )) {
        return null;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  const raw = await tryGetContractState(key);
  if (!raw) return null;
  return parseProfileState(raw);
}

/** Subscribe + fetch WASM so this node can host before Update. */
async function primeHubProfileHosting(fingerprint: string): Promise<void> {
  const key = hubProfileKeyForFingerprint(fingerprint);
  if (!key) return;
  try {
    // freenet-mail: subscribe on GET; fetchContract only when we need code.
    await getContractState(key, {
      priority: "high",
      timeoutMs: 12_000,
      maxAttempts: 2,
      fetchContract: true,
      subscribe: true,
    });
  } catch (err) {
    console.warn(
      "[hub-profile] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function putInitialHubProfile(
  state: HubProfileStateJson,
): Promise<void> {
  const key = hubProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive HubProfile key");
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const resp = await fetch("./hub_profile.wasm");
  // if (!resp.ok) {
  //   throw new Error(`failed to fetch hub_profile.wasm: ${resp.status}`);
  // }
  // const wasm = new Uint8Array(await resp.arrayBuffer());
  // NEW CODE - TESTING: wasm-cache
  const { loadPublicWasm } = await import("./wasm-cache");
  const wasm = await loadPublicWasm("./hub_profile.wasm");
  const initial = new TextEncoder().encode(JSON.stringify(state));
  const req = buildPutRequest(
    wasm,
    HUB_PROFILE_WASM_HASH_B58!,
    paramsBytesForFingerprint(state.identity_fingerprint),
    initial,
  );
  await withWriteTimeout(putContract(req, key), "HubProfile put");
}

async function updateHubProfileState(
  state: HubProfileStateJson,
): Promise<void> {
  const key = hubProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive HubProfile key");
  const delta = new TextEncoder().encode(JSON.stringify({ upsert: state }));
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, delta), key),
    "HubProfile update",
  );
}

export async function putOrUpdateHubProfile(
  state: HubProfileStateJson,
): Promise<void> {
  if (!hubProfileReady() || !HUB_PROFILE_WASM_HASH_B58) {
    throw new Error(
      "HubProfile WASM not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const key = hubProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive HubProfile key");

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Soft existence → Update after prime. Update never returns UpdateResponse /
  // UpdateNotification on this gateway (30s Request timeout). Re-Put of an
  // existing profile confirms in ~60ms via UpdateNotification (freenet-git).
  // NEW CODE - TESTING: always Put with subscribe; Update only as last resort
  try {
    await putInitialHubProfile(state);
    return;
  } catch (putErr) {
    console.warn(
      "[hub-profile] Put failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeHubProfileHosting(state.identity_fingerprint);
    await updateHubProfileState(state);
  }
}

/** Sign with identity delegate and put GitAtlas profile (public + inbox fields). */
export async function publishHubProfile(input: {
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  inbox_pk?: string;
  inbox_messages?: InboxMessageJson[];
  /** Adaptive public bag; defaults to existing or {}. */
  public_meta?: Record<string, string>;
}): Promise<HubProfileStateJson> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before updating profile");
  const existing = await fetchHubProfile(id.fingerprint, { reliable: true });
  const seq = (existing?.seq ?? 0) + 1;
  const updated_at = new Date().toISOString();
  const inbox_pk = input.inbox_pk ?? existing?.inbox_pk ?? "";
  const inbox_messages = input.inbox_messages ?? existing?.inbox_messages ?? [];
  const public_meta = input.public_meta ?? existing?.public_meta ?? {};
  const signed = await nativeSignProfile({
    username: input.username,
    public_email: input.public_email,
    bio: input.bio,
    url: input.url,
    avatar: input.avatar,
    inbox_pk_hex: inbox_pk,
    inbox_messages_json: "[]",
    public_meta,
    seq,
    updated_at,
  });
  const state: HubProfileStateJson = {
    schema_version: 3,
    identity_fingerprint: signed.identity_fingerprint,
    username: signed.username,
    public_email: signed.public_email,
    bio: signed.bio,
    url: signed.url,
    avatar: signed.avatar,
    inbox_pk,
    inbox_messages,
    public_meta: signed.public_meta,
    seq: signed.seq,
    updated_at: signed.updated_at,
    owner_sig: signed.owner_sig,
  };
  await putOrUpdateHubProfile(state);
  return state;
}

/**
 * Append a sealed inbox message. Requires a signed-in GitAtlas identity —
 * the contract rejects unsigned appends.
 *
 * Self-notices (system backup/heal/provision) Put the full profile — Update
 * append_inbox often hits stdlib Request timeout on this gateway.
 * Cross-identity invites still use signed Update append.
 */
export async function appendInboxMessage(input: {
  fingerprint: string;
  message: InboxMessageJson;
}): Promise<void> {
  if (!hubProfileReady() || !HUB_PROFILE_WASM_HASH_B58) {
    throw new Error(
      "HubProfile WASM not built — run scripts/build-hub-owner-tools.sh",
    );
  }
  const self = await nativeGetIdentity();
  if (!self) {
    throw new Error("Sign in with a GitAtlas identity before sending inbox messages");
  }
  const fingerprint = input.fingerprint.trim();
  const key = hubProfileKeyForFingerprint(fingerprint);
  if (!key) throw new Error("could not derive HubProfile key");

  const created_at = input.message.created_at || new Date().toISOString();
  const id = input.message.id;
  const ciphertext_b64 = input.message.ciphertext_b64;
  const signed = await nativeSignInboxAppend({
    recipientFingerprint: fingerprint,
    id,
    ciphertext_b64,
    created_at,
  });
  const message: InboxMessageJson = {
    id,
    ciphertext_b64,
    created_at,
    sender_vk: signed.sender_vk,
    sender_sig: signed.sender_sig,
  };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always Update { append_inbox } — hangs with Request timeout; system
  // notifies (self) never appeared in Inbox.
  // NEW CODE - TESTING: self → Put full profile with message; others → Update
  if (self.fingerprint === fingerprint) {
    const existing = await fetchHubProfile(fingerprint, { reliable: true });
    if (!existing) {
      throw new Error("profile not found — publish a public profile first");
    }
    let inbox_pk = existing.inbox_pk?.trim() ?? "";
    if (!inbox_pk) {
      const { nativeExportIdentity } = await import("./owner-api");
      const { inboxPkHexFromSeedHex } = await import("./inbox-crypto");
      const exported = await nativeExportIdentity();
      inbox_pk = inboxPkHexFromSeedHex(exported.secret_key);
    }
    const prior = existing.inbox_messages ?? [];
    const inbox_messages = [
      ...prior.filter((m) => m.id !== message.id),
      message,
    ].slice(-50);
    await publishHubProfile({
      username: existing.username,
      public_email: existing.public_email,
      bio: existing.bio,
      url: existing.url,
      avatar: existing.avatar,
      inbox_pk,
      inbox_messages,
      public_meta: existing.public_meta,
    });
    return;
  }

  const delta = new TextEncoder().encode(
    JSON.stringify({ append_inbox: message }),
  );
  await primeHubProfileHosting(fingerprint);
  try {
    await withWriteTimeout(
      updateContract(wrapDeltaUpdate(key, delta), key),
      "HubProfile append_inbox",
    );
  } catch (err) {
    console.warn(
      "[hub-profile] append_inbox retry:",
      err instanceof Error ? err.message : err,
    );
    await fetchHubProfile(fingerprint, { reliable: true }).catch(() => null);
    await withWriteTimeout(
      updateContract(wrapDeltaUpdate(key, delta), key),
      "HubProfile append_inbox retry",
    );
  }
}

/**
 * Owner prune: remove message ids from inbox (wipes sealed blobs on Freenet).
 * Put-first merged profile state.
 */
export async function pruneInboxMessages(
  removeIds: string[],
): Promise<HubProfileStateJson> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before pruning inbox");
  const existing = await fetchHubProfile(id.fingerprint, { reliable: true });
  if (!existing) throw new Error("profile not found");
  const drop = new Set(removeIds);
  const inbox_messages = (existing.inbox_messages ?? []).filter(
    (m) => !drop.has(m.id),
  );
  return publishHubProfile({
    username: existing.username,
    public_email: existing.public_email,
    bio: existing.bio,
    url: existing.url,
    avatar: existing.avatar,
    inbox_pk: existing.inbox_pk,
    inbox_messages,
  });
}
