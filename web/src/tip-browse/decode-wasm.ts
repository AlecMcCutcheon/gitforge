/**
 * Load freenet-forge-decode wasm (RepoState / tip / chunked-manifest helpers).
 */

export interface TipBundle {
  bundle_id: string;
  tip_commit: string;
  kind: string;
  pack_hash?: string | null;
  size_bytes?: number | null;
  manifest_hash?: string | null;
  total_size?: number | null;
  chunk_count?: number | null;
}

export interface PickTipResult {
  commit: string;
  bundle: TipBundle;
  default_branch?: string | null;
  mirror_mode?: string | null;
}

export interface ChunkedManifest {
  version: number;
  chunk_size: number;
  total_size: number;
  chunk_count: number;
  chunk_hashes: string[];
}

interface DecodeWasm {
  summarize_repo_state(bytes: Uint8Array): string;
  pick_tip_bundle(bytes: Uint8Array, gitRef: string): string;
  decode_chunked_manifest(bytes: Uint8Array): string;
  encode_chunked_manifest(bytes: Uint8Array, chunkSize: number): Uint8Array;
}

let wasmPromise: Promise<DecodeWasm> | null = null;

async function loadWasm(): Promise<DecodeWasm> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      // Built artifact: copy from decode-wasm/pkg after `npm run build:wasm`
      const mod = await import("../wasm/freenet_forge_decode.js");
      const wasmUrl = new URL("../wasm/freenet_forge_decode_bg.wasm", import.meta.url);
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // await mod.default(wasmUrl);
      // NEW CODE - TESTING: wasm-bindgen wants a single options object
      await mod.default({ module_or_path: wasmUrl });
      return mod as unknown as DecodeWasm;
    })();
  }
  return wasmPromise;
}

export async function summarizeRepoState(stateBytes: Uint8Array): Promise<unknown> {
  const w = await loadWasm();
  return JSON.parse(w.summarize_repo_state(stateBytes));
}

export async function pickTipBundle(
  stateBytes: Uint8Array,
  gitRef: string,
): Promise<PickTipResult> {
  const w = await loadWasm();
  return JSON.parse(w.pick_tip_bundle(stateBytes, gitRef)) as PickTipResult;
}

export async function decodeChunkedManifest(
  manifestBytes: Uint8Array,
): Promise<ChunkedManifest> {
  const w = await loadWasm();
  return JSON.parse(w.decode_chunked_manifest(manifestBytes)) as ChunkedManifest;
}

/** Encode ChunkedPackManifestV1 (bincode) via freenet-git-types — wire-compatible. */
export async function encodeChunkedManifest(
  packBytes: Uint8Array,
  chunkSize: number,
): Promise<Uint8Array> {
  const w = await loadWasm();
  return w.encode_chunked_manifest(packBytes, chunkSize);
}

export async function wasmAvailable(): Promise<boolean> {
  try {
    await loadWasm();
    return true;
  } catch {
    return false;
  }
}
