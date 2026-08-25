/**
 * ForgeProfile contract GET / Put / Update — public bio/avatar/url by fingerprint.
 */
import { ContractKey } from "@freenetorg/freenet-stdlib";
import bs58 from "bs58";
import {
  FORGE_PROFILE_PARAMS_PREFIX,
  FORGE_PROFILE_WASM_HASH_B58,
  forgeProfileReady,
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

/**
 * Older ForgeProfile WASM hashes (avatar caps 48_000 then 1_048_576).
 * Instance ids include the code hash — reads must consider these or a stub
 * Put on the new hash shadows the real profile forever.
 */
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const FORGE_PROFILE_WASM_HASH_B58_LEGACY = "AYg5…";
// NEW CODE - TESTING: chain of prior profile WASM hashes
const FORGE_PROFILE_WASM_HASH_B58_LEGACY: readonly string[] = [
  "ANKc3EgdbQUiX7nSBz5RPKPxsjFiMd1T7k1GmY3Ttbj3", // MAX_AVATAR 1_048_576
  "AYg5AtP3vAVZEmYKtUkQvMf3KfgxURGbdmA1ApnmtMKw", // MAX_AVATAR 48_000
];

function profileWasmHashesToProbe(): string[] {
  const current = String(FORGE_PROFILE_WASM_HASH_B58 ?? "").trim();
  const out: string[] = [];
  if (current) out.push(current);
  for (const h of FORGE_PROFILE_WASM_HASH_B58_LEGACY) {
    if (h && h !== current && !out.includes(h)) out.push(h);
  }
  return out;
}

/** Accidental empty Put on a new WASM hash after a soft miss. */
function isSparseProfileStub(p: ForgeProfileStateJson): boolean {
  const metaKeys = Object.keys(p.public_meta ?? {}).filter((k) => {
    const v = (p.public_meta?.[k] ?? "").trim();
    return v.length > 0 && v !== "{}" && v !== "[]";
  });
  return (
    !(p.avatar ?? "").trim() &&
    !(p.bio ?? "").trim() &&
    !(p.url ?? "").trim() &&
    (p.inbox_messages?.length ?? 0) === 0 &&
    metaKeys.length === 0
  );
}

function pickBestProfile(
  candidates: ForgeProfileStateJson[],
): ForgeProfileStateJson | null {
  if (candidates.length === 0) return null;
  // Prefer rich state when it is at least as new as any sparse stub (WASM-bump
  // poison: empty Put seq=1 hiding legacy seq=N). Highest seq still wins when
  // the user intentionally cleared the profile (sparse with higher seq).
  const rich = candidates.filter((p) => !isSparseProfileStub(p));
  const sparse = candidates.filter((p) => isSparseProfileStub(p));
  const maxSparseSeq = sparse.reduce((m, p) => Math.max(m, p.seq), -1);
  const pool =
    rich.length > 0 && rich.some((p) => p.seq >= maxSparseSeq)
      ? rich
      : candidates;
  return pool.reduce((best, p) => {
    if (p.seq !== best.seq) return p.seq > best.seq ? p : best;
    if (isSparseProfileStub(best) !== isSparseProfileStub(p)) {
      return isSparseProfileStub(best) ? p : best;
    }
    const aLen = (p.avatar ?? "").length;
    const bLen = (best.avatar ?? "").length;
    if (aLen !== bLen) return aLen > bLen ? p : best;
    const aInbox = p.inbox_messages?.length ?? 0;
    const bInbox = best.inbox_messages?.length ?? 0;
    return aInbox >= bInbox ? p : best;
  });
}

/** Soft listing GETs stay short; writes need a real existence check. */
/** Align with FreenetWsApi REQUEST_TIMEOUT_MS; large GIF avatars need headroom. */
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// const PROFILE_WRITE_TIMEOUT_MS = 35_000;
// NEW CODE - TESTING: multi-MiB avatar Puts
const PROFILE_WRITE_TIMEOUT_MS = 120_000;

export interface InboxMessageJson {
  id: string;
  ciphertext_b64: string;
  created_at: string;
  sender_vk?: string;
  /** Required on append — identity ed25519 over inbox-append payload. */
  sender_sig?: string;
}

export interface ForgeProfileStateJson {
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
  return `${FORGE_PROFILE_PARAMS_PREFIX}${fingerprint}`;
}

function paramsBytesForFingerprint(fingerprint: string): Uint8Array {
  return new TextEncoder().encode(profileParamsUtf8(fingerprint));
}

export function forgeProfileKeyForFingerprint(
  fingerprint: string,
  wasmHashB58: string | null = FORGE_PROFILE_WASM_HASH_B58,
): ContractKey | null {
  if (!wasmHashB58 || !fingerprint) return null;
  const params = paramsBytesForFingerprint(fingerprint);
  const instance = deriveInstanceId(wasmHashB58, params);
  const codeBytes = bs58.decode(wasmHashB58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

function parseProfileState(bytes: Uint8Array): ForgeProfileStateJson | null {
  if (!bytes.length) return null;
  const text = new TextDecoder().decode(bytes);
  const data = JSON.parse(text) as ForgeProfileStateJson;
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
 * Fetch ForgeProfile.
 * - soft (default): fast fail for people listings / browse
 * - reliable: high-priority retries for restore / seq (no subscribe — that hangs
 *   on missing contracts when combined with fetchContract)
 *
 * Probes current + legacy WASM hashes and picks the richest state so a stub
 * Put on a new avatar-limit WASM cannot hide the real profile.
 */
export async function fetchForgeProfile(
  fingerprint: string,
  opts?: { reliable?: boolean },
): Promise<ForgeProfileStateJson | null> {
  if (!forgeProfileReady() || !fingerprint) {
    return null;
  }
  const hashes = profileWasmHashesToProbe();
  if (hashes.length === 0) return null;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Sequential probe of every hash — soft miss × 3 ≈ 12s even when current hit
  // NEW CODE - TESTING: soft current first; only fan out to legacy when needed
  if (!opts?.reliable) {
    const currentHash = hashes[0]!;
    try {
      const current = await fetchForgeProfileAtHash(
        fingerprint,
        currentHash,
        opts,
      );
      if (current && !isSparseProfileStub(current)) {
        return current;
      }
      if (hashes.length === 1) return current;
      const legacyHits = await Promise.all(
        hashes.slice(1).map((hash) =>
          fetchForgeProfileAtHash(fingerprint, hash, opts).catch(() => null),
        ),
      );
      return pickBestProfile(
        [current, ...legacyHits].filter(
          (p): p is ForgeProfileStateJson => p != null,
        ),
      );
    } catch {
      return null;
    }
  }

  const settled = await Promise.all(
    hashes.map((hash) =>
      fetchForgeProfileAtHash(fingerprint, hash, opts).catch((err) => {
        if (!isMissingProfileError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/timed out|timeout|Connection closed|1006/i.test(msg)) {
            console.warn("[forge-profile] reliable probe:", msg);
          }
        }
        return null;
      }),
    ),
  );
  return pickBestProfile(
    settled.filter((p): p is ForgeProfileStateJson => p != null),
  );
}

async function fetchForgeProfileAtHash(
  fingerprint: string,
  wasmHashB58: string | null,
  opts?: { reliable?: boolean },
): Promise<ForgeProfileStateJson | null> {
  const key = forgeProfileKeyForFingerprint(fingerprint, wasmHashB58);
  if (!key) return null;
  if (opts?.reliable) {
    try {
      const raw = await getContractState(key, {
        priority: "high",
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // timeoutMs: 12_000, maxAttempts: 2 — up to 24s per hash
        // NEW CODE - TESTING: one shorter attempt; parallel across hashes
        timeoutMs: 8_000,
        maxAttempts: 1,
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

/**
 * If the best profile still lives only on a legacy WASM hash (or current is a
 * sparse stub left by a soft-miss Put), re-publish onto the current hash so
 * vault / sync / Account UI all see the same contract instance.
 */
export async function migrateForgeProfileToCurrentWasm(
  fingerprint: string,
): Promise<ForgeProfileStateJson | null> {
  const currentHash = String(FORGE_PROFILE_WASM_HASH_B58 ?? "").trim();
  const hashes = profileWasmHashesToProbe();

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Sequential reliable GETs on every hash — blocked Account for ~30s
  // NEW CODE - TESTING: soft parallel first; reliable only if soft empty
  const softHits = await Promise.all(
    hashes.map((hash) =>
      fetchForgeProfileAtHash(fingerprint, hash).catch(() => null),
    ),
  );
  const currentIdx = currentHash ? hashes.indexOf(currentHash) : -1;
  let onCurrent = currentIdx >= 0 ? softHits[currentIdx] ?? null : null;

  let richestLegacy: ForgeProfileStateJson | null = null;
  for (let i = 0; i < hashes.length; i++) {
    if (i === currentIdx) continue;
    const hit = softHits[i];
    if (!hit || isSparseProfileStub(hit)) continue;
    if (
      !richestLegacy ||
      hit.seq > richestLegacy.seq ||
      ((hit.avatar?.length ?? 0) > (richestLegacy.avatar?.length ?? 0) &&
        hit.seq >= richestLegacy.seq)
    ) {
      richestLegacy = hit;
    }
  }

  const softNeedDeeper =
    (!onCurrent || isSparseProfileStub(onCurrent)) && !richestLegacy;
  if (softNeedDeeper) {
    const reliableHits = await Promise.all(
      hashes.map((hash) =>
        fetchForgeProfileAtHash(fingerprint, hash, {
          reliable: true,
        }).catch(() => null),
      ),
    );
    onCurrent = currentIdx >= 0 ? reliableHits[currentIdx] ?? null : null;
    richestLegacy = null;
    for (let i = 0; i < hashes.length; i++) {
      if (i === currentIdx) continue;
      const hit = reliableHits[i];
      if (!hit || isSparseProfileStub(hit)) continue;
      if (
        !richestLegacy ||
        hit.seq > richestLegacy.seq ||
        ((hit.avatar?.length ?? 0) > (richestLegacy.avatar?.length ?? 0) &&
          hit.seq >= richestLegacy.seq)
      ) {
        richestLegacy = hit;
      }
    }
  }

  // Recover WASM-bump poison (sparse current with seq <= rich legacy).
  // Do NOT undo an intentional clear (sparse current with higher seq).
  let source = onCurrent;
  if (richestLegacy) {
    if (!onCurrent) {
      source = richestLegacy;
    } else if (
      isSparseProfileStub(onCurrent) &&
      onCurrent.seq <= richestLegacy.seq
    ) {
      source = richestLegacy;
    } else if (onCurrent.seq < richestLegacy.seq) {
      source = richestLegacy;
    } else if (
      (richestLegacy.avatar?.length ?? 0) > (onCurrent.avatar?.length ?? 0) &&
      richestLegacy.seq >= onCurrent.seq
    ) {
      source = richestLegacy;
    }
  }
  if (!source) return null;

  const needMigrate =
    !onCurrent ||
    (isSparseProfileStub(onCurrent) && !isSparseProfileStub(source)) ||
    onCurrent.seq < source.seq ||
    ((source.avatar?.length ?? 0) > (onCurrent.avatar?.length ?? 0) &&
      !isSparseProfileStub(source) &&
      source.seq >= onCurrent.seq);
  if (!needMigrate) return onCurrent ?? source;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // putOrUpdateForgeProfile(best) — reused legacy seq/sig on a new instance
  // NEW CODE - TESTING: re-sign + bump seq onto current WASM via publish
  return publishForgeProfile({
    username: source.username,
    public_email: source.public_email,
    bio: source.bio,
    url: source.url,
    avatar: source.avatar,
    inbox_pk: source.inbox_pk,
    inbox_messages: source.inbox_messages,
    public_meta: source.public_meta,
  });
}

/** Subscribe + fetch WASM so this node can host before Update. */
async function primeForgeProfileHosting(fingerprint: string): Promise<void> {
  const key = forgeProfileKeyForFingerprint(fingerprint);
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
      "[forge-profile] prime hosting:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function putInitialForgeProfile(
  state: ForgeProfileStateJson,
): Promise<void> {
  const key = forgeProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive ForgeProfile key");
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
    FORGE_PROFILE_WASM_HASH_B58!,
    paramsBytesForFingerprint(state.identity_fingerprint),
    initial,
  );
  await withWriteTimeout(putContract(req, key), "ForgeProfile put");
}

async function updateForgeProfileState(
  state: ForgeProfileStateJson,
): Promise<void> {
  const key = forgeProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive ForgeProfile key");
  const delta = new TextEncoder().encode(JSON.stringify({ upsert: state }));
  await withWriteTimeout(
    updateContract(wrapDeltaUpdate(key, delta), key),
    "ForgeProfile update",
  );
}

export async function putOrUpdateForgeProfile(
  state: ForgeProfileStateJson,
): Promise<void> {
  if (!forgeProfileReady() || !FORGE_PROFILE_WASM_HASH_B58) {
    throw new Error(
      "ForgeProfile WASM not built — run scripts/build-forge-owner-tools.sh",
    );
  }
  const key = forgeProfileKeyForFingerprint(state.identity_fingerprint);
  if (!key) throw new Error("could not derive ForgeProfile key");

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Soft existence → Update after prime. Update never returns UpdateResponse /
  // UpdateNotification on this gateway (30s Request timeout). Re-Put of an
  // existing profile confirms in ~60ms via UpdateNotification (freenet-git).
  // NEW CODE - TESTING: always Put with subscribe; Update only as last resort
  try {
    await putInitialForgeProfile(state);
    return;
  } catch (putErr) {
    console.warn(
      "[forge-profile] Put failed, trying Update:",
      putErr instanceof Error ? putErr.message : putErr,
    );
    await primeForgeProfileHosting(state.identity_fingerprint);
    await updateForgeProfileState(state);
  }
}

/** Sign with identity delegate and put GitForge profile (public + inbox fields). */
export async function publishForgeProfile(input: {
  username: string;
  public_email: string;
  bio: string;
  url: string;
  avatar: string;
  inbox_pk?: string;
  inbox_messages?: InboxMessageJson[];
  /** Adaptive public bag; defaults to existing or {}. */
  public_meta?: Record<string, string>;
}): Promise<ForgeProfileStateJson> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before updating profile");
  const existing = await fetchForgeProfile(id.fingerprint, { reliable: true });
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
  const state: ForgeProfileStateJson = {
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
  await putOrUpdateForgeProfile(state);
  return state;
}

/**
 * Append a sealed inbox message. Requires a signed-in GitForge identity —
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
  if (!forgeProfileReady() || !FORGE_PROFILE_WASM_HASH_B58) {
    throw new Error(
      "ForgeProfile WASM not built — run scripts/build-forge-owner-tools.sh",
    );
  }
  const self = await nativeGetIdentity();
  if (!self) {
    throw new Error("Sign in with a GitForge identity before sending inbox messages");
  }
  const fingerprint = input.fingerprint.trim();
  const key = forgeProfileKeyForFingerprint(fingerprint);
  if (!key) throw new Error("could not derive ForgeProfile key");

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
    const existing = await fetchForgeProfile(fingerprint, { reliable: true });
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
    await publishForgeProfile({
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
  await primeForgeProfileHosting(fingerprint);
  try {
    await withWriteTimeout(
      updateContract(wrapDeltaUpdate(key, delta), key),
      "ForgeProfile append_inbox",
    );
  } catch (err) {
    console.warn(
      "[forge-profile] append_inbox retry:",
      err instanceof Error ? err.message : err,
    );
    await fetchForgeProfile(fingerprint, { reliable: true }).catch(() => null);
    await withWriteTimeout(
      updateContract(wrapDeltaUpdate(key, delta), key),
      "ForgeProfile append_inbox retry",
    );
  }
}

/**
 * Owner prune: remove message ids from inbox (wipes sealed blobs on Freenet).
 * Put-first merged profile state.
 */
export async function pruneInboxMessages(
  removeIds: string[],
): Promise<ForgeProfileStateJson> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("log in before pruning inbox");
  const existing = await fetchForgeProfile(id.fingerprint, { reliable: true });
  if (!existing) throw new Error("profile not found");
  const drop = new Set(removeIds);
  const inbox_messages = (existing.inbox_messages ?? []).filter(
    (m) => !drop.has(m.id),
  );
  return publishForgeProfile({
    username: existing.username,
    public_email: existing.public_email,
    bio: existing.bio,
    url: existing.url,
    avatar: existing.avatar,
    inbox_pk: existing.inbox_pk,
    inbox_messages,
  });
}
