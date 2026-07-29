import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { ContractKey } from "@freenetorg/freenet-stdlib";
import { PACK_WASM_HASH_B58, REPO_WASM_HASH_B58 } from "./constants";

function decodeCodeHash(codeHashBase58: string): Uint8Array {
  const bytes = bs58.decode(codeHashBase58);
  if (bytes.length !== 32) {
    throw new Error(
      `code hash must decode to 32 bytes, got ${bytes.length}: ${codeHashBase58}`,
    );
  }
  return bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== 64 || clean.length % 2 !== 0) {
    throw new Error(`expected 32-byte hex hash, got length ${clean.length}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bincode (default) of freenet-git `RepoParams { prefix: String }`:
 * u64 LE length + UTF-8 bytes.
 */
export function encodeRepoParams(prefix: string): Uint8Array {
  const enc = new TextEncoder().encode(prefix);
  const out = new Uint8Array(8 + enc.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(enc.length), true);
  out.set(enc, 8);
  return out;
}

export function deriveInstanceId(
  codeHashBase58: string,
  parameters: Uint8Array,
): { bytes: Uint8Array; base58: string } {
  const codeBytes = decodeCodeHash(codeHashBase58);
  const concat = new Uint8Array(codeBytes.length + parameters.length);
  concat.set(codeBytes, 0);
  concat.set(parameters, codeBytes.length);
  const id = blake3(concat);
  return { bytes: id, base58: bs58.encode(id) };
}

function contractKeyFromParts(
  codeHashBase58: string,
  parameters: Uint8Array,
): ContractKey {
  const instance = deriveInstanceId(codeHashBase58, parameters);
  const codeBytes = decodeCodeHash(codeHashBase58);
  return new ContractKey(
    instance.bytes as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

export function repoContractKey(prefix: string): ContractKey {
  return contractKeyFromParts(REPO_WASM_HASH_B58, encodeRepoParams(prefix));
}

export function packContractKey(packHashHex: string): ContractKey {
  return contractKeyFromParts(PACK_WASM_HASH_B58, hexToBytes(packHashHex));
}
