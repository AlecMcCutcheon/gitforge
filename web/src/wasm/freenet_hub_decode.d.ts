/* tslint:disable */
/* eslint-disable */
/**
 * Decode freenet-git `RepoState` bytes into a JSON tip-browse summary.
 */
export function summarize_repo_state(state_bytes: Uint8Array): string;
/**
 * Pick the tip bundle for a branch/ref short name or "HEAD". Returns JSON
 * `{ commit, bundle }` or an error if tip-browse is unsupported.
 */
export function pick_tip_bundle(state_bytes: Uint8Array, git_ref: string): string;
/**
 * Decode a ChunkedPack manifest (bincode) to JSON `{ chunk_size, total_size, chunk_count, chunk_hashes: string[] }`.
 */
export function decode_chunked_manifest(manifest_bytes: Uint8Array): string;
/**
 * Split `pack_bytes` and encode a ChunkedPackManifestV1 (bincode). Wire format
 * must match freenet-git `types::chunked` — do not hand-roll bincode in TS.
 */
export function encode_chunked_manifest(pack_bytes: Uint8Array, chunk_size: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly decode_chunked_manifest: (a: number, b: number) => [number, number, number, number];
  readonly encode_chunked_manifest: (a: number, b: number, c: number) => [number, number, number, number];
  readonly pick_tip_bundle: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly summarize_repo_state: (a: number, b: number) => [number, number, number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
