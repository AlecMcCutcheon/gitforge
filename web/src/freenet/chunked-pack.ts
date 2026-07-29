/**
 * ChunkedPack split / publish / re-PUT helpers (freenet-git large-repos path).
 * Serial shell Puts for v1 (FIFO-safe). See docs/15-freenet-git-ws-hygiene.md.
 */
import { blake3 } from "@noble/hashes/blake3";
import { PACK_WASM_HASH_B58 } from "./constants";
import { bytesToHex, packContractKey } from "./keys";
import { buildPutRequest } from "./put";
import { fetchPackByHash } from "./tip-fetch";
import { putContract } from "./ws";
import { loadPublicWasm } from "./wasm-cache";

/** Matches freenet-git `DEFAULT_CHUNK_SIZE` (1 MiB). Exact size stays SinglePack. */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export type ChunkedPublishProgress =
  | { phase: "put_chunk"; i: number; n: number }
  | { phase: "verify_chunk"; i: number; n: number }
  | { phase: "put_manifest" }
  | { phase: "verify_manifest" };

export interface PublishedChunkedPack {
  manifestHashHex: string;
  totalSize: number;
  chunkCount: number;
  chunkSize: number;
  chunkHashesHex: string[];
}

export function splitPack(
  packBytes: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Uint8Array[] {
  if (chunkSize <= 0) throw new Error("splitPack: zero chunk_size");
  if (packBytes.length === 0) throw new Error("splitPack: empty pack");
  const out: Uint8Array[] = [];
  for (let off = 0; off < packBytes.length; off += chunkSize) {
    out.push(packBytes.subarray(off, Math.min(off + chunkSize, packBytes.length)));
  }
  return out;
}

async function loadPackWasm(): Promise<Uint8Array> {
  return loadPublicWasm("./pack-contract.wasm");
}

async function encodeManifestBytes(
  packBytes: Uint8Array,
  chunkSize: number,
): Promise<Uint8Array> {
  const { encodeChunkedManifest } = await import("../tip-browse/decode-wasm");
  return encodeChunkedManifest(packBytes, chunkSize);
}

/** Put one pack-contract (content-addressed by BLAKE3 of state). */
export async function putPackBytes(
  bytes: Uint8Array,
  opts?: { timeoutMs?: number },
): Promise<{ hashHex: string; key: ReturnType<typeof packContractKey> }> {
  const hash = blake3(bytes);
  const hashHex = bytesToHex(hash);
  const packWasm = await loadPackWasm();
  const key = packContractKey(hashHex);
  const put = buildPutRequest(packWasm, PACK_WASM_HASH_B58, hash, bytes);
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  await withTimeout(putContract(put, key), timeoutMs, `pack Put ${hashHex.slice(0, 12)}`);
  return { hashHex, key };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
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

/**
 * Four-phase ChunkedPack publish (CLI `publish_chunked_pack` shape):
 * Put chunks → verify GETs → Put manifest → verify manifest.
 * Caller signs BundleAdd / tip after this returns.
 */
export async function publishChunkedPackPhases(
  packBytes: Uint8Array,
  opts?: {
    chunkSize?: number;
    onProgress?: (p: ChunkedPublishProgress) => void;
    scope?: string;
  },
): Promise<PublishedChunkedPack> {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (packBytes.length === 0) {
    throw new Error("publishChunkedPackPhases: empty pack");
  }
  if (packBytes.length <= chunkSize) {
    throw new Error(
      `publishChunkedPackPhases: pack ${packBytes.length} ≤ chunkSize ${chunkSize}; use SinglePack`,
    );
  }

  const chunks = splitPack(packBytes, chunkSize);
  const chunkHashesHex: string[] = chunks.map((c) => bytesToHex(blake3(c)));
  const n = chunks.length;
  const onProgress = opts?.onProgress;

  for (let i = 0; i < n; i++) {
    onProgress?.({ phase: "put_chunk", i: i + 1, n });
    const { hashHex } = await putPackBytes(chunks[i]!);
    if (hashHex !== chunkHashesHex[i]) {
      throw new Error(
        `chunk ${i} hash mismatch after Put: got ${hashHex}, expected ${chunkHashesHex[i]}`,
      );
    }
  }

  for (let i = 0; i < n; i++) {
    onProgress?.({ phase: "verify_chunk", i: i + 1, n });
    await fetchPackByHash(chunkHashesHex[i]!, opts?.scope);
  }

  onProgress?.({ phase: "put_manifest" });
  const manifestBytes = await encodeManifestBytes(packBytes, chunkSize);
  const { hashHex: manifestHashHex } = await putPackBytes(manifestBytes);

  onProgress?.({ phase: "verify_manifest" });
  const gotManifest = await fetchPackByHash(manifestHashHex, opts?.scope);
  if (gotManifest.length !== manifestBytes.length) {
    throw new Error(
      `manifest verify size mismatch: got ${gotManifest.length}, want ${manifestBytes.length}`,
    );
  }
  for (let i = 0; i < manifestBytes.length; i++) {
    if (gotManifest[i] !== manifestBytes[i]) {
      throw new Error("manifest verify byte mismatch");
    }
  }

  const { decodeChunkedManifest } = await import("../tip-browse/decode-wasm");
  const decoded = await decodeChunkedManifest(manifestBytes);
  if (decoded.chunk_count !== n) {
    throw new Error(
      `manifest chunk_count ${decoded.chunk_count} != split ${n}`,
    );
  }

  return {
    manifestHashHex,
    totalSize: packBytes.length,
    chunkCount: n,
    chunkSize,
    chunkHashesHex,
  };
}

/** Re-PUT a SinglePack or one content-addressed blob (rescue). */
export async function rescuePutBytes(bytes: Uint8Array): Promise<string> {
  const { hashHex } = await putPackBytes(bytes);
  return hashHex;
}

/**
 * Re-split reassembled pack bytes and re-PUT chunks + manifest (rescue).
 * Uses the same chunk_size as the original publish when provided.
 */
export async function rescueRepublishChunkedPack(
  packBytes: Uint8Array,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  onProgress?: (p: ChunkedPublishProgress) => void,
): Promise<PublishedChunkedPack> {
  if (packBytes.length <= chunkSize) {
    const hashHex = await rescuePutBytes(packBytes);
    return {
      manifestHashHex: hashHex,
      totalSize: packBytes.length,
      chunkCount: 1,
      chunkSize,
      chunkHashesHex: [hashHex],
    };
  }
  return publishChunkedPackPhases(packBytes, { chunkSize, onProgress });
}
