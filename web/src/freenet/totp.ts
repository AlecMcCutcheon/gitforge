/**
 * RFC 6238 TOTP (HMAC-SHA1, 30s, 6 digits) for app-enforced vault 2FA.
 * Secret lives in vault plaintext; codes are verified in the SPA after decrypt.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/sha1";
import { randomBytes } from "@noble/hashes/utils";
import { brand } from "../lib/brand";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const MIN_VAULT_PASSWORD_LENGTH = 12;

export const VAULT_PASSWORD_HINT =
  `At least ${MIN_VAULT_PASSWORD_LENGTH} characters, with uppercase, lowercase, a number, and a symbol.`;

export function assertVaultPassword(password: string): void {
  if (password.length < MIN_VAULT_PASSWORD_LENGTH) {
    throw new Error(
      `vault password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters`,
    );
  }
  if (!/[a-z]/.test(password)) {
    throw new Error("vault password must include a lowercase letter");
  }
  if (!/[A-Z]/.test(password)) {
    throw new Error("vault password must include an uppercase letter");
  }
  if (!/[0-9]/.test(password)) {
    throw new Error("vault password must include a number");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    throw new Error("vault password must include a symbol");
  }
}

export function generateTotpSecretB32(byteLen = 20): string {
  return bytesToBase32(randomBytes(byteLen));
}

export function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return out;
}

export function base32ToBytes(b32: string): Uint8Array {
  const cleaned = b32.replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function hotp(secret: Uint8Array, counter: number): number {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const dig = hmac(sha1, secret, msg);
  const offset = dig[dig.length - 1]! & 0x0f;
  const bin =
    ((dig[offset]! & 0x7f) << 24) |
    ((dig[offset + 1]! & 0xff) << 16) |
    ((dig[offset + 2]! & 0xff) << 8) |
    (dig[offset + 3]! & 0xff);
  return bin % 1_000_000;
}

export function totpCode(
  secretB32: string,
  atMs: number = Date.now(),
  stepSecs = 30,
): string {
  const secret = base32ToBytes(secretB32);
  const counter = Math.floor(atMs / 1000 / stepSecs);
  return String(hotp(secret, counter)).padStart(6, "0");
}

/** Accept current step ±1 for clock skew. */
export function verifyTotpCode(
  secretB32: string,
  code: string,
  atMs: number = Date.now(),
  stepSecs = 30,
): boolean {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  for (const delta of [-1, 0, 1]) {
    const t = atMs + delta * stepSecs * 1000;
    if (totpCode(secretB32, t, stepSecs) === cleaned) return true;
  }
  return false;
}

export function otpauthUrl(input: {
  secretB32: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? brand.displayName;
  const label = encodeURIComponent(`${issuer}:${input.accountName}`);
  const params = new URLSearchParams({
    secret: input.secretB32.replace(/=+$/g, ""),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
