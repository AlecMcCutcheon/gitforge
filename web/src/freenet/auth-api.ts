/**
 * High-level identity + GitForge vault account flows.
 * Login is local Freenet identity (create / bundle / recovery phrase / node session).
 * Vault is auto-provisioned (passwordless) and syncs via identity_dek_wrap.
 */
import {
  defaultContactFromFingerprint,
  fingerprintFromSeedHex,
  fingerprintWords,
} from "./fingerprint-words";
import {
  freenetGitBundleFilename,
  mintBundlePassphrase,
  openFreenetGitIdentityBundle,
  sealFreenetGitIdentityBundle,
} from "./freenet-git-bundle";
import { fetchForgeVault, putOrUpdateForgeVault } from "./forge-vault";
import {
  fetchForgeProfile,
  publishForgeProfile,
  type ForgeProfileStateJson,
} from "./forge-profile";
import {
  clearCachedInbox,
  inboxPkHexFromSeedHex,
  listInboxPlaintexts,
  openInboxMessage,
  parseInboxPlaintext,
  setCachedInboxMessages,
  type DecryptedInboxMessage,
} from "./inbox-crypto";
import { normalizeProfileAvatar } from "../lib/avatar-image";
import { isWsDropError, resetFreenetConn } from "./ws";
import {
  nativeAcceptContributorCoupon,
  nativeExportIdentity,
  nativeExportRepos,
  nativeGetIdentity,
  nativeImportIdentity,
  nativeImportRepoKey,
  nativeLogout,
  nativeRemoveContributor,
  nativeRemoveRepoKey,
  nativeSignVault,
  type ForgeIdentityInfo,
} from "./owner-api";
import { randomBytes, bytesToHex } from "@noble/hashes/utils";
import {
  apiKeyWrapsSigningJson,
  authorizedOpsSigningJson,
  decryptEnvelopeWithDek,
  encryptEnvelopeWithDek,
  ENVELOPE_PAGES,
  ENVELOPE_REPOS,
  ENVELOPE_SETTINGS,
  emptySettingsEnvelope,
  envelopesSigningJson,
  findApiKeyWrap,
  generateEnvelopeDekHex,
  generateOpsKeypair,
  generateSeedHex,
  identityDekWrapSigningJson,
  mintVaultApiKeySecret,
  normalizeEmail,
  normalizeScopes,
  normalizeVaultId,
  phraseFromSeedHex,
  sealIdentityDekWrap,
  seedHexFromPhrase,
  SIG_KIND_OWNER,
  unsealIdentityDekWrap,
  unwrapApiKeyPayload,
  VAULT_SCHEMA_VERSION,
  wrapApiKeyPayload,
  type AuthorizedOps,
  type ForgeVaultPublicState,
  type IdentityDekWrap,
  type PagesEnvelopePlaintext,
  type ReposEnvelopePlaintext,
  type SettingsEnvelopePlaintext,
  type VaultApiKeyScope,
  type VaultApiKeyWrap,
  vaultIdFromSeedHex,
} from "./vault-crypto";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// type VaultPlaintext — password-unlock plaintext blob
// totp + password helpers (assertVaultPassword, encryptVaultPlaintext, …)

const SESSION_VAULT_ID_KEY = "gitforge.vault.id";
const SESSION_IDENTITY_KEY = "gitforge.vault.identity";
const SESSION_NEEDS_TOTP_KEY = "gitforge.vault.needs_totp";

/** Freenet `__sandbox=1` often denies sessionStorage; keep a tab-lifetime mirror. */
let memoryVaultId: string | null = null;
let memoryIdentity: ForgeIdentityInfo | null = null;
let memoryVaultNeedsTotpEnroll = false;
// NEW CODE - TESTING: keep seed in memory so inbox refresh doesn't need a
// fresh ExportIdentity round-trip (WS 1006 was killing inbox loads).
let memorySeedHex: string | null = null;

function setCachedSeedHex(seed: string | null): void {
  memorySeedHex = seed?.trim() ? seed.trim() : null;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cold peers only have the website contract — RegisterDelegate identity/pages
 * WASM from public assets before ImportIdentity / CreateIdentity.
 */
async function ensureOwnerDelegatesReady(
  onStatus?: (msg: string) => void,
): Promise<void> {
  // NEW CODE - TESTING
  const { ensureOwnerDelegatesOnThisNode } = await import(
    "./bootstrap-owner-tools"
  );
  await ensureOwnerDelegatesOnThisNode(onStatus);
}

/**
 * Identity seed for decrypt/vault ops. Uses tab memory when available;
 * otherwise ExportIdentity with one reconnect retry on WS drop.
 */
async function exportIdentitySeed(opts?: {
  force?: boolean;
}): Promise<string> {
  if (!opts?.force && memorySeedHex) return memorySeedHex;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const exported = await nativeExportIdentity();
      if (!exported?.secret_key) throw new Error("no identity seed");
      setCachedSeedHex(exported.secret_key);
      return exported.secret_key;
    } catch (e) {
      lastErr = e;
      if (!isWsDropError(e) || attempt === 2) break;
      resetFreenetConn();
      await delayMs(350 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Best-effort identity seed for public-goods (Kairos duty). Never throws —
 * returns null when signed-out / export unavailable.
 */
export async function tryExportIdentitySeedHex(): Promise<string | null> {
  try {
    return await exportIdentitySeed();
  } catch {
    return memorySeedHex;
  }
}

export interface CachedProfile {
  vault_id: string;
  bio: string;
  url: string;
  avatar: string;
  public_email: string;
}

let memoryProfile: CachedProfile | null = null;

type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();

export function onAuthSessionChange(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

function notifyAuthSession(): void {
  for (const listener of sessionListeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

export function getCachedProfile(): CachedProfile | null {
  return memoryProfile;
}

function setCachedProfile(profile: CachedProfile | null): void {
  memoryProfile = profile;
  notifyAuthSession();
}

export interface IdentityExportBundle {
  v: 1;
  kind: "gitforge-identity-export";
  secret_key: string;
  fingerprint: string;
  name: string;
  email: string;
  vault_id?: string;
  repos: Record<string, { secret_hex: string; label: string }>;
}

export function getSessionVaultId(): string | null {
  try {
    const stored = sessionStorage.getItem(SESSION_VAULT_ID_KEY);
    if (stored) {
      memoryVaultId = stored;
      return stored;
    }
  } catch {
    /* sandbox / opaque origin */
  }
  return memoryVaultId;
}

function setSessionVaultId(vaultId: string | null): void {
  memoryVaultId = vaultId ? normalizeVaultId(vaultId) : null;
  try {
    if (vaultId) {
      sessionStorage.setItem(SESSION_VAULT_ID_KEY, normalizeVaultId(vaultId));
    } else {
      sessionStorage.removeItem(SESSION_VAULT_ID_KEY);
    }
  } catch {
    /* ignore — memoryVaultId still set */
  }
  notifyAuthSession();
}

export function getCachedIdentity(): ForgeIdentityInfo | null {
  try {
    const raw = sessionStorage.getItem(SESSION_IDENTITY_KEY);
    if (raw) {
      const data = JSON.parse(raw) as ForgeIdentityInfo;
      if (data?.fingerprint && data.name) {
        memoryIdentity = data;
        return data;
      }
    }
  } catch {
    /* sandbox / opaque origin */
  }
  return memoryIdentity;
}

function setCachedIdentity(id: ForgeIdentityInfo | null): void {
  memoryIdentity = id;
  // NEW CODE - TESTING: drop seed when signed out
  if (!id) setCachedSeedHex(null);
  try {
    if (id) sessionStorage.setItem(SESSION_IDENTITY_KEY, JSON.stringify(id));
    else {
      sessionStorage.removeItem(SESSION_IDENTITY_KEY);
    }
  } catch {
    /* ignore — memoryIdentity still set */
  }
  notifyAuthSession();
}

export function getVaultNeedsTotpEnroll(): boolean {
  try {
    if (sessionStorage.getItem(SESSION_NEEDS_TOTP_KEY) === "1") {
      memoryVaultNeedsTotpEnroll = true;
    }
  } catch {
    /* ignore */
  }
  return memoryVaultNeedsTotpEnroll;
}

function setVaultNeedsTotpEnroll(needs: boolean): void {
  memoryVaultNeedsTotpEnroll = needs;
  try {
    if (needs) sessionStorage.setItem(SESSION_NEEDS_TOTP_KEY, "1");
    else {
      sessionStorage.removeItem(SESSION_NEEDS_TOTP_KEY);
    }
  } catch {
    /* ignore */
  }
  notifyAuthSession();
}

/**
 * Return the session vault id, deriving it from the identity seed when storage
 * was wiped (Freenet sandbox) but the delegate still has the key.
 */
export async function ensureSessionVaultId(): Promise<string | null> {
  const existing = getSessionVaultId();
  if (existing) return existing;
  try {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const exported = await nativeExportIdentity();
    // NEW CODE - TESTING: cached seed + WS-drop retry
    const seed = await exportIdentitySeed();
    if (!seed) return null;
    const vault_id = vaultIdFromSeedHex(seed);
    setSessionVaultId(vault_id);
    return vault_id;
  } catch {
    return getSessionVaultId();
  }
}

/** True when a Freenet ForgeVault ciphertext already exists for this vault address. */
export async function probeVaultBackupEnabled(
  vaultId?: string | null,
): Promise<boolean> {
  const id = vaultId ? normalizeVaultId(vaultId) : getSessionVaultId();
  if (!id) return false;
  try {
    const state = await fetchForgeVault(id);
    return Boolean(state?.identity_dek_wrap?.blob_b64);
  } catch {
    return false;
  }
}

async function collectReposMap(): Promise<
  Record<string, { secret_hex: string; label: string }>
> {
  const repos = await nativeExportRepos();
  const out: Record<string, { secret_hex: string; label: string }> = {};
  for (const r of repos) {
    out[r.prefix] = { secret_hex: r.secret_hex, label: r.label };
  }
  return out;
}

async function buildSignedVaultState(input: {
  vault_id: string;
  username: string;
  fingerprint: string;
  seedHex: string;
  reposMap: Record<string, { secret_hex: string; label: string }>;
  pagesMap?: Record<string, { secret_hex: string; label: string }>;
  seq: number;
  api_key_wraps?: VaultApiKeyWrap[];
  authorized_ops?: AuthorizedOps[];
  /** When set, keep this wrap instead of sealing a new one. */
  identity_dek_wrap?: IdentityDekWrap;
  envelope_deks?: Record<string, string>;
}): Promise<ForgeVaultPublicState> {
  const vault_id = normalizeVaultId(input.vault_id);
  const deks = { ...(input.envelope_deks ?? {}) };
  const reposDek = deks[ENVELOPE_REPOS] || generateEnvelopeDekHex();
  deks[ENVELOPE_REPOS] = reposDek;
  const pagesDek = deks[ENVELOPE_PAGES] || generateEnvelopeDekHex();
  deks[ENVELOPE_PAGES] = pagesDek;
  // NEW CODE - TESTING: settings envelope DEK (adaptive prefs bag)
  const settingsDek = deks[ENVELOPE_SETTINGS] || generateEnvelopeDekHex();
  deks[ENVELOPE_SETTINGS] = settingsDek;

  const skHex = input.seedHex;
  if (!skHex) {
    throw new Error("identity seed missing for vault identity_dek_wrap");
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // password Argon2 identity_cipher + identity_kdf
  // NEW CODE - TESTING: passwordless v4 — DEKs sealed to identity SK only
  // (repos + pages + settings envelopes). Schema stays 4 so vault contract instance ids
  // remain stable; settings is an additive envelope.
  const identity_dek_wrap =
    input.identity_dek_wrap ?? sealIdentityDekWrap(skHex, deks);

  const reposPlain: ReposEnvelopePlaintext = { repos: input.reposMap };
  const pagesPlain: PagesEnvelopePlaintext = {
    pages: input.pagesMap ?? {},
  };
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const settingsPlain: SettingsEnvelopePlaintext = emptySettingsEnvelope();
  // NEW CODE - TESTING: seed settings with current backup prefs when creating vault
  let settingsPlain: SettingsEnvelopePlaintext = emptySettingsEnvelope();
  try {
    const { getBackupPrefs } = await import("./repo-backup");
    settingsPlain = {
      ...settingsPlain,
      repo_backup: getBackupPrefs(),
    };
  } catch {
    /* ignore */
  }
  const envelopes: Record<string, ReturnType<typeof encryptEnvelopeWithDek>> = {
    [ENVELOPE_REPOS]: encryptEnvelopeWithDek(reposDek, reposPlain),
    [ENVELOPE_PAGES]: encryptEnvelopeWithDek(pagesDek, pagesPlain),
    [ENVELOPE_SETTINGS]: encryptEnvelopeWithDek(settingsDek, settingsPlain),
  };

  const wraps =
    input.api_key_wraps && input.api_key_wraps.length > 0
      ? input.api_key_wraps
      : undefined;
  const authorized_ops =
    input.authorized_ops && input.authorized_ops.length > 0
      ? input.authorized_ops
      : undefined;
  const updated_at = new Date().toISOString();
  const envelopes_json = envelopesSigningJson(envelopes);
  const identity_dek_wrap_json = identityDekWrapSigningJson(identity_dek_wrap);
  const api_key_wraps_json = apiKeyWrapsSigningJson(wraps);
  const authorized_ops_json = authorizedOpsSigningJson(authorized_ops);
  const sig = await nativeSignVault({
    vault_id,
    username: input.username,
    identity_fingerprint: input.fingerprint,
    envelopes_json,
    identity_dek_wrap_json,
    api_key_wraps_json,
    authorized_ops_json,
    seq: input.seq,
    updated_at,
    sig_kind: SIG_KIND_OWNER,
  });
  return {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_id,
    envelopes,
    identity_dek_wrap,
    identity_fingerprint: input.fingerprint,
    username: input.username,
    seq: input.seq,
    updated_at,
    sig_kind: SIG_KIND_OWNER,
    sig,
    ...(wraps ? { api_key_wraps: wraps } : {}),
    ...(authorized_ops ? { authorized_ops } : {}),
  };
}

/**
 * Owner-signed envelope update using identity_dek_wrap (no vault password).
 * Updates repos and/or pages; mints pages DEK when missing (v4 additive).
 */
async function buildOwnerEnvelopesUpdate(input: {
  state: ForgeVaultPublicState;
  reposMap?: Record<string, { secret_hex: string; label: string }>;
  pagesMap?: Record<string, { secret_hex: string; label: string }>;
  settingsPlain?: SettingsEnvelopePlaintext;
  deks: Record<string, string>;
  seedHex?: string;
}): Promise<ForgeVaultPublicState> {
  const state = input.state;
  if (!state.identity_dek_wrap?.blob_b64) {
    throw new Error(
      "GitForge vault required — ensure account contracts after sign-in",
    );
  }
  const deks = { ...input.deks };
  let identity_dek_wrap = state.identity_dek_wrap;
  let needReseal = false;
  if (!deks[ENVELOPE_PAGES]) {
    deks[ENVELOPE_PAGES] = generateEnvelopeDekHex();
    needReseal = true;
  }
  // NEW CODE - TESTING: mint settings DEK when missing (v4 additive)
  if (!deks[ENVELOPE_SETTINGS]) {
    deks[ENVELOPE_SETTINGS] = generateEnvelopeDekHex();
    needReseal = true;
  }
  if (needReseal) {
    const sk =
      input.seedHex ||
      (await nativeExportIdentity()).secret_key;
    identity_dek_wrap = sealIdentityDekWrap(sk, deks);
  }
  const reposDek = deks[ENVELOPE_REPOS];
  if (!reposDek) {
    throw new Error("repos DEK missing from identity_dek_wrap");
  }
  const pagesDek = deks[ENVELOPE_PAGES]!;
  const settingsDek = deks[ENVELOPE_SETTINGS]!;
  const vault_id = normalizeVaultId(state.vault_id);
  const envelopes = { ...state.envelopes };
  if (input.reposMap) {
    envelopes[ENVELOPE_REPOS] = encryptEnvelopeWithDek(reposDek, {
      repos: input.reposMap,
    } satisfies ReposEnvelopePlaintext);
  }
  if (input.pagesMap) {
    envelopes[ENVELOPE_PAGES] = encryptEnvelopeWithDek(pagesDek, {
      pages: input.pagesMap,
    } satisfies PagesEnvelopePlaintext);
  } else if (!envelopes[ENVELOPE_PAGES]) {
    envelopes[ENVELOPE_PAGES] = encryptEnvelopeWithDek(pagesDek, {
      pages: {},
    } satisfies PagesEnvelopePlaintext);
  }
  if (input.settingsPlain) {
    envelopes[ENVELOPE_SETTINGS] = encryptEnvelopeWithDek(
      settingsDek,
      input.settingsPlain,
    );
  } else if (!envelopes[ENVELOPE_SETTINGS]) {
    envelopes[ENVELOPE_SETTINGS] = encryptEnvelopeWithDek(
      settingsDek,
      emptySettingsEnvelope(),
    );
  }
  const wraps =
    state.api_key_wraps && state.api_key_wraps.length > 0
      ? state.api_key_wraps
      : undefined;
  const authorized_ops =
    state.authorized_ops && state.authorized_ops.length > 0
      ? state.authorized_ops
      : undefined;
  const seq = state.seq + 1;
  const updated_at = new Date().toISOString();
  const sig = await nativeSignVault({
    vault_id,
    username: state.username,
    identity_fingerprint: state.identity_fingerprint,
    envelopes_json: envelopesSigningJson(envelopes),
    identity_dek_wrap_json: identityDekWrapSigningJson(identity_dek_wrap),
    api_key_wraps_json: apiKeyWrapsSigningJson(wraps),
    authorized_ops_json: authorizedOpsSigningJson(authorized_ops),
    seq,
    updated_at,
    sig_kind: SIG_KIND_OWNER,
  });
  return {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_id,
    envelopes,
    identity_dek_wrap,
    identity_fingerprint: state.identity_fingerprint,
    username: state.username,
    seq,
    updated_at,
    sig_kind: SIG_KIND_OWNER,
    sig,
    ...(wraps ? { api_key_wraps: wraps } : {}),
    ...(authorized_ops ? { authorized_ops } : {}),
  };
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// async function buildOwnerReposEnvelopeUpdate(input: {
//   state: ForgeVaultPublicState;
//   reposMap: Record<string, { secret_hex: string; label: string }>;
//   deks: Record<string, string>;
// }): Promise<ForgeVaultPublicState> {
//   return buildOwnerEnvelopesUpdate({
//     state: input.state,
//     reposMap: input.reposMap,
//     deks: input.deks,
//   });
// }

async function loadVaultSecretsViaIdentityWrap(
  state: ForgeVaultPublicState,
): Promise<{
  deks: Record<string, string>;
  repos: Record<string, { secret_hex: string; label: string }>;
  pages: Record<string, { secret_hex: string; label: string }>;
  settings: SettingsEnvelopePlaintext;
}> {
  if (!state.identity_dek_wrap?.blob_b64) {
    throw new Error(
      "GitForge vault required — ensure account contracts after sign-in",
    );
  }
  const exported = await nativeExportIdentity();
  const { deks } = unsealIdentityDekWrap(
    exported.secret_key,
    state.identity_dek_wrap,
  );
  const reposDek = deks[ENVELOPE_REPOS];
  const reposCipher = state.envelopes?.[ENVELOPE_REPOS];
  if (!reposDek || !reposCipher) {
    throw new Error("vault missing repos envelope or DEK");
  }
  const reposEnv = decryptEnvelopeWithDek<ReposEnvelopePlaintext>(
    reposDek,
    reposCipher,
  );
  let pages: Record<string, { secret_hex: string; label: string }> = {};
  const pagesDek = deks[ENVELOPE_PAGES];
  const pagesCipher = state.envelopes?.[ENVELOPE_PAGES];
  if (pagesDek && pagesCipher) {
    try {
      const pagesEnv = decryptEnvelopeWithDek<PagesEnvelopePlaintext>(
        pagesDek,
        pagesCipher,
      );
      pages = pagesEnv.pages ?? {};
    } catch {
      pages = {};
    }
  }
  let settings: SettingsEnvelopePlaintext = emptySettingsEnvelope();
  const settingsDek = deks[ENVELOPE_SETTINGS];
  const settingsCipher = state.envelopes?.[ENVELOPE_SETTINGS];
  if (settingsDek && settingsCipher) {
    try {
      settings = decryptEnvelopeWithDek<SettingsEnvelopePlaintext>(
        settingsDek,
        settingsCipher,
      );
      if (typeof settings.v !== "number") settings = { ...settings, v: 1 };
    } catch {
      settings = emptySettingsEnvelope();
    }
  }
  return { deks, repos: reposEnv.repos ?? {}, pages, settings };
}

async function loadReposViaIdentityWrap(
  state: ForgeVaultPublicState,
): Promise<{
  deks: Record<string, string>;
  repos: Record<string, { secret_hex: string; label: string }>;
}> {
  const all = await loadVaultSecretsViaIdentityWrap(state);
  return { deks: all.deks, repos: all.repos };
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// async function loadReposFromVaultState(
//   state: ForgeVaultPublicState,
//   plain: VaultPlaintext,
// ): Promise<Record<string, { secret_hex: string; label: string }>> {
//   const dek = plain.envelope_deks?.[ENVELOPE_REPOS];
//   const cipher = state.envelopes?.[ENVELOPE_REPOS];
//   if (dek && cipher) {
//     const env = decryptEnvelopeWithDek<ReposEnvelopePlaintext>(dek, cipher);
//     return env.repos ?? {};
//   }
//   return plain.repos ?? {};
// }
// NEW CODE - TESTING: passwordless path uses loadReposViaIdentityWrap only

export type VaultDelegateSyncKind =
  | "no_vault"
  | "in_sync"
  | "vault_behind"
  | "delegate_behind"
  | "diverged";

export interface VaultEnvelopeSyncSlice {
  kind: VaultDelegateSyncKind;
  only_delegate: string[];
  only_vault: string[];
  secret_mismatch: string[];
  delegate_count: number;
  vault_count: number;
}

export interface VaultDelegateSyncStatus {
  kind: VaultDelegateSyncKind;
  vault_id: string | null;
  /** Prefixes only on the local delegate (repos). */
  only_delegate: string[];
  /** Prefixes only in ForgeVault (repos). */
  only_vault: string[];
  /** Same prefix, different secret_hex (repos). */
  secret_mismatch: string[];
  delegate_count: number;
  vault_count: number;
  /** Pages website signing keys (pages-delegate ↔ vault `pages` envelope). */
  pages: VaultEnvelopeSyncSlice;
}

function emptyPagesSlice(): VaultEnvelopeSyncSlice {
  return {
    kind: "in_sync",
    only_delegate: [],
    only_vault: [],
    secret_mismatch: [],
    delegate_count: 0,
    vault_count: 0,
  };
}

function combineSyncKinds(
  a: VaultDelegateSyncKind,
  b: VaultDelegateSyncKind,
): VaultDelegateSyncKind {
  if (a === "no_vault" || b === "no_vault") return "no_vault";
  if (a === "diverged" || b === "diverged") return "diverged";
  if (
    (a === "vault_behind" && b === "delegate_behind") ||
    (a === "delegate_behind" && b === "vault_behind")
  ) {
    return "diverged";
  }
  if (a === "vault_behind" || b === "vault_behind") return "vault_behind";
  if (a === "delegate_behind" || b === "delegate_behind") {
    return "delegate_behind";
  }
  return "in_sync";
}

function compareRepoMaps(
  delegate: Record<string, { secret_hex: string; label: string }>,
  vault: Record<string, { secret_hex: string; label: string }>,
): Pick<
  VaultEnvelopeSyncSlice,
  "only_delegate" | "only_vault" | "secret_mismatch" | "kind"
> {
  const only_delegate: string[] = [];
  const only_vault: string[] = [];
  const secret_mismatch: string[] = [];
  for (const prefix of Object.keys(delegate)) {
    if (!vault[prefix]) only_delegate.push(prefix);
    else if (
      vault[prefix]!.secret_hex.toLowerCase() !==
      delegate[prefix]!.secret_hex.toLowerCase()
    ) {
      secret_mismatch.push(prefix);
    }
  }
  for (const prefix of Object.keys(vault)) {
    if (!delegate[prefix]) only_vault.push(prefix);
  }
  only_delegate.sort();
  only_vault.sort();
  secret_mismatch.sort();
  let kind: VaultDelegateSyncKind = "in_sync";
  if (secret_mismatch.length > 0) kind = "diverged";
  else if (only_delegate.length && only_vault.length) kind = "diverged";
  else if (only_delegate.length) kind = "vault_behind";
  else if (only_vault.length) kind = "delegate_behind";
  return { only_delegate, only_vault, secret_mismatch, kind };
}

async function collectPagesMap(): Promise<
  Record<string, { secret_hex: string; label: string }>
> {
  try {
    const { nativeExportPagesKeys } = await import("./native-pages");
    const keys = await nativeExportPagesKeys();
    const out: Record<string, { secret_hex: string; label: string }> = {};
    for (const k of keys) {
      out[k.prefix] = { secret_hex: k.secret_hex, label: k.label };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Compare local forge-identity repo keys + pages-delegate keys with ForgeVault.
 * Uses the signed-in identity SK + identity_dek_wrap (no vault password).
 */
export async function compareVaultAndDelegate(): Promise<VaultDelegateSyncStatus> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  const delegateEarly = await collectReposMap();
  const pagesEarly = await collectPagesMap();
  const pagesEmpty = emptyPagesSlice();
  pagesEmpty.delegate_count = Object.keys(pagesEarly).length;
  if (!vault_id) {
    return {
      kind: "no_vault",
      vault_id: null,
      only_delegate: Object.keys(delegateEarly).sort(),
      only_vault: [],
      secret_mismatch: [],
      delegate_count: Object.keys(delegateEarly).length,
      vault_count: 0,
      pages: {
        ...pagesEmpty,
        only_delegate: Object.keys(pagesEarly).sort(),
        kind: Object.keys(pagesEarly).length ? "vault_behind" : "in_sync",
      },
    };
  }
  const delegate = delegateEarly;
  const state = await fetchForgeVault(vault_id).catch(() => null);
  if (!state?.identity_dek_wrap?.blob_b64) {
    return {
      kind: "no_vault",
      vault_id,
      only_delegate: Object.keys(delegate).sort(),
      only_vault: [],
      secret_mismatch: [],
      delegate_count: Object.keys(delegate).length,
      vault_count: 0,
      pages: {
        ...pagesEmpty,
        only_delegate: Object.keys(pagesEarly).sort(),
        kind: Object.keys(pagesEarly).length ? "vault_behind" : "in_sync",
      },
    };
  }
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const reposCmp = compareRepoMaps(delegate, secrets.repos);
  const pagesCmp = compareRepoMaps(pagesEarly, secrets.pages);
  const pagesSlice: VaultEnvelopeSyncSlice = {
    ...pagesCmp,
    delegate_count: Object.keys(pagesEarly).length,
    vault_count: Object.keys(secrets.pages).length,
  };
  return {
    ...reposCmp,
    kind: combineSyncKinds(reposCmp.kind, pagesCmp.kind),
    vault_id,
    delegate_count: Object.keys(delegate).length,
    vault_count: Object.keys(secrets.repos).length,
    pages: pagesSlice,
  };
}

/** Push current delegate repo + pages keys into ForgeVault (owner-signed). */
export async function pushDelegateReposToVault(): Promise<{
  vault_id: string;
  seq: number;
}> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  if (!vault_id) {
    throw new Error("enable Freenet vault backup first");
  }
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("no GitForge vault found for this identity");
  }
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const next = await buildOwnerEnvelopesUpdate({
  //   state,
  //   reposMap: await collectReposMap(),
  //   pagesMap: await collectPagesMap(),
  //   deks: secrets.deks,
  // });
  // NEW CODE - TESTING: also seal Settings → Backups prefs into settings envelope
  const { getBackupPrefs } = await import("./repo-backup");
  const { getProtectVaultIntent } = await import("./protect-prefs");
  const settingsPlain: SettingsEnvelopePlaintext = {
    ...secrets.settings,
    v: typeof secrets.settings.v === "number" ? secrets.settings.v : 1,
    repo_backup: getBackupPrefs(),
    local_protect: getProtectVaultIntent(),
  };
  const next = await buildOwnerEnvelopesUpdate({
    state,
    reposMap: await collectReposMap(),
    pagesMap: await collectPagesMap(),
    settingsPlain,
    deks: secrets.deks,
  });
  await putOrUpdateForgeVault(vault_id, next);
  return { vault_id, seq: next.seq };
}

/**
 * Seal backup prefs into ForgeVault `settings` envelope (best-effort).
 * Called when the user toggles Settings → Backups.
 */
export async function pushBackupPrefsToVault(
  prefs: SettingsEnvelopePlaintext["repo_backup"],
): Promise<void> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));
  if (!vault_id) return;
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) return;
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const settingsPlain: SettingsEnvelopePlaintext = {
    ...secrets.settings,
    v: typeof secrets.settings.v === "number" ? secrets.settings.v : 1,
    repo_backup: prefs ?? undefined,
  };
  const next = await buildOwnerEnvelopesUpdate({
    state,
    settingsPlain,
    deks: secrets.deks,
  });
  await putOrUpdateForgeVault(vault_id, next);
}

/**
 * Seal Protect prefs + remembered scopes into ForgeVault `settings` (best-effort).
 */
export async function pushProtectIntentToVault(
  intent: SettingsEnvelopePlaintext["local_protect"],
): Promise<void> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));
  if (!vault_id) return;
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) return;
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const settingsPlain: SettingsEnvelopePlaintext = {
    ...secrets.settings,
    v: typeof secrets.settings.v === "number" ? secrets.settings.v : 1,
    local_protect: intent ?? undefined,
  };
  const next = await buildOwnerEnvelopesUpdate({
    state,
    settingsPlain,
    deks: secrets.deks,
  });
  await putOrUpdateForgeVault(vault_id, next);
}

/** Read `settings.repo_backup` from the account vault (null if missing). */
export async function pullBackupPrefsFromVault(): Promise<
  SettingsEnvelopePlaintext["repo_backup"] | null
> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));
  if (!vault_id) return null;
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) return null;
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const rb = secrets.settings?.repo_backup;
  if (!rb || typeof rb !== "object") return null;
  return rb;
}

/** Read `settings.local_protect` from the account vault (null if missing). */
export async function pullProtectIntentFromVault(): Promise<
  SettingsEnvelopePlaintext["local_protect"] | null
> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));
  if (!vault_id) return null;
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) return null;
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const lp = secrets.settings?.local_protect;
  if (!lp || typeof lp !== "object") return null;
  return lp;
}

/**
 * Pull ForgeVault repos + pages into local delegates.
 * Does not remove local-only keys — use for delegate_behind / filling gaps.
 */
export async function pullVaultReposToDelegate(input?: {
  /** When true, overwrite local secrets that differ from vault. */
  overwriteMismatched?: boolean;
}): Promise<{ imported: number; updated: number; skipped: number }> {
  const overwriteMismatched = input?.overwriteMismatched ?? false;
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  if (!vault_id) {
    throw new Error("enable Freenet vault backup first");
  }
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("no GitForge vault found for this identity");
  }
  const secrets = await loadVaultSecretsViaIdentityWrap(state);
  const before = await collectReposMap();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const [prefix, repo] of Object.entries(secrets.repos)) {
    const local = before[prefix];
    if (!local) {
      await nativeImportRepoKey(prefix, repo.secret_hex, repo.label);
      imported += 1;
      continue;
    }
    if (
      local.secret_hex.toLowerCase() !== repo.secret_hex.toLowerCase()
    ) {
      if (overwriteMismatched) {
        await nativeImportRepoKey(prefix, repo.secret_hex, repo.label);
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    skipped += 1;
  }

  // NEW CODE - TESTING: pages website keys
  try {
    const { nativeImportPagesKey, nativeExportPagesKeys } = await import(
      "./native-pages"
    );
    const pagesBefore = await nativeExportPagesKeys();
    const beforeMap = new Map(
      pagesBefore.map((k) => [k.prefix, k.secret_hex.toLowerCase()]),
    );
    for (const [prefix, page] of Object.entries(secrets.pages)) {
      const localHex = beforeMap.get(prefix);
      if (!localHex) {
        await nativeImportPagesKey(prefix, page.secret_hex, page.label);
        imported += 1;
        continue;
      }
      if (localHex !== page.secret_hex.toLowerCase()) {
        if (overwriteMismatched) {
          await nativeImportPagesKey(prefix, page.secret_hex, page.label);
          updated += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      skipped += 1;
    }
  } catch (err) {
    console.warn(
      "[vault] pages pull skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // NEW CODE - TESTING: Settings → Backups prefs from settings envelope
  try {
    const rb = secrets.settings?.repo_backup;
    if (rb && typeof rb === "object") {
      const { applyBackupPrefsFromRemote } = await import("./repo-backup");
      applyBackupPrefsFromRemote({
        autoUpdateExisting: rb.autoUpdateExisting,
        autoBackupOwnRepos: rb.autoBackupOwnRepos,
        autoBackupStars: rb.autoBackupStars,
      });
    }
  } catch (err) {
    console.warn(
      "[vault] backup prefs pull skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  // NEW CODE - TESTING: Protect intent — conflict-aware hydrate (no stomp on diverge)
  try {
    const { hydrateProtectIntentFromVault } = await import("./protect-prefs");
    await hydrateProtectIntentFromVault();
  } catch (err) {
    console.warn(
      "[vault] protect intent pull skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  return { imported, updated, skipped };
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// async function applyPlaintextToDelegate(
//   plain: VaultPlaintext,
//   reposMap?: Record<string, { secret_hex: string; label: string }>,
// ): Promise<ForgeIdentityInfo> { … password-unlock import path … }
// NEW CODE - TESTING: restore uses nativeImportIdentity + ensureAccountContracts

function sanitizeBackupStem(alias: string): string | null {
  const sanitized = alias
    .split("")
    .map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "_"))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

export function identityBackupFilename(
  name: string,
  fingerprint: string,
): string {
  const stem =
    sanitizeBackupStem(name) ??
    fingerprintWords(fingerprint).slice(0, 2).join("-");
  return `gitforge-identity-${stem}.json`;
}

export function downloadJsonFile(filename: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadBytesFile(
  filename: string,
  bytes: Uint8Array,
  mime = "application/octet-stream",
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  downloadBlob(filename, new Blob([copy.buffer], { type: mime }));
}

function cacheFromForgeProfile(
  vault_id: string,
  profile: ForgeProfileStateJson,
  public_email_fallback: string,
): void {
  setCachedProfile({
    vault_id,
    bio: profile.bio ?? "",
    url: profile.url ?? "",
    avatar: profile.avatar ?? "",
    public_email: profile.public_email || public_email_fallback,
  });
}

/**
 * Load ForgeProfile for this fingerprint, or publish one from username/contact.
 * Create always publishes; restore prefers an existing profile so UI/delegate stay in sync.
 */
async function ensureForgeProfilePublished(input: {
  identity: ForgeIdentityInfo;
  vault_id: string;
  username: string;
  email: string;
}): Promise<ForgeIdentityInfo> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // .catch(() => null) swallowed Connection closed: 1006 → forced Put of wasm
  // NEW CODE - TESTING: only treat missing profile as absent
  let existing: ForgeProfileStateJson | null = null;
  try {
    existing = await fetchForgeProfile(input.identity.fingerprint, {
      reliable: true,
    });
  } catch (err) {
    if (!isWsDropError(err)) throw err;
    // One clean reconnect then re-check before deciding to Put.
    const { resetFreenetConn } = await import("./ws");
    resetFreenetConn();
    existing = await fetchForgeProfile(input.identity.fingerprint, {
      reliable: true,
    });
  }
  if (existing) {
    const username = existing.username.trim() || input.username;
    const email =
      existing.public_email.trim() ||
      input.email ||
      defaultContactFromFingerprint(input.identity.fingerprint);
    let identity = input.identity;
    if (
      username !== input.identity.name ||
      email !== (input.identity.email || "")
    ) {
      const exported = await nativeExportIdentity();
      identity = await nativeImportIdentity(
        exported.secret_key,
        username,
        email,
      );
      setCachedIdentity(identity);
    }
    // NEW CODE - TESTING: backfill inbox_pk on older profiles
    if (!existing.inbox_pk) {
      try {
        const exported = await nativeExportIdentity();
        const inbox_pk = inboxPkHexFromSeedHex(exported.secret_key);
        await publishForgeProfile({
          username,
          public_email: email,
          bio: existing.bio || "",
          url: existing.url || "",
          avatar: existing.avatar || "",
          inbox_pk,
          inbox_messages: existing.inbox_messages || [],
        });
      } catch (e) {
        console.warn("[auth] inbox_pk backfill failed:", e);
      }
    }
    cacheFromForgeProfile(input.vault_id, existing, email);
    return identity;
  }
  let inbox_pk = "";
  try {
    const exported = await nativeExportIdentity();
    inbox_pk = inboxPkHexFromSeedHex(exported.secret_key);
  } catch (e) {
    console.warn("[auth] inbox_pk derive failed:", e);
  }
  await publishForgeProfile({
    username: input.username,
    public_email: input.email,
    bio: "",
    url: "",
    avatar: "",
    inbox_pk,
    inbox_messages: [],
  });
  setCachedProfile({
    vault_id: input.vault_id,
    bio: "",
    url: "",
    avatar: "",
    public_email: input.email,
  });
  return input.identity;
}

async function refreshInboxFromProfile(
  fingerprint: string,
  seedHex: string,
): Promise<void> {
  try {
    const profile = await fetchForgeProfile(fingerprint, { reliable: true });
    if (!profile?.inbox_messages?.length) {
      setCachedInboxMessages([]);
      return;
    }
    const out: DecryptedInboxMessage[] = [];
    for (const msg of profile.inbox_messages) {
      try {
        const raw = openInboxMessage(seedHex, msg.ciphertext_b64);
        out.push({
          id: msg.id,
          created_at: msg.created_at,
          sender_vk: msg.sender_vk,
          raw,
          plaintext: parseInboxPlaintext(raw),
        });
      } catch (e) {
        out.push({
          id: msg.id,
          created_at: msg.created_at,
          sender_vk: msg.sender_vk,
          raw: null,
          plaintext: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    setCachedInboxMessages(out);
  } catch (e) {
    console.warn("[auth] inbox decrypt skipped:", e);
    clearCachedInbox();
  }
}

/**
 * Ensure profile (+ inbox) and passwordless vault exist.
 * syncFromVault: "pull" after recovery phrase; "none" after create/bundle.
 */
export async function ensureAccountContracts(input: {
  identity: ForgeIdentityInfo;
  vault_id: string;
  username: string;
  email: string;
  syncFromVault: "pull" | "none";
  onStatus?: (msg: string) => void;
}): Promise<ForgeIdentityInfo> {
  input.onStatus?.("Publishing profile (and inbox)…");
  let identity = await ensureForgeProfilePublished({
    identity: input.identity,
    vault_id: input.vault_id,
    username: input.username,
    email: input.email,
  });
  try {
    const exported = await nativeExportIdentity();
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // input.onStatus?.("Putting account vault…");
    // await ensurePasswordlessVault({...}); // single attempt, then warn
    // NEW CODE - TESTING: retry vault Put — important for create/restore + reload
    const maxAttempts = 3;
    let vaultErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        input.onStatus?.(
          attempt === 1
            ? "Putting account vault…"
            : `Retrying account vault Put (${attempt}/${maxAttempts})…`,
        );
        await ensurePasswordlessVault({
          vault_id: input.vault_id,
          username: identity.name || input.username,
          fingerprint: identity.fingerprint,
          seedHex: exported.secret_key,
        });
        vaultErr = null;
        break;
      } catch (e) {
        vaultErr = e;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }
    if (vaultErr) {
      throw vaultErr instanceof Error
        ? vaultErr
        : new Error(String(vaultErr));
    }
    try {
      input.onStatus?.("Decrypting inbox…");
      await refreshInboxFromProfile(identity.fingerprint, exported.secret_key);
    } catch (e) {
      console.warn("[auth] inbox decrypt skipped:", e);
    }
  } catch (e) {
    console.warn("[auth] ensure vault failed:", e);
    // Vault is required — surface to callers (create/restore UI + session retry)
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (input.syncFromVault === "pull") {
    try {
      input.onStatus?.("Pulling repo keys from vault…");
      await pullVaultReposToDelegate({ overwriteMismatched: true });
    } catch (e) {
      console.warn("[auth] vault→delegate pull skipped:", e);
    }
  }
  return identity;
}

/**
 * When signed in but ForgeVault ciphertext is missing (interrupted create/restore
 * or failed Put), re-attempt ensure with retries. Safe no-op if vault exists.
 */
export async function ensureSignedInAccountVault(opts?: {
  onStatus?: (msg: string) => void;
  maxAttempts?: number;
}): Promise<{ vaultEnabled: boolean; error?: string }> {
  const identity = getCachedIdentity() ?? (await currentIdentity());
  if (!identity) {
    return { vaultEnabled: false, error: "not signed in" };
  }
  const vault_id =
    getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));
  if (!vault_id) {
    return { vaultEnabled: false, error: "could not derive vault address" };
  }
  if (await probeVaultBackupEnabled(vault_id)) {
    return { vaultEnabled: true };
  }
  // ensureAccountContracts already retries Put; outer loop covers reload / flaky WS
  const maxAttempts = opts?.maxAttempts ?? 2;
  let lastError = "account vault Put failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      opts?.onStatus?.(
        attempt === 1
          ? "Account vault missing — creating on Freenet…"
          : `Retrying account vault ensure (${attempt}/${maxAttempts})…`,
      );
      await ensureAccountContracts({
        identity,
        vault_id,
        username: identity.name,
        email: identity.email || "",
        syncFromVault: "none",
        onStatus: opts?.onStatus,
      });
      if (await probeVaultBackupEnabled(vault_id)) {
        opts?.onStatus?.("Account vault ready.");
        return { vaultEnabled: true };
      }
      lastError = "vault Put completed but ciphertext not readable yet";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
  }
  return { vaultEnabled: false, error: lastError };
}

/** Put empty passwordless vault if missing; leave existing vault alone. */
export async function ensurePasswordlessVault(input: {
  vault_id: string;
  username: string;
  fingerprint: string;
  seedHex: string;
}): Promise<void> {
  const vault_id = normalizeVaultId(input.vault_id);
  const existing = await fetchForgeVault(vault_id).catch(() => null);
  if (existing?.identity_dek_wrap?.blob_b64) {
    setSessionVaultId(vault_id);
    return;
  }
  const reposMap = await collectReposMap();
  const state = await buildSignedVaultState({
    vault_id,
    username: input.username,
    fingerprint: input.fingerprint,
    seedHex: input.seedHex,
    reposMap,
    seq: 1,
  });
  await putOrUpdateForgeVault(vault_id, state);
  setSessionVaultId(vault_id);
}

export { listInboxPlaintexts };

/**
 * Create a local identity (Mail-style). Auto-ensures profile + vault.
 * Caller must download the returned freenet-git identity bundle before
 * treating setup as done.
 *
 * Contact string (`email` wire field) defaults to the six-word fingerprint slug
 * from the new fingerprint — git-author style metadata, not an inbox address.
 * Also publishes ForgeProfile (username + contact) so restore can find it later.
 */
export async function createIdentity(input: {
  username: string;
  /** Override contact string; omit to use fingerprint-word default. */
  email?: string;
  onStatus?: (msg: string) => void;
}): Promise<{
  identity: ForgeIdentityInfo;
  vault_id: string;
  fingerprint_words: string[];
  /** freenet-git CLI identity bundle — primary backup. */
  git_bundle: {
    bytes: Uint8Array;
    filename: string;
    passphrase: string;
  };
}> {
  const username = input.username.trim();
  if (!username) throw new Error("username is required");
  // NEW CODE - TESTING: cold peers need RegisterDelegate before ImportIdentity
  await ensureOwnerDelegatesReady(input.onStatus);
  input.onStatus?.("Generating seed…");
  const seed_hex = generateSeedHex();
  const vault_id = vaultIdFromSeedHex(seed_hex);
  const fingerprint = fingerprintFromSeedHex(seed_hex);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const email = input.email ? normalizeEmail(input.email) : "";
  // NEW CODE - TESTING: default contact = fingerprint-word slug
  const email = input.email?.trim()
    ? normalizeEmail(input.email)
    : defaultContactFromFingerprint(fingerprint);
  input.onStatus?.("Importing identity onto this node…");
  let identity = await nativeImportIdentity(seed_hex, username, email);
  setSessionVaultId(vault_id);
  setCachedIdentity(identity);
  setCachedSeedHex(seed_hex);
  setVaultNeedsTotpEnroll(false);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // identity = await ensureForgeProfilePublished(...); // no vault Put
  // NEW CODE - TESTING: profile + passwordless vault; no vault→delegate pull
  identity = await ensureAccountContracts({
    identity,
    vault_id,
    username,
    email,
    syncFromVault: "none",
    onStatus: input.onStatus,
  });
  try {
    const { rememberPersonFingerprint } = await import("./people-resolve");
    rememberPersonFingerprint(identity.fingerprint);
  } catch {
    /* ignore */
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // proprietary JSON IdentityExportBundle + BIP-39 recovery_phrase as primary backup
  // NEW CODE - TESTING: freenet-git identity.bundle is the backup (same as CLI)
  input.onStatus?.("Sealing identity bundle…");
  const passphrase = mintBundlePassphrase();
  const bytes = sealFreenetGitIdentityBundle({
    secret_key_hex: seed_hex,
    public_key_b58: identity.public_key_b58,
    name: identity.name,
    email: identity.email || email,
    repos: [],
    passphrase,
  });
  return {
    identity,
    vault_id,
    fingerprint_words: fingerprintWords(identity.fingerprint),
    git_bundle: {
      bytes,
      filename: freenetGitBundleFilename(identity.name, identity.fingerprint),
      passphrase,
    },
  };
}

/**
 * Import a freenet-git `git-identity.bundle` (same file as CLI
 * `import-identity` / `init-identity` export).
 * Prefer an existing ForgeProfile for username/contact; publish one if missing.
 */
export async function importFreenetGitIdentityBundle(input: {
  bytes: Uint8Array;
  passphrase: string;
  onStatus?: (msg: string) => void;
}): Promise<ForgeIdentityInfo> {
  // NEW CODE - TESTING: cold peers need RegisterDelegate before ImportIdentity
  await ensureOwnerDelegatesReady(input.onStatus);
  input.onStatus?.("Opening identity bundle…");
  const opened = openFreenetGitIdentityBundle(input.bytes, input.passphrase);
  const fallbackEmail = opened.email.trim()
    ? normalizeEmail(opened.email) || opened.email.trim()
    : defaultContactFromFingerprint(opened.fingerprint);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always imported bundle name/email only — never looked up ForgeProfile.
  // NEW CODE - TESTING: ForgeProfile is source of truth when present
  input.onStatus?.("Looking up public profile…");
  let existingProfile: ForgeProfileStateJson | null = null;
  try {
    existingProfile = await fetchForgeProfile(opened.fingerprint, {
      reliable: true,
    });
  } catch (err) {
    if (!isWsDropError(err)) throw err;
    const { resetFreenetConn } = await import("./ws");
    resetFreenetConn();
    existingProfile = await fetchForgeProfile(opened.fingerprint, {
      reliable: true,
    });
  }
  const username =
    existingProfile?.username?.trim() || opened.name || "user";
  const email =
    existingProfile?.public_email?.trim() || fallbackEmail;
  input.onStatus?.("Importing identity onto this node…");
  let identity = await nativeImportIdentity(
    opened.secret_key_hex,
    username,
    email,
  );
  for (const repo of opened.repos) {
    await nativeImportRepoKey(repo.prefix, repo.secret_hex, repo.label);
  }
  let vault_id = "";
  try {
    vault_id = vaultIdFromSeedHex(opened.secret_key_hex);
    setSessionVaultId(vault_id);
  } catch {
    /* secret may not be a 32-byte seed in exotic bundles */
  }
  setCachedIdentity(identity);
  setCachedSeedHex(opened.secret_key_hex);
  identity = await ensureAccountContracts({
    identity,
    vault_id,
    username,
    email,
    syncFromVault: "none",
    onStatus: input.onStatus,
  });
  try {
    const { rememberPersonFingerprint } = await import("./people-resolve");
    rememberPersonFingerprint(identity.fingerprint);
  } catch {
    /* ignore */
  }
  return identity;
}

/**
 * While signed in: merge freenet-git bundle repo keys into the local delegate
 * when the bundle fingerprint matches. Refuse a different identity.
 *
 * ForgeVault auto-update: if vault backup is enabled, compare vault↔delegate
 * **before** the merge (via identity_dek_wrap). Auto-push to vault only when
 * they were already `in_sync`. If there was drift/conflict, the delegate still
 * receives new keys but vault is left alone for the user to resolve in Settings.
 */
export async function mergeFreenetGitIdentityBundle(input: {
  bytes: Uint8Array;
  passphrase: string;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // vaultPassword?: string;
  // totpCode?: string;
}): Promise<{
  identity: ForgeIdentityInfo;
  imported: number;
  skipped: number;
  vaultUpdated: boolean;
  /** Pre-merge vault↔delegate status when a vault was present. */
  syncBefore: VaultDelegateSyncKind | null;
  /** True when vault was not auto-updated because of pre-existing drift. */
  vaultSkippedDueToConflict: boolean;
}> {
  const current = getCachedIdentity() ?? (await nativeGetIdentity());
  if (!current) {
    throw new Error("sign in before merging a freenet-git identity bundle");
  }
  const opened = openFreenetGitIdentityBundle(input.bytes, input.passphrase);
  if (opened.fingerprint !== current.fingerprint) {
    throw new Error(
      "bundle identity does not match the signed-in account — sign out to restore a different identity",
    );
  }

  let syncBefore: VaultDelegateSyncKind | null = null;
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (vault_id && input.vaultPassword) { compare with password... }
  // NEW CODE - TESTING: identity unwrap when vault exists
  if (vault_id) {
    try {
      const status = await compareVaultAndDelegate();
      syncBefore = status.kind;
    } catch {
      syncBefore = null;
    }
  }

  const before = await nativeExportRepos();
  const beforeSet = new Set(before.map((r) => r.prefix));
  let imported = 0;
  let skipped = 0;
  for (const repo of opened.repos) {
    if (beforeSet.has(repo.prefix)) {
      skipped += 1;
      continue;
    }
    await nativeImportRepoKey(repo.prefix, repo.secret_hex, repo.label);
    imported += 1;
  }

  let vaultUpdated = false;
  let vaultSkippedDueToConflict = false;
  if (vault_id && syncBefore !== null) {
    if (syncBefore === "in_sync") {
      await pushDelegateReposToVault();
      vaultUpdated = true;
    } else if (syncBefore !== "no_vault") {
      vaultSkippedDueToConflict = true;
    }
  }

  const identity = getCachedIdentity() ?? current;
  return {
    identity,
    imported,
    skipped,
    vaultUpdated,
    syncBefore,
    vaultSkippedDueToConflict,
  };
}

export async function listVaultApiKeys(): Promise<VaultApiKeyWrap[]> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  if (!vault_id) return [];
  const state = await fetchForgeVault(vault_id).catch(() => null);
  return state?.api_key_wraps ?? [];
}

/**
 * Mint a named vault API key while signed in (identity only).
 * Returns the raw secret once — it is never stored.
 * Wraps scoped envelope DEKs + a per-key ops signer.
 */
export async function mintVaultApiKey(input: {
  name: string;
  scopes?: VaultApiKeyScope[];
}): Promise<{ apiKey: string; wrap: VaultApiKeyWrap; vault_id: string }> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  if (!vault_id) {
    throw new Error("GitForge vault required before minting API keys");
  }
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("GitForge vault required before minting API keys");
  }
  const exported = await nativeExportIdentity();
  const { deks, repos } = await loadReposViaIdentityWrap(state);
  const scopes = normalizeScopes(
    (input.scopes?.length ? input.scopes : [ENVELOPE_REPOS]) as string[],
  );
  const scopedDeks: Record<string, string> = {};
  for (const s of scopes) {
    const d = deks[s];
    if (!d) throw new Error(`vault missing envelope DEK for scope ${s}`);
    scopedDeks[s] = d;
  }
  const apiKey = mintVaultApiKeySecret();
  const id = bytesToHex(randomBytes(8));
  const { skHex, vkB58 } = generateOpsKeypair();
  const wrap = await wrapApiKeyPayload({
    apiKey,
    payload: { deks: scopedDeks, ops_sk_hex: skHex },
    id,
    name: input.name,
    scopes,
    ops_vk_b58: vkB58,
  });
  const wraps = [...(state.api_key_wraps ?? []).filter((w) => w.id !== id), wrap];
  const authEntry: AuthorizedOps = {
    id,
    ops_vk_b58: vkB58,
    scopes,
    created_at: wrap.created_at,
  };
  const authorized_ops = [
    ...(state.authorized_ops ?? []).filter((o) => o.id !== id),
    authEntry,
  ];
  const next = await buildSignedVaultState({
    vault_id,
    username: state.username,
    fingerprint: state.identity_fingerprint,
    seedHex: exported.secret_key,
    reposMap: repos,
    seq: state.seq + 1,
    api_key_wraps: wraps,
    authorized_ops,
    identity_dek_wrap: state.identity_dek_wrap,
    envelope_deks: deks,
  });
  await putOrUpdateForgeVault(vault_id, next);
  return { apiKey, wrap, vault_id };
}

export async function revokeVaultApiKey(input: {
  id: string;
}): Promise<void> {
  const vault_id = getSessionVaultId() || (await ensureSessionVaultId());
  if (!vault_id) throw new Error("GitForge vault required");
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("GitForge vault required");
  }
  const exported = await nativeExportIdentity();
  const { deks, repos } = await loadReposViaIdentityWrap(state);
  const wraps = (state.api_key_wraps ?? []).filter((w) => w.id !== input.id);
  const authorized_ops = (state.authorized_ops ?? []).filter(
    (o) => o.id !== input.id,
  );
  const next = await buildSignedVaultState({
    vault_id,
    username: state.username,
    fingerprint: state.identity_fingerprint,
    seedHex: exported.secret_key,
    reposMap: repos,
    seq: state.seq + 1,
    api_key_wraps: wraps.length ? wraps : undefined,
    authorized_ops: authorized_ops.length ? authorized_ops : undefined,
    identity_dek_wrap: state.identity_dek_wrap,
    envelope_deks: deks,
  });
  await putOrUpdateForgeVault(vault_id, next);
}

async function unlockReposEnvelopeWithApiKey(input: {
  vault_id: string;
  apiKey: string;
}): Promise<{
  state: ForgeVaultPublicState;
  wrap: VaultApiKeyWrap;
  dek: string;
  ops_sk_hex: string;
  repos: Record<string, { secret_hex: string; label: string }>;
}> {
  const vault_id = normalizeVaultId(input.vault_id);
  const state = await fetchForgeVault(vault_id);
  if (!state?.identity_dek_wrap?.blob_b64) {
    throw new Error("no GitForge vault for this vault id");
  }
  const wrap = findApiKeyWrap(state.api_key_wraps, input.apiKey);
  if (!wrap) throw new Error("API key not recognized for this vault");
  const payload = await unwrapApiKeyPayload(input.apiKey, wrap);
  const dek = payload.deks[ENVELOPE_REPOS];
  if (!dek || !payload.ops_sk_hex) {
    throw new Error("API key wrap missing repos DEK or ops key");
  }
  const cipher = state.envelopes?.[ENVELOPE_REPOS];
  if (!cipher) throw new Error("vault missing repos envelope");
  const env = decryptEnvelopeWithDek<ReposEnvelopePlaintext>(dek, cipher);
  return {
    state,
    wrap,
    dek,
    ops_sk_hex: payload.ops_sk_hex,
    repos: env.repos ?? {},
  };
}

export async function unlockVaultPlaintextWithApiKey(input: {
  vault_id: string;
  apiKey: string;
}): Promise<{
  state: ForgeVaultPublicState;
  wrap: VaultApiKeyWrap;
  repos: Record<string, { secret_hex: string; label: string }>;
}> {
  const r = await unlockReposEnvelopeWithApiKey(input);
  return { state: r.state, wrap: r.wrap, repos: r.repos };
}

/**
 * Put / update ForgeVault for the current identity. Requires password ≥12 and
 * a confirmed TOTP secret (caller verifies a live code before calling).
 */
/** @deprecated Password vault enable removed — use ensureAccountContracts. */
export async function enableVaultBackup(_input?: {
  password?: string;
  totpSecretB32?: string;
  totpCode?: string;
  email?: string;
  bio?: string;
  url?: string;
  avatar?: string;
}): Promise<{ vault_id: string; otpauth: string }> {
  const exported = await nativeExportIdentity();
  const vault_id = vaultIdFromSeedHex(exported.secret_key);
  await ensurePasswordlessVault({
    vault_id,
    username: exported.name || "user",
    fingerprint: fingerprintFromSeedHex(exported.secret_key),
    seedHex: exported.secret_key,
  });
  setVaultNeedsTotpEnroll(false);
  return { vault_id, otpauth: "" };
}

/** @deprecated Vault password unlock removed — restore with bundle or recovery phrase. */
export async function unlockVault(_input: {
  vaultId: string;
  password: string;
  totpCode?: string;
}): Promise<ForgeIdentityInfo> {
  throw new Error(
    "Vault password unlock was removed. Restore with your identity bundle or recovery phrase.",
  );
}

export async function updatePublicProfile(input: {
  vault_id?: string;
  name?: string;
  email?: string;
  bio?: string;
  url?: string;
  avatar?: string;
  /** Optional status text (public_meta.status). */
  statusText?: string;
  statusEmoji?: string;
  /** Optional pinned repo prefixes (public_meta.pinned). */
  pinnedPrefixes?: string[];
  onStatus?: (msg: string) => void;
}): Promise<ForgeIdentityInfo> {
  const vault_id = input.vault_id
    ? normalizeVaultId(input.vault_id)
    : getSessionVaultId() ?? "";

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Required full form fields every save.
  // NEW CODE - TESTING: allow pin/status-only updates (merge identity + ForgeProfile)
  input.onStatus?.("Updating local identity…");
  const current = await nativeGetIdentity();
  if (!current) throw new Error("sign in required");

  const {
    encodePinnedPrefixes,
    encodeProfileStatus,
    fetchForgeProfile,
    PROFILE_META_PINNED,
    PROFILE_META_STATUS,
    publishForgeProfile,
  } = await import("./forge-profile");
  const existing = await fetchForgeProfile(current.fingerprint, {
    reliable: true,
  });

  const name = (input.name ?? current.name ?? existing?.username ?? "").trim();
  if (!name) throw new Error("name is required");
  const email = normalizeEmail(
    input.email ?? current.email ?? existing?.public_email ?? "",
  );
  const bio = (input.bio ?? existing?.bio ?? "").trim().slice(0, 512);
  const url = (input.url ?? existing?.url ?? "").trim().slice(0, 512);
  const avatarNormalized = normalizeProfileAvatar(
    (input.avatar ?? existing?.avatar ?? "").slice(0, 48_000),
  );

  let identity: ForgeIdentityInfo;
  if (current.name === name && (current.email || "") === email) {
    identity = current;
  } else {
    const exported = await nativeExportIdentity();
    identity = await nativeImportIdentity(exported.secret_key, name, email);
  }

  input.onStatus?.("Signing and putting profile…");
  const public_meta: Record<string, string> = {
    ...(existing?.public_meta ?? {}),
  };
  if (input.statusText !== undefined) {
    const text = input.statusText.trim();
    if (text || (input.statusEmoji ?? "").trim()) {
      public_meta[PROFILE_META_STATUS] = encodeProfileStatus({
        text,
        emoji: input.statusEmoji ?? "",
      });
    } else {
      delete public_meta[PROFILE_META_STATUS];
    }
  }
  if (input.pinnedPrefixes !== undefined) {
    const pinned = input.pinnedPrefixes
      .map((p) => p.trim())
      .filter(Boolean);
    if (pinned.length) {
      public_meta[PROFILE_META_PINNED] = encodePinnedPrefixes(pinned);
    } else {
      delete public_meta[PROFILE_META_PINNED];
    }
  }
  await publishForgeProfile({
    username: name,
    public_email: email,
    bio,
    url,
    avatar: avatarNormalized,
    public_meta,
  });

  // NEW CODE - TESTING: Discover/About resolve names from ForgeProfile cache
  try {
    const { invalidatePersonDisplayName } = await import("./person-display");
    invalidatePersonDisplayName(identity.fingerprint);
  } catch {
    /* ignore */
  }

  if (vault_id) setSessionVaultId(vault_id);
  setCachedIdentity(identity);
  setCachedProfile({
    vault_id,
    bio,
    url,
    avatar: avatarNormalized,
    public_email: email,
  });
  return identity;
}

/** Load public profile fields (ForgeProfile on Freenet; cache for self). */
export async function loadPublicProfile(
  fingerprintOrVaultId: string,
): Promise<{
  bio: string;
  url: string;
  avatar: string;
  public_email: string;
  username: string;
  statusText: string;
  statusEmoji: string;
  pinnedPrefixes: string[];
} | null> {
  const cached = getCachedProfile();
  const id = getCachedIdentity();
  const looksLikeFingerprint = fingerprintOrVaultId.startsWith("freenet:id:");
  const {
    parsePinnedPrefixes,
    parseProfileStatus,
  } = await import("./forge-profile");

  const emptyMeta = {
    statusText: "",
    statusEmoji: "",
    pinnedPrefixes: [] as string[],
  };

  if (
    cached &&
    id &&
    looksLikeFingerprint &&
    id.fingerprint.toLowerCase() === fingerprintOrVaultId.toLowerCase()
  ) {
    const state = await fetchForgeProfile(id.fingerprint).catch(() => null);
    const status = parseProfileStatus(state?.public_meta);
    return {
      bio: cached.bio,
      url: cached.url,
      avatar: normalizeProfileAvatar(cached.avatar),
      public_email: cached.public_email,
      username: id.name ?? "",
      statusText: status?.text ?? "",
      statusEmoji: status?.emoji ?? "",
      pinnedPrefixes: parsePinnedPrefixes(state?.public_meta),
    };
  }
  if (
    cached &&
    !looksLikeFingerprint &&
    normalizeVaultId(cached.vault_id) ===
      normalizeVaultId(fingerprintOrVaultId)
  ) {
    const state = id
      ? await fetchForgeProfile(id.fingerprint).catch(() => null)
      : null;
    const status = parseProfileStatus(state?.public_meta);
    return {
      bio: cached.bio,
      url: cached.url,
      avatar: normalizeProfileAvatar(cached.avatar),
      public_email: cached.public_email,
      username: id?.name ?? "",
      statusText: status?.text ?? "",
      statusEmoji: status?.emoji ?? "",
      pinnedPrefixes: parsePinnedPrefixes(state?.public_meta),
    };
  }

  const fp = looksLikeFingerprint
    ? fingerprintOrVaultId
    : id?.fingerprint ?? null;
  if (!fp) {
    return {
      bio: "",
      url: "",
      avatar: "",
      public_email: "",
      username: "",
      ...emptyMeta,
    };
  }

  const state = await fetchForgeProfile(fp).catch(() => null);
  if (!state) {
    return {
      bio: "",
      url: "",
      avatar: "",
      public_email: "",
      username: id?.name ?? "",
      ...emptyMeta,
    };
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // avatar: state.avatar — could be a frozen SVG/generated data-URL
  // NEW CODE - TESTING: only treat raster uploads as custom avatar
  const avatar = normalizeProfileAvatar(state.avatar);
  if (id && id.fingerprint.toLowerCase() === fp.toLowerCase()) {
    setCachedProfile({
      vault_id: getSessionVaultId() ?? cached?.vault_id ?? "",
      bio: state.bio,
      url: state.url,
      avatar,
      public_email: state.public_email,
    });
  }
  const status = parseProfileStatus(state.public_meta);
  return {
    bio: state.bio,
    url: state.url,
    avatar,
    public_email: state.public_email,
    username: state.username,
    statusText: status?.text ?? "",
    statusEmoji: status?.emoji ?? "",
    pinnedPrefixes: parsePinnedPrefixes(state.public_meta),
  };
}

/** @deprecated Vault password change removed (passwordless vault). */
export async function changePassword(_input: {
  oldPassword: string;
  newPassword: string;
  totpCode?: string;
}): Promise<void> {
  throw new Error("Vault password was removed — GitForge vault is identity-gated.");
}


/** @deprecated Use restoreFromRecoveryPhrase instead. */
export async function recoverWithPhrase(input: {
  phrase: string;
  newPassword?: string;
  totpSecretB32?: string;
  totpCode?: string;
  username?: string;
  email?: string;
}): Promise<{
  identity: ForgeIdentityInfo;
  recovery_phrase: string;
  vault_id: string;
}> {
  const identity = await restoreFromRecoveryPhrase({
    phrase: input.phrase,
    username: input.username,
  });
  const vault_id =
    getSessionVaultId() || vaultIdFromSeedHex(seedHexFromPhrase(input.phrase));
  return {
    identity,
    recovery_phrase: phraseFromSeedHex(seedHexFromPhrase(input.phrase)),
    vault_id,
  };
}

/** @deprecated Use revealSessionRecoveryPhrase (no vault password). */
export async function revealRecoveryPhrase(_input: {
  vault_id: string;
  password: string;
  totpCode?: string;
}): Promise<string> {
  return revealSessionRecoveryPhrase();
}

/**
 * Reveal the 24-word phrase from the signed-in delegate seed.
 * Same material as "Download identity backup" — no vault password needed.
 */
export async function revealSessionRecoveryPhrase(): Promise<string> {
  const exported = await nativeExportIdentity();
  if (!exported?.secret_key) {
    throw new Error("no local identity to reveal — create or restore first");
  }
  return phraseFromSeedHex(exported.secret_key);
}

/**
 * Restore / log in from the 24-word BIP-39 phrase (no JSON file).
 * Prefer ForgeProfile username/contact; fall back to vault public username,
 * then publish ForgeProfile if Freenet has none yet.
 */
export async function restoreFromRecoveryPhrase(input: {
  phrase: string;
  username?: string;
  onStatus?: (msg: string) => void;
}): Promise<ForgeIdentityInfo> {
  // NEW CODE - TESTING: cold peers need RegisterDelegate before ImportIdentity
  await ensureOwnerDelegatesReady(input.onStatus);
  input.onStatus?.("Parsing recovery phrase…");
  const seed_hex = seedHexFromPhrase(input.phrase);
  const vault_id = vaultIdFromSeedHex(seed_hex);
  const fingerprint = fingerprintFromSeedHex(seed_hex);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const existing = await fetchForgeVault(vault_id).catch(() => null);
  // const username = input.username?.trim() || existing?.username || "user";
  // const email = defaultContactFromFingerprint(fingerprint);
  // NEW CODE - TESTING: ForgeProfile first (expected once create published it)
  input.onStatus?.("Looking up public profile…");
  let existingProfile: ForgeProfileStateJson | null = null;
  try {
    existingProfile = await fetchForgeProfile(fingerprint, { reliable: true });
  } catch (err) {
    if (!isWsDropError(err)) throw err;
    const { resetFreenetConn } = await import("./ws");
    resetFreenetConn();
    existingProfile = await fetchForgeProfile(fingerprint, { reliable: true });
  }
  const existingVault = existingProfile
    ? null
    : await fetchForgeVault(vault_id).catch(() => null);
  const username =
    existingProfile?.username?.trim() ||
    input.username?.trim() ||
    existingVault?.username ||
    "user";
  const email =
    existingProfile?.public_email?.trim() ||
    defaultContactFromFingerprint(fingerprint);
  input.onStatus?.("Importing identity onto this node…");
  let identity = await nativeImportIdentity(seed_hex, username, email);
  setSessionVaultId(vault_id);
  setCachedIdentity(identity);
  setCachedSeedHex(seed_hex);
  identity = await ensureAccountContracts({
    identity,
    vault_id,
    username,
    email,
    syncFromVault: "pull",
    onStatus: input.onStatus,
  });
  try {
    const { rememberPersonFingerprint } = await import("./people-resolve");
    rememberPersonFingerprint(identity.fingerprint);
  } catch {
    /* ignore */
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await pullVaultReposToDelegate(...) here separately
  // NEW CODE - TESTING: pull is inside ensureAccountContracts(syncFromVault: pull)
  return identity;
}

export async function logoutAccount(): Promise<void> {
  await nativeLogout();
  setSessionVaultId(null);
  setCachedIdentity(null);
  setCachedProfile(null);
  setVaultNeedsTotpEnroll(false);
  setCachedSeedHex(null);
  clearCachedInbox();
}

/**
 * Sign out with a confirm when repo backups are pinned on the identity
 * delegate — Logout clears that session and those pins go with it.
 * Returns false if the user cancelled.
 */
export async function confirmAndLogoutAccount(): Promise<boolean> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await logoutAccount(); // no warning — wiped delegate backups silently
  // NEW CODE - TESTING: warn when backup pins exist on this device
  let backupCount = 0;
  try {
    const { countRepoBackupPins } = await import("./repo-backup");
    backupCount = await countRepoBackupPins();
  } catch {
    backupCount = 0;
  }
  if (backupCount > 0) {
    const ok = window.confirm(
      `Sign out will clear ${backupCount} repo backup pin${
        backupCount === 1 ? "" : "s"
      } and their tip pack bytes stored on this device’s identity delegate.\n\n` +
        "Those backups (tip pack bytes + pin index) are tied to the signed-in identity session. " +
        "After you sign back in, Backups settings (auto-backup my repos / starred repos) " +
        "can recreate them in the background while tip packs are still reachable.\n\n" +
        "Your downloadable freenet-git identity bundle is separate and is not deleted by sign-out.\n\n" +
        "Sign out anyway?",
    );
    if (!ok) return false;
  }
  await logoutAccount();
  return true;
}

/** Re-fetch profile inbox and decrypt into session cache. */
export async function refreshInboxSession(): Promise<DecryptedInboxMessage[]> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const exported = await nativeExportIdentity();
  // const id = await nativeGetIdentity();
  // if (!id) { clearCachedInbox(); return []; }
  // await refreshInboxFromProfile(id.fingerprint, exported.secret_key);
  // return listInboxPlaintexts();
  // NEW CODE - TESTING: prefer session cache; retry seed export on WS 1006;
  // soft-fail to cached inbox instead of hard-failing the page.
  const id =
    getCachedIdentity() ??
    (await nativeGetIdentity().catch(() => null));
  if (!id) {
    clearCachedInbox();
    return [];
  }
  setCachedIdentity(id);
  try {
    const seed = await exportIdentitySeed();
    await refreshInboxFromProfile(id.fingerprint, seed);
    return listInboxPlaintexts();
  } catch (e) {
    const cached = listInboxPlaintexts();
    if (isWsDropError(e)) {
      console.warn("[auth] inbox refresh WS drop:", e);
      if (cached.length > 0) return cached;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export interface InboxDoneItem {
  id: string;
  kind: string;
  summary: string;
  at: string;
  outcome: "accepted" | "denied";
}

const INBOX_DONE_KEY = "gitforge.inbox-done.v1";

function readInboxDone(): InboxDoneItem[] {
  try {
    const raw = localStorage.getItem(INBOX_DONE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as InboxDoneItem[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeInboxDone(items: InboxDoneItem[]): void {
  try {
    localStorage.setItem(INBOX_DONE_KEY, JSON.stringify(items.slice(0, 100)));
  } catch {
    /* sandbox */
  }
}

export function listInboxDone(): InboxDoneItem[] {
  return readInboxDone();
}

function recordInboxDone(item: InboxDoneItem): void {
  const prev = readInboxDone().filter((d) => d.id !== item.id);
  writeInboxDone([item, ...prev]);
}

export async function acceptRepoInvite(messageId: string): Promise<void> {
  const { pruneInboxMessages } = await import("./forge-profile");
  const invite = await import("./repo-invite");
  const { fetchForgeRegistry } = await import("./forge-registry");
  const msgs = listInboxPlaintexts();
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg?.plaintext || msg.plaintext.kind !== invite.REPO_INVITE_KIND) {
    throw new Error("Invite not found or undecryptable");
  }
  const body = msg.plaintext.body as import("./repo-invite").RepoInviteBody;
  if (!body?.prefix || !body?.secret_hex) {
    throw new Error("Invite missing site key");
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // ImportRepoKey then nativeAddContributor (self dual-sig after having key)
  // NEW CODE - TESTING: owner coupon → registry Put first → then import secret
  const coupon = body.coupon;
  if (
    !coupon?.repo_owner_sig ||
    !coupon.identity_fingerprint ||
    !coupon.repo_owner_vk ||
    !coupon.repo_prefix
  ) {
    throw new Error(
      "This invite has no owner coupon — ask the owner to re-send the invite from the latest GitForge",
    );
  }

  const self = await nativeGetIdentity();
  if (!self) throw new Error("Sign in before accepting an invite");
  if (coupon.identity_fingerprint !== self.fingerprint) {
    throw new Error(
      "This invite was issued for a different GitForge identity — cannot accept",
    );
  }
  if (coupon.repo_prefix !== body.prefix) {
    throw new Error("Invite coupon prefix does not match sealed site key");
  }

  const registry = await fetchForgeRegistry();
  const listing = registry.repos.find((r) => r.repo_prefix === body.prefix);
  if (!listing) {
    throw new Error(
      "This repository is not listed on GitForge — ask the owner to Register before accepting",
    );
  }
  const ownerVk = listing.identity_fingerprint.replace(/^freenet:id:/, "");
  if (!msg.sender_vk || msg.sender_vk !== ownerVk) {
    throw new Error(
      "Invite sender does not match the GitForge registry owner for this repository — refusing site key",
    );
  }
  if (coupon.repo_owner_vk !== listing.repo_owner_vk) {
    throw new Error(
      "Invite coupon repo_owner_vk does not match the live GitForge listing",
    );
  }
  if (listing.identity_fingerprint === self.fingerprint) {
    throw new Error("You are already the registry owner of this repository");
  }

  const already =
    registry.contributors?.[body.prefix]?.[self.fingerprint] != null;
  if (!already) {
    await nativeAcceptContributorCoupon(coupon);
  }

  const syncBefore = await compareVaultAndDelegate().catch(() => null);
  await nativeImportRepoKey(
    body.prefix,
    body.secret_hex,
    body.label || body.repo_name || body.prefix,
  );
  if (syncBefore?.kind === "in_sync") {
    try {
      await pushDelegateReposToVault();
    } catch (e) {
      console.warn("[auth] vault auto-push after invite accept skipped:", e);
    }
  }
  await pruneInboxMessages([messageId]);
  await refreshInboxSession().catch(() => undefined);
  recordInboxDone({
    id: messageId,
    kind: invite.REPO_INVITE_KIND,
    summary: `Accepted contributor + site key for ${body.repo_name || body.label || body.prefix}`,
    at: new Date().toISOString(),
    outcome: "accepted",
  });
}

/**
 * Contributor opt-out: remove verified grant, drop local site key, push vault when possible.
 */
export async function leaveRepositoryAsContributor(
  prefix: string,
): Promise<{ vaultPushed: boolean }> {
  const id = await nativeGetIdentity();
  if (!id) throw new Error("Sign in before leaving a repository");

  const { fetchForgeRegistry } = await import("./forge-registry");
  const registry = await fetchForgeRegistry();
  const listing = registry.repos.find((r) => r.repo_prefix === prefix);
  if (listing?.identity_fingerprint === id.fingerprint) {
    throw new Error(
      "You are the registry owner — unregister or transfer ownership instead of leaving as a contributor",
    );
  }
  const grant = registry.contributors?.[prefix]?.[id.fingerprint];
  if (!grant) {
    throw new Error("You are not listed as a verified contributor on this repository");
  }

  await nativeRemoveContributor({ prefix });
  await nativeRemoveRepoKey(prefix);

  let vaultPushed = false;
  try {
    // Local key is gone — push so vault ciphertext drops this site key too.
    await pushDelegateReposToVault();
    vaultPushed = true;
  } catch (e) {
    console.warn("[auth] vault sync after leave skipped:", e);
  }
  return { vaultPushed };
}

export async function denyRepoInvite(messageId: string): Promise<void> {
  const { pruneInboxMessages } = await import("./forge-profile");
  const invite = await import("./repo-invite");
  const { nativeDeclinePendingInvite } = await import("./owner-api");
  const { fetchForgeRegistry } = await import("./forge-registry");
  const msgs = listInboxPlaintexts();
  const msg = msgs.find((m) => m.id === messageId);
  const body =
    msg?.plaintext?.kind === invite.REPO_INVITE_KIND
      ? (msg.plaintext.body as import("./repo-invite").RepoInviteBody)
      : null;
  // NEW CODE - TESTING: clear repo-level pending invite on ForgeRegistry first
  if (body?.prefix) {
    const self = getCachedIdentity();
    const inviteeFp =
      self?.fingerprint || body.coupon?.identity_fingerprint || "";
    const repoOwnerVk =
      body.coupon?.repo_owner_vk ||
      (
        await fetchForgeRegistry().catch(() => null)
      )?.repos.find((r) => r.repo_prefix === body.prefix)?.repo_owner_vk ||
      "";
    if (inviteeFp && repoOwnerVk) {
      try {
        await nativeDeclinePendingInvite({
          prefix: body.prefix,
          inviteeFingerprint: inviteeFp,
          repoOwnerVk,
        });
      } catch (e) {
        console.warn("[auth] ForgeRegistry pending invite decline failed:", e);
        throw e instanceof Error
          ? e
          : new Error(String(e));
      }
    }
  }
  await pruneInboxMessages([messageId]);
  await refreshInboxSession().catch(() => undefined);
  recordInboxDone({
    id: messageId,
    kind: msg?.plaintext?.kind || "unknown",
    summary: body
      ? `Declined invite for ${body.repo_name || body.label || body.prefix}`
      : "Declined inbox message",
    at: new Date().toISOString(),
    outcome: "denied",
  });
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export async function applyPendingInviteDeclinesFromInbox(): Promise<number> { … }
// NEW CODE - TESTING: pending invites live on ForgeRegistry; no owner-inbox decline notices

export async function exportIdentityBundle(): Promise<IdentityExportBundle> {
  const exported = await nativeExportIdentity();
  const reposList = await nativeExportRepos();
  const repos: Record<string, { secret_hex: string; label: string }> = {};
  for (const r of reposList) {
    repos[r.prefix] = { secret_hex: r.secret_hex, label: r.label };
  }
  const vault_id =
    getSessionVaultId() ??
    (await ensureSessionVaultId().catch(() => null)) ??
    undefined;
  return {
    v: 1,
    kind: "gitforge-identity-export",
    secret_key: exported.secret_key,
    fingerprint: exported.fingerprint,
    name: exported.name,
    email: exported.email,
    vault_id,
    repos,
  };
}

/**
 * Seal a freenet-git CLI identity bundle (v1).
 * Mints a 6-word passphrase when `passphrase` is omitted (recommended).
 * Pass `passphrase: ""` only for unencrypted-at-rest (CLI --no-passphrase).
 */
export async function exportFreenetGitCliBundle(input?: {
  passphrase?: string;
}): Promise<{
  bytes: Uint8Array;
  filename: string;
  fingerprint: string;
  passphrase: string;
  unencrypted: boolean;
}> {
  const exported = await nativeExportIdentity();
  const reposList = await nativeExportRepos();
  const id = (await nativeGetIdentity()) ?? getCachedIdentity();
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const passphrase = input?.passphrase ?? "";
  // NEW CODE - TESTING: mint when caller does not supply one
  const passphrase =
    input?.passphrase !== undefined
      ? input.passphrase
      : mintBundlePassphrase();
  const bytes = sealFreenetGitIdentityBundle({
    secret_key_hex: exported.secret_key,
    public_key_b58: id?.public_key_b58,
    name: exported.name,
    email: exported.email,
    repos: reposList.map((r) => ({
      prefix: r.prefix,
      label: r.label,
      secret_hex: r.secret_hex,
    })),
    passphrase,
  });
  return {
    bytes,
    filename: freenetGitBundleFilename(exported.name, exported.fingerprint),
    fingerprint: exported.fingerprint,
    passphrase,
    unencrypted: passphrase.length === 0,
  };
}

export async function linkIdentityBundle(
  raw: string,
): Promise<ForgeIdentityInfo> {
  // NEW CODE - TESTING: cold peers need RegisterDelegate before ImportIdentity
  await ensureOwnerDelegatesReady();
  const data = JSON.parse(raw) as IdentityExportBundle & {
    secret_key?: string;
    name?: string;
    email?: string;
    vault_id?: string;
  };
  const secret =
    data.secret_key ??
    (data as { identity_sk_hex?: string }).identity_sk_hex;
  if (!secret) throw new Error("bundle missing secret_key");
  const name = data.name ?? "user";
  const email = normalizeEmail(data.email ?? "");
  const identity = await nativeImportIdentity(secret, name, email);
  for (const [prefix, repo] of Object.entries(data.repos ?? {})) {
    await nativeImportRepoKey(prefix, repo.secret_hex, repo.label);
  }
  if (data.vault_id) setSessionVaultId(data.vault_id);
  else {
    try {
      setSessionVaultId(vaultIdFromSeedHex(secret));
    } catch {
      /* ignore if secret is not a 32-byte seed */
    }
  }
  setCachedIdentity(identity);
  setCachedSeedHex(secret);
  return identity;
}

export async function currentIdentity(): Promise<ForgeIdentityInfo | null> {
  const cached = getCachedIdentity();
  const probe = async (): Promise<ForgeIdentityInfo | null> => {
    const id = await nativeGetIdentity();
    if (id) {
      setCachedIdentity(id);
      if (!getSessionVaultId()) {
        await ensureSessionVaultId().catch(() => null);
      }
      try {
        const { rememberPersonFingerprint } = await import("./people-resolve");
        rememberPersonFingerprint(id.fingerprint);
      } catch {
        /* ignore */
      }
      return id;
    }
    return null;
  };

  try {
    const id = await probe();
    if (id) return id;
    if (!cached) {
      await new Promise((r) => setTimeout(r, 400));
      const retry = await probe().catch(() => null);
      if (retry) return retry;
    }
    return cached;
  } catch {
    if (!cached) {
      try {
        await new Promise((r) => setTimeout(r, 400));
        const retry = await probe();
        if (retry) return retry;
      } catch {
        /* fall through */
      }
    }
    return cached;
  }
}
