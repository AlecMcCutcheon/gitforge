/**
 * Client-side GitForge vault crypto (schema v4 — passwordless envelopes +
 * identity-sealed DEK wrap for signed-in sync).
 * Vault address = blake3(domain ‖ seed), not email.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { argon2id } from "@noble/hashes/argon2";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import bs58 from "bs58";

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export const VAULT_PARAMS_PREFIX = "gitforge-vault-v1:";
// const VAULT_ID_DOMAIN = ... gitforge-vault-v1
// export const VAULT_SIGN_DOMAIN = ... gitforge.vault.v3
// export const VAULT_SCHEMA_VERSION = 3;
// NEW CODE - TESTING: GitForge passwordless vault v4 (+ pages envelope)
export const VAULT_PARAMS_PREFIX = "gitforge-vault-v1:";
const VAULT_ID_DOMAIN = new TextEncoder().encode("gitforge-vault-v1");
/** v4 signing domain — must match forge-vault contract + SignVault delegate. */
export const VAULT_SIGN_DOMAIN = new TextEncoder().encode("gitforge.vault.v4\0");
export const VAULT_SCHEMA_VERSION = 4;
/** Domain for blake3(identity_sk) → wrap key for identity_dek_wrap. */
const IDENTITY_DEK_WRAP_DOMAIN = new TextEncoder().encode(
  "gitforge.vault.identity-dek-wrap-v1\0",
);
export const ENVELOPE_REPOS = "repos";
/** Sealed Pages website signing keys (ed25519 seeds per repo prefix). */
export const ENVELOPE_PAGES = "pages";
/** Private user prefs / KV (plaintext JSON object, versioned with `"v": 1`). */
export const ENVELOPE_SETTINGS = "settings";
export const SIG_KIND_OWNER = "owner";
export const SIG_KIND_OPS = "ops";

/** Envelope id scopes (cryptographic). Legacy aliases normalized via normalizeScope. */
export type VaultApiKeyScope =
  | "repos"
  | "pages"
  | "settings"
  | "vault:merge-repos"
  | "vault:merge-pages"
  | "vault:merge-settings"
  | "vault:read";

export interface VaultKdfJson {
  alg: string;
  salt_b64: string;
  m: number;
  t: number;
  p: number;
}

export interface VaultCipherJson {
  alg: string;
  nonce_b64: string;
  blob_b64: string;
}

export interface VaultApiKeyMeta {
  id: string;
  name: string;
  created_at: string;
  scopes: string[];
}

/** Public wrap: hash lookup + AEAD of `{ deks, ops_sk_hex }` under API key. */
export interface VaultApiKeyWrap {
  id: string;
  name: string;
  created_at: string;
  salt_b64: string;
  hash_b64: string;
  scopes: string[];
  wrap_kdf: VaultKdfJson;
  wrap_nonce_b64: string;
  wrap_blob_b64: string;
  ops_vk_b58: string;
}

export interface AuthorizedOps {
  id: string;
  ops_vk_b58: string;
  scopes: string[];
  created_at: string;
}

/** Payload inside an API-key wrap. */
export interface VaultApiKeyWrapPayload {
  deks: Record<string, string>;
  ops_sk_hex: string;
}

export interface VaultPlaintext {
  v: number;
  email: string;
  username: string;
  identity_sk_hex: string;
  /** @deprecated v3+: repos live in envelopes.repos; kept empty or for migration reads */
  repos?: Record<string, { secret_hex: string; label: string }>;
  seed_hex: string;
  /** Per-envelope DEKs (hex). Password unlock path. */
  envelope_deks?: Record<string, string>;
  bio?: string;
  url?: string;
  avatar?: string;
  totp_enabled?: boolean;
  totp_secret_b32?: string;
  api_keys?: VaultApiKeyMeta[];
}

export interface ReposEnvelopePlaintext {
  repos: Record<string, { secret_hex: string; label: string }>;
}

/** Pages website signing keys sealed in ForgeVault `pages` envelope. */
export interface PagesEnvelopePlaintext {
  pages: Record<string, { secret_hex: string; label: string }>;
}

/** Private prefs / KV sealed in ForgeVault `settings` envelope. */
export interface SettingsEnvelopePlaintext {
  v: number;
  /** Local tip-pack backup auto options (Settings → Backups). */
  repo_backup?: {
    autoUpdateExisting?: boolean;
    autoBackupOwnRepos?: boolean;
    autoBackupStars?: boolean;
  };
  /** Protect prefs + remembered Layer A / scopes (restore under shell Authorize). */
  local_protect?: {
    autoProtectOwnRepos?: boolean;
    autoProtectStars?: boolean;
    app_granted?: boolean;
    scopes?: Array<{
      grant_id: string;
      anchor_key: string;
      policy?: {
        kind?: "single" | "anchor_plus_members" | string;
        member_hint?: unknown;
      };
      label?: string;
    }>;
  };
  [key: string]: unknown;
}

export function emptySettingsEnvelope(): SettingsEnvelopePlaintext {
  return { v: 1 };
}

/** Payload inside identity_dek_wrap (no ops SK — owner signs with identity). */
export interface IdentityDekWrapPayload {
  deks: Record<string, string>;
}

/** Public AEAD of `{ deks }` under identity-SK-derived key. */
export interface IdentityDekWrap {
  alg: string;
  nonce_b64: string;
  blob_b64: string;
}

export interface ForgeVaultPublicState {
  schema_version: number;
  vault_id: string;
  envelopes: Record<string, VaultCipherJson>;
  /** Required on schema v4 — DEKs sealed to identity SK. */
  identity_dek_wrap: IdentityDekWrap;
  api_key_wraps?: VaultApiKeyWrap[];
  authorized_ops?: AuthorizedOps[];
  identity_fingerprint: string;
  username: string;
  seq: number;
  updated_at: string;
  sig_kind: string;
  sig: string;
}

const ARGON_M = 19_456;
const ARGON_T = 2;
const ARGON_P = 1;

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeVaultId(vaultId: string): string {
  return vaultId.trim().toLowerCase().replace(/^0x/, "");
}

/** Map UI/legacy scope names to envelope ids. */
export function normalizeScope(scope: string): string {
  if (scope === "vault:merge-repos" || scope === "repos") return ENVELOPE_REPOS;
  if (scope === "pages" || scope === "vault:merge-pages") return ENVELOPE_PAGES;
  if (scope === "settings" || scope === "vault:merge-settings")
    return ENVELOPE_SETTINGS;
  if (scope === "vault:read") return "read";
  return scope;
}

export function normalizeScopes(scopes: string[]): string[] {
  const out: string[] = [];
  for (const s of scopes) {
    const n = normalizeScope(s);
    if (n === "read") continue; // read is implied by holding DEKs; not an envelope write scope
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [ENVELOPE_REPOS];
}

export function vaultIdFromSeedHex(seedHex: string): string {
  const seed = hexToBytes(seedHex.trim().toLowerCase().replace(/^0x/, ""));
  if (seed.length !== 32) {
    throw new Error("seed must be 32 bytes");
  }
  const concat = new Uint8Array(VAULT_ID_DOMAIN.length + seed.length);
  concat.set(VAULT_ID_DOMAIN, 0);
  concat.set(seed, VAULT_ID_DOMAIN.length);
  return bytesToHex(blake3(concat));
}

export function generateSeedHex(): string {
  return bytesToHex(randomBytes(32));
}

export function generateEnvelopeDekHex(): string {
  return bytesToHex(randomBytes(32));
}

export function vaultParamsUtf8(vaultId: string): string {
  return `${VAULT_PARAMS_PREFIX}${normalizeVaultId(vaultId)}`;
}

export function phraseFromSeedHex(seedHex: string): string {
  const entropy = hexToBytes(seedHex.trim().toLowerCase().replace(/^0x/, ""));
  if (entropy.length !== 32) {
    throw new Error("seed must be 32 bytes for a 24-word phrase");
  }
  return entropyToMnemonic(entropy, wordlist);
}

export function seedHexFromPhrase(phrase: string): string {
  const cleaned = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(cleaned, wordlist)) {
    throw new Error("invalid recovery phrase");
  }
  return bytesToHex(mnemonicToEntropy(cleaned, wordlist));
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  kdf: Pick<VaultKdfJson, "m" | "t" | "p">,
): Promise<Uint8Array> {
  const pwd = new TextEncoder().encode(password);
  return argon2id(pwd, salt, {
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
  });
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Stable envelopes JSON (sorted keys) for signing — matches BTreeMap serde. */
export function envelopesSigningJson(
  envelopes: Record<string, VaultCipherJson>,
): string {
  const keys = Object.keys(envelopes).sort();
  const ordered: Record<string, VaultCipherJson> = {};
  for (const k of keys) ordered[k] = envelopes[k]!;
  return compactJson(ordered);
}

export async function encryptWithPassword(
  password: string,
  plaintext: Uint8Array,
): Promise<{ kdf: VaultKdfJson; cipher: VaultCipherJson }> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const kdf: VaultKdfJson = {
    alg: "argon2id",
    salt_b64: bytesToB64(salt),
    m: ARGON_M,
    t: ARGON_T,
    p: ARGON_P,
  };
  const key = await deriveKey(password, salt, kdf);
  const aead = xchacha20poly1305(key, nonce);
  const blob = aead.encrypt(plaintext);
  return {
    kdf,
    cipher: {
      alg: "xchacha20poly1305",
      nonce_b64: bytesToB64(nonce),
      blob_b64: bytesToB64(blob),
    },
  };
}

export async function decryptWithPassword(
  password: string,
  kdf: VaultKdfJson,
  cipher: VaultCipherJson,
): Promise<Uint8Array> {
  if (kdf.alg !== "argon2id") throw new Error(`unsupported kdf ${kdf.alg}`);
  if (cipher.alg !== "xchacha20poly1305") {
    throw new Error(`unsupported cipher ${cipher.alg}`);
  }
  const salt = b64ToBytes(kdf.salt_b64);
  const nonce = b64ToBytes(cipher.nonce_b64);
  const blob = b64ToBytes(cipher.blob_b64);
  const key = await deriveKey(password, salt, kdf);
  const aead = xchacha20poly1305(key, nonce);
  try {
    return aead.decrypt(blob);
  } catch {
    throw new Error("wrong password or corrupt vault ciphertext");
  }
}

export async function encryptVaultPlaintext(
  password: string,
  plain: VaultPlaintext,
): Promise<{ kdf: VaultKdfJson; cipher: VaultCipherJson }> {
  return encryptWithPassword(
    password,
    new TextEncoder().encode(JSON.stringify(plain)),
  );
}

export async function decryptVaultCipher(
  password: string,
  kdf: VaultKdfJson,
  cipher: VaultCipherJson,
): Promise<VaultPlaintext> {
  const plainBytes = await decryptWithPassword(password, kdf, cipher);
  const text = new TextDecoder().decode(plainBytes);
  const data = JSON.parse(text) as VaultPlaintext;
  if (!data?.identity_sk_hex || !data.username) {
    throw new Error("vault plaintext missing identity fields");
  }
  if (!data.email) data.email = "";
  if (!data.seed_hex) data.seed_hex = data.identity_sk_hex;
  if (!data.api_keys) data.api_keys = [];
  if (!data.envelope_deks) data.envelope_deks = {};
  if (!data.repos) data.repos = {};
  return data;
}

export function encryptEnvelopeWithDek(
  dekHex: string,
  plain: unknown,
): VaultCipherJson {
  const dek = hexToBytes(dekHex.trim().toLowerCase().replace(/^0x/, ""));
  if (dek.length !== 32) throw new Error("envelope DEK must be 32 bytes");
  const nonce = randomBytes(24);
  const aead = xchacha20poly1305(dek, nonce);
  const blob = aead.encrypt(new TextEncoder().encode(JSON.stringify(plain)));
  return {
    alg: "xchacha20poly1305",
    nonce_b64: bytesToB64(nonce),
    blob_b64: bytesToB64(blob),
  };
}

export function decryptEnvelopeWithDek<T = unknown>(
  dekHex: string,
  cipher: VaultCipherJson,
): T {
  if (cipher.alg !== "xchacha20poly1305") {
    throw new Error(`unsupported envelope cipher ${cipher.alg}`);
  }
  const dek = hexToBytes(dekHex.trim().toLowerCase().replace(/^0x/, ""));
  if (dek.length !== 32) throw new Error("envelope DEK must be 32 bytes");
  const nonce = b64ToBytes(cipher.nonce_b64);
  const blob = b64ToBytes(cipher.blob_b64);
  const aead = xchacha20poly1305(dek, nonce);
  let plainBytes: Uint8Array;
  try {
    plainBytes = aead.decrypt(blob);
  } catch {
    throw new Error("corrupt envelope ciphertext or wrong DEK");
  }
  return JSON.parse(new TextDecoder().decode(plainBytes)) as T;
}

export function mintVaultApiKeySecret(): string {
  const raw = randomBytes(32);
  const b64 = bytesToB64(raw)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `gatk_${b64}`;
}

export function hashVaultApiKey(apiKey: string, salt: Uint8Array): string {
  const keyBytes = new TextEncoder().encode(apiKey);
  const concat = new Uint8Array(salt.length + keyBytes.length);
  concat.set(salt, 0);
  concat.set(keyBytes, salt.length);
  return bytesToB64(blake3(concat));
}

export function generateOpsKeypair(): { skHex: string; vkB58: string } {
  const sk = randomBytes(32);
  const vk = ed25519.getPublicKey(sk);
  return { skHex: bytesToHex(sk), vkB58: bs58.encode(vk) };
}

export async function wrapApiKeyPayload(input: {
  apiKey: string;
  payload: VaultApiKeyWrapPayload;
  id: string;
  name: string;
  scopes: string[];
  ops_vk_b58: string;
}): Promise<VaultApiKeyWrap> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const wrap_kdf: VaultKdfJson = {
    alg: "argon2id",
    salt_b64: bytesToB64(salt),
    m: ARGON_M,
    t: ARGON_T,
    p: ARGON_P,
  };
  const key = await deriveKey(input.apiKey, salt, wrap_kdf);
  const aead = xchacha20poly1305(key, nonce);
  const blob = aead.encrypt(
    new TextEncoder().encode(JSON.stringify(input.payload)),
  );
  const created_at = new Date().toISOString();
  return {
    id: input.id,
    name: input.name.trim() || "API key",
    created_at,
    salt_b64: bytesToB64(salt),
    hash_b64: hashVaultApiKey(input.apiKey, salt),
    scopes: input.scopes,
    wrap_kdf,
    wrap_nonce_b64: bytesToB64(nonce),
    wrap_blob_b64: bytesToB64(blob),
    ops_vk_b58: input.ops_vk_b58,
  };
}

export async function unwrapApiKeyPayload(
  apiKey: string,
  wrap: VaultApiKeyWrap,
): Promise<VaultApiKeyWrapPayload> {
  const salt = b64ToBytes(wrap.salt_b64);
  if (hashVaultApiKey(apiKey, salt) !== wrap.hash_b64) {
    throw new Error("invalid API key");
  }
  if (wrap.wrap_kdf.alg !== "argon2id") {
    throw new Error(`unsupported wrap kdf ${wrap.wrap_kdf.alg}`);
  }
  const key = await deriveKey(apiKey, salt, wrap.wrap_kdf);
  const nonce = b64ToBytes(wrap.wrap_nonce_b64);
  const blob = b64ToBytes(wrap.wrap_blob_b64);
  const aead = xchacha20poly1305(key, nonce);
  try {
    const plain = aead.decrypt(blob);
    const data = JSON.parse(new TextDecoder().decode(plain)) as VaultApiKeyWrapPayload;
    if (!data?.deks || !data.ops_sk_hex) {
      throw new Error("invalid wrap payload");
    }
    return data;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid")) throw e;
    throw new Error("invalid API key or corrupt wrap");
  }
}

export function findApiKeyWrap(
  wraps: VaultApiKeyWrap[] | undefined,
  apiKey: string,
): VaultApiKeyWrap | null {
  if (!wraps?.length) return null;
  for (const w of wraps) {
    try {
      const salt = b64ToBytes(w.salt_b64);
      if (hashVaultApiKey(apiKey, salt) === w.hash_b64) return w;
    } catch {
      /* skip */
    }
  }
  return null;
}

function normalizeSkHex(skHex: string): Uint8Array {
  const sk = hexToBytes(skHex.trim().toLowerCase().replace(/^0x/, ""));
  if (sk.length !== 32) {
    throw new Error("identity secret key must be 32 bytes");
  }
  return sk;
}

/** Wrap key for identity_dek_wrap — anyone with the identity SK can derive it. */
export function deriveIdentityDekWrapKey(skHex: string): Uint8Array {
  const sk = normalizeSkHex(skHex);
  const concat = new Uint8Array(IDENTITY_DEK_WRAP_DOMAIN.length + sk.length);
  concat.set(IDENTITY_DEK_WRAP_DOMAIN, 0);
  concat.set(sk, IDENTITY_DEK_WRAP_DOMAIN.length);
  return blake3(concat);
}

export function sealIdentityDekWrap(
  skHex: string,
  deks: Record<string, string>,
): IdentityDekWrap {
  const key = deriveIdentityDekWrapKey(skHex);
  const nonce = randomBytes(24);
  const aead = xchacha20poly1305(key, nonce);
  const blob = aead.encrypt(
    new TextEncoder().encode(JSON.stringify({ deks } satisfies IdentityDekWrapPayload)),
  );
  return {
    alg: "xchacha20poly1305",
    nonce_b64: bytesToB64(nonce),
    blob_b64: bytesToB64(blob),
  };
}

export function unsealIdentityDekWrap(
  skHex: string,
  wrap: IdentityDekWrap,
): IdentityDekWrapPayload {
  if (wrap.alg !== "xchacha20poly1305") {
    throw new Error(`unsupported identity_dek_wrap cipher ${wrap.alg}`);
  }
  const key = deriveIdentityDekWrapKey(skHex);
  const nonce = b64ToBytes(wrap.nonce_b64);
  const blob = b64ToBytes(wrap.blob_b64);
  const aead = xchacha20poly1305(key, nonce);
  try {
    const plain = aead.decrypt(blob);
    const data = JSON.parse(
      new TextDecoder().decode(plain),
    ) as IdentityDekWrapPayload;
    if (!data?.deks || typeof data.deks !== "object") {
      throw new Error("invalid identity_dek_wrap payload");
    }
    return data;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid")) throw e;
    throw new Error(
      "cannot unwrap vault DEKs with this identity",
    );
  }
}

function pushNulField(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
  out.push(0);
}

function pushU64Le(out: number[], value: number): void {
  let v = value;
  for (let i = 0; i < 8; i++) {
    out.push(v & 0xff);
    v = Math.floor(v / 256);
  }
}

/**
 * GitForge vault v4 signing payload (owner or ops).
 * Must match forge-vault contract + SignVault delegate.
 */
export function buildVaultSigningPayload(input: {
  vault_id: string;
  username: string;
  identity_fingerprint: string;
  envelopes_json: string;
  identity_dek_wrap_json: string;
  api_key_wraps_json: string;
  authorized_ops_json: string;
  seq: number;
  updated_at: string;
  sig_kind: string;
}): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < VAULT_SIGN_DOMAIN.length; i++) out.push(VAULT_SIGN_DOMAIN[i]!);
  const enc = new TextEncoder();
  pushNulField(out, enc.encode(input.vault_id));
  pushNulField(out, enc.encode(input.username));
  pushNulField(out, enc.encode(input.identity_fingerprint));
  pushNulField(out, enc.encode(input.envelopes_json));
  pushNulField(out, enc.encode(input.identity_dek_wrap_json));
  pushNulField(out, enc.encode(input.api_key_wraps_json || "[]"));
  pushNulField(out, enc.encode(input.authorized_ops_json || "[]"));
  pushU64Le(out, input.seq);
  pushNulField(out, enc.encode(input.updated_at));
  pushNulField(out, enc.encode(input.sig_kind));
  return new Uint8Array(out);
}

export function apiKeyWrapsSigningJson(
  wraps: VaultApiKeyWrap[] | undefined,
): string {
  return compactJson(wraps ?? []);
}

export function authorizedOpsSigningJson(
  ops: AuthorizedOps[] | undefined,
): string {
  return compactJson(ops ?? []);
}

export function identityDekWrapSigningJson(wrap: IdentityDekWrap): string {
  return compactJson(wrap);
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export function isVaultV2State(...)
/** True when state matches current GitForge vault schema (v4). */
export function isVaultV2State(
  state: ForgeVaultPublicState | { schema_version?: number; cipher?: unknown },
): state is ForgeVaultPublicState {
  return (
    state.schema_version === VAULT_SCHEMA_VERSION &&
    "envelopes" in state &&
    "identity_dek_wrap" in state
  );
}

export const isVaultCurrentState = isVaultV2State;

/** Sign payload with raw 32-byte ed25519 seed (CLI ops / local owner). */
export function signVaultPayloadLocally(
  skHex: string,
  payload: Uint8Array,
): string {
  const sk = hexToBytes(skHex.trim().toLowerCase().replace(/^0x/, ""));
  if (sk.length !== 32) throw new Error("signing key must be 32 bytes");
  return bytesToHex(ed25519.sign(payload, sk));
}
