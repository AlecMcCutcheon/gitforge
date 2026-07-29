import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519 } from "@noble/curves/ed25519";
import { scrypt } from "@noble/hashes/scrypt";
import { hexToBytes, randomBytes } from "@noble/hashes/utils";
import { wordlist } from "@scure/bip39/wordlists/english";
import bs58 from "bs58";

const BUNDLE_MAGIC = new TextEncoder().encode("freegit\x01");
const BUNDLE_VERSION = 1;
const KDF_LOG_N = 17;
const KDF_R = 8;
const KDF_P = 1;
/** Diceware-style length for minted CLI bundle passphrases. */
const MINTED_PASSPHRASE_WORDS = 6;

export interface FreenetGitRepoEntry {
  prefix: string;
  label: string;
  secret_hex: string;
}

export interface FreenetGitBundleInput {
  secret_key_hex: string;
  /** Optional; derived from secret when omitted. */
  public_key_b58?: string;
  name: string;
  email: string;
  repos: FreenetGitRepoEntry[];
  /** Empty string = unencrypted at rest (CLI --no-passphrase). */
  passphrase?: string;
}

/**
 * Mint a memorable passphrase (BIP-39 English words) for sealing a CLI bundle.
 */
export function mintBundlePassphrase(
  wordCount: number = MINTED_PASSPHRASE_WORDS,
): string {
  if (wordCount < 4 || wordCount > 12) {
    throw new Error("passphrase word count out of range");
  }
  const words: string[] = [];
  // Rejection sampling so every word is uniform over 2048.
  while (words.length < wordCount) {
    const buf = randomBytes(2);
    const n = ((buf[0]! << 8) | buf[1]!) & 0x7ff;
    words.push(wordlist[n]!);
  }
  return words.join(" ");
}

function appendU32Le(out: number[], value: number): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function appendU64Le(out: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("bincode length out of range");
  }
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x1_0000_0000) >>> 0;
  appendU32Le(out, lo);
  appendU32Le(out, hi);
}

function appendBytes(out: number[], bytes: Uint8Array): void {
  appendU64Le(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}

function appendString(out: number[], text: string): void {
  appendBytes(out, new TextEncoder().encode(text));
}

function toUint8(out: number[]): Uint8Array {
  return new Uint8Array(out);
}

function parseSecretHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex.trim().toLowerCase().replace(/^0x/, ""));
  if (bytes.length !== 32) {
    throw new Error("ed25519 secret must be 32 bytes");
  }
  return bytes;
}

function publicFromSecret(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secret);
}

function encodeKdf(salt: Uint8Array, logN: number, r: number, p: number): Uint8Array {
  const out: number[] = [];
  appendBytes(out, salt);
  out.push(logN & 0xff);
  appendU32Le(out, r);
  appendU32Le(out, p);
  return toUint8(out);
}

function associatedData(kdfBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + 4 + kdfBytes.length);
  out.set(BUNDLE_MAGIC, 0);
  out[8] = BUNDLE_VERSION & 0xff;
  out[9] = (BUNDLE_VERSION >>> 8) & 0xff;
  out[10] = (BUNDLE_VERSION >>> 16) & 0xff;
  out[11] = (BUNDLE_VERSION >>> 24) & 0xff;
  out.set(kdfBytes, 12);
  return out;
}

function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  logN: number = KDF_LOG_N,
  r: number = KDF_R,
  p: number = KDF_P,
): Uint8Array {
  if (passphrase.length === 0) {
    return new Uint8Array(32);
  }
  return scrypt(new TextEncoder().encode(passphrase), salt, {
    N: 2 ** logN,
    r,
    p,
    dkLen: 32,
  });
}

function readU32Le(buf: Uint8Array, offset: number): number {
  return (
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24)
  ) >>> 0;
}

function readU64Le(buf: Uint8Array, offset: number): number {
  const lo = readU32Le(buf, offset);
  const hi = readU32Le(buf, offset + 4);
  const n = lo + hi * 0x1_0000_0000;
  if (!Number.isSafeInteger(n)) {
    throw new Error("bincode length out of range");
  }
  return n;
}

function readBytes(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } {
  const len = readU64Le(buf, offset);
  const start = offset + 8;
  const end = start + len;
  if (end > buf.length) throw new Error("truncated bundle");
  return { value: buf.subarray(start, end), next: end };
}

function readString(
  buf: Uint8Array,
  offset: number,
): { value: string; next: number } {
  const b = readBytes(buf, offset);
  return { value: new TextDecoder().decode(b.value), next: b.next };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function encodeDecryptedBundle(input: {
  secret: Uint8Array;
  publicKey: Uint8Array;
  name: string;
  email: string;
  repos: Array<{
    secret: Uint8Array;
    publicKey: Uint8Array;
    prefix: string;
    displayName: string;
  }>;
}): Uint8Array {
  const out: number[] = [];
  appendBytes(out, input.secret);
  appendBytes(out, input.publicKey);
  appendString(out, input.name);
  appendString(out, input.email);
  appendU64Le(out, input.repos.length);
  for (const repo of input.repos) {
    appendBytes(out, repo.secret);
    appendBytes(out, repo.publicKey);
    appendString(out, repo.prefix);
    appendString(out, repo.displayName);
  }
  return toUint8(out);
}

function decodeDecryptedBundle(plain: Uint8Array): {
  secret_key_hex: string;
  public_key_b58: string;
  name: string;
  email: string;
  repos: FreenetGitRepoEntry[];
} {
  let o = 0;
  const secret = readBytes(plain, o);
  o = secret.next;
  const pub = readBytes(plain, o);
  o = pub.next;
  const name = readString(plain, o);
  o = name.next;
  const email = readString(plain, o);
  o = email.next;
  const nRepos = readU64Le(plain, o);
  o += 8;
  const repos: FreenetGitRepoEntry[] = [];
  for (let i = 0; i < nRepos; i++) {
    const rs = readBytes(plain, o);
    o = rs.next;
    const rp = readBytes(plain, o);
    o = rp.next;
    const prefix = readString(plain, o);
    o = prefix.next;
    const label = readString(plain, o);
    o = label.next;
    repos.push({
      prefix: prefix.value,
      label: label.value,
      secret_hex: bytesToHex(rs.value),
    });
  }
  if (secret.value.length !== 32 || pub.value.length !== 32) {
    throw new Error("invalid identity key lengths in bundle");
  }
  return {
    secret_key_hex: bytesToHex(secret.value),
    public_key_b58: bs58.encode(pub.value),
    name: name.value,
    email: email.value,
    repos,
  };
}

export interface OpenedFreenetGitBundle {
  secret_key_hex: string;
  public_key_b58: string;
  name: string;
  email: string;
  repos: FreenetGitRepoEntry[];
  fingerprint: string;
}

/**
 * Decrypt a freenet-git `git-identity.bundle` (v1) with the bundle passphrase
 * (empty string = unencrypted / `--no-passphrase`).
 */
export function openFreenetGitIdentityBundle(
  bytes: Uint8Array,
  passphrase: string,
): OpenedFreenetGitBundle {
  if (bytes.length < 16) throw new Error("bundle too short");
  for (let i = 0; i < BUNDLE_MAGIC.length; i++) {
    if (bytes[i] !== BUNDLE_MAGIC[i]) {
      throw new Error("not a freenet-git identity bundle");
    }
  }
  let o = 8;
  const version = readU32Le(bytes, o);
  o += 4;
  if (version !== BUNDLE_VERSION) {
    throw new Error(`unsupported identity bundle version ${version}`);
  }
  const salt = readBytes(bytes, o);
  o = salt.next;
  const logN = bytes[o]!;
  o += 1;
  const r = readU32Le(bytes, o);
  o += 4;
  const p = readU32Le(bytes, o);
  o += 4;
  const nonce = readBytes(bytes, o);
  o = nonce.next;
  const ciphertext = readBytes(bytes, o);
  o = ciphertext.next;

  if (salt.value.length !== 16) {
    throw new Error("invalid bundle salt length");
  }
  if (nonce.value.length !== 24) {
    throw new Error("invalid bundle nonce length");
  }

  const kdfBytes = encodeKdf(salt.value, logN, r, p);
  const key = deriveKey(passphrase, salt.value, logN, r, p);
  const aead = xchacha20poly1305(
    key,
    nonce.value,
    associatedData(kdfBytes),
  );
  let plain: Uint8Array;
  try {
    plain = aead.decrypt(ciphertext.value);
  } catch {
    throw new Error(
      "decryption failed — wrong passphrase or corrupted bundle",
    );
  }
  const decoded = decodeDecryptedBundle(plain);
  return {
    ...decoded,
    fingerprint: `freenet:id:${decoded.public_key_b58}`,
  };
}

/**
 * Build freenet-git `git-identity.bundle` bytes (v1 envelope).
 */
export function sealFreenetGitIdentityBundle(
  input: FreenetGitBundleInput,
): Uint8Array {
  const secret = parseSecretHex(input.secret_key_hex);
  let publicKey: Uint8Array;
  if (input.public_key_b58?.trim()) {
    publicKey = bs58.decode(input.public_key_b58.trim());
    if (publicKey.length !== 32) {
      throw new Error("public_key_b58 must decode to 32 bytes");
    }
    const expected = publicFromSecret(secret);
    for (let i = 0; i < 32; i++) {
      if (publicKey[i] !== expected[i]) {
        throw new Error("public key does not match secret key");
      }
    }
  } else {
    publicKey = publicFromSecret(secret);
  }

  const repos = input.repos.map((r) => {
    const repoSecret = parseSecretHex(r.secret_hex);
    const repoPublic = publicFromSecret(repoSecret);
    return {
      secret: repoSecret,
      publicKey: repoPublic,
      prefix: r.prefix,
      displayName: r.label,
    };
  });

  const payload = encodeDecryptedBundle({
    secret,
    publicKey,
    name: input.name,
    email: input.email,
    repos,
  });

  const passphrase = input.passphrase ?? "";
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const kdfBytes = encodeKdf(salt, KDF_LOG_N, KDF_R, KDF_P);
  const key = deriveKey(passphrase, salt, KDF_LOG_N, KDF_R, KDF_P);
  const aead = xchacha20poly1305(key, nonce, associatedData(kdfBytes));
  const ciphertext = aead.encrypt(payload);

  const envelope: number[] = [];
  for (let i = 0; i < BUNDLE_MAGIC.length; i++) envelope.push(BUNDLE_MAGIC[i]!);
  appendU32Le(envelope, BUNDLE_VERSION);
  appendBytes(envelope, salt);
  envelope.push(KDF_LOG_N & 0xff);
  appendU32Le(envelope, KDF_R);
  appendU32Le(envelope, KDF_P);
  appendBytes(envelope, nonce);
  appendBytes(envelope, ciphertext);
  return toUint8(envelope);
}

export function freenetGitBundleFilename(name: string, fingerprint: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const tag = fingerprint.replace(/^freenet:id:/, "").slice(0, 8);
  return `git-identity-${stem || "export"}-${tag}.bundle`;
}
