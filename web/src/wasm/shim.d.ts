declare module "../wasm/freenet_forge_decode.js" {
  export function summarize_repo_state(state_bytes: Uint8Array): string;
  export function pick_tip_bundle(state_bytes: Uint8Array, git_ref: string): string;
  export function decode_chunked_manifest(manifest_bytes: Uint8Array): string;
  export default function init(
    module_or_path?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module,
  ): Promise<unknown>;
}
