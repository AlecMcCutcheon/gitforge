/**
 * Profile inbox seal crypto — deterministic X25519 from identity seed.
 * Messages are opaque ciphertext on the profile contract; only the identity
 * seed holder can decrypt.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

const INBOX_SEED_DOMAIN = new TextEncoder().encode("gitatlas.profile.inbox-x25519-v1\0");

export interface InboxPlaintextEnvelope {
  v: number;
  kind: string;
  body: unknown;
}

export interface DecryptedInboxMessage {
  id: string;
  created_at: string;
  sender_vk?: string;
  plaintext: InboxPlaintextEnvelope | null;
  raw: Uint8Array | null;
  error?: string;
}

/** Derive X25519 secret from the 32-byte identity seed (deterministic). */
export function inboxSealSkFromSeedHex(seedHex: string): Uint8Array {
  const seed = hexToBytes(seedHex.trim().toLowerCase().replace(/^0x/, ""));
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const concat = new Uint8Array(INBOX_SEED_DOMAIN.length + seed.length);
  concat.set(INBOX_SEED_DOMAIN, 0);
  concat.set(seed, INBOX_SEED_DOMAIN.length);
  return blake3(concat);
}

export function inboxPkHexFromSeedHex(seedHex: string): string {
  const sk = inboxSealSkFromSeedHex(seedHex);
  return bytesToHex(x25519.getPublicKey(sk));
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Seal plaintext to a recipient inbox_pk (32-byte hex X25519).
 * Format: ephemeral_pk(32) ‖ nonce(24) ‖ ciphertext.
 */
export function sealInboxMessage(
  recipientInboxPkHex: string,
  plaintext: Uint8Array | string,
): string {
  const recipientPk = hexToBytes(recipientInboxPkHex.trim().toLowerCase());
  if (recipientPk.length !== 32) throw new Error("inbox_pk must be 32 bytes");
  const ephSk = x25519.utils.randomSecretKey();
  const ephPk = x25519.getPublicKey(ephSk);
  const shared = x25519.getSharedSecret(ephSk, recipientPk);
  const key = blake3(shared);
  const nonce = randomBytes(24);
  const data =
    typeof plaintext === "string"
      ? new TextEncoder().encode(plaintext)
      : plaintext;
  const cipher = xchacha20poly1305(key, nonce).encrypt(data);
  const out = new Uint8Array(32 + 24 + cipher.length);
  out.set(ephPk, 0);
  out.set(nonce, 32);
  out.set(cipher, 56);
  return bytesToB64(out);
}

export function openInboxMessage(
  seedHex: string,
  ciphertextB64: string,
): Uint8Array {
  const sk = inboxSealSkFromSeedHex(seedHex);
  const blob = b64ToBytes(ciphertextB64);
  if (blob.length < 32 + 24 + 16) throw new Error("inbox ciphertext too short");
  const ephPk = blob.subarray(0, 32);
  const nonce = blob.subarray(32, 56);
  const cipher = blob.subarray(56);
  const shared = x25519.getSharedSecret(sk, ephPk);
  const key = blake3(shared);
  return xchacha20poly1305(key, nonce).decrypt(cipher);
}

export function parseInboxPlaintext(bytes: Uint8Array): InboxPlaintextEnvelope | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text) as InboxPlaintextEnvelope;
    if (!data || typeof data.kind !== "string") return null;
    return { v: data.v ?? 1, kind: data.kind, body: data.body };
  } catch {
    return null;
  }
}

/** Session store for decrypted inbox after identity attach. */
let cachedInbox: DecryptedInboxMessage[] = [];

export function setCachedInboxMessages(msgs: DecryptedInboxMessage[]): void {
  cachedInbox = msgs;
}

export function listInboxPlaintexts(): DecryptedInboxMessage[] {
  return cachedInbox.slice();
}

export function clearCachedInbox(): void {
  cachedInbox = [];
}

/** Unused import guard — ed25519 kept for future sender attribution helpers. */
void ed25519;
