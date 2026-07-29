/**
 * Binary detection — Linguist blob_helper: NUL in first 8KB ⇒ binary.
 */
const BINARY_CHECK = 8 * 1024;

export function isBinaryContent(content: string | Uint8Array | null | undefined): boolean {
  if (content == null) return false;
  if (typeof content === "string") {
    const n = Math.min(content.length, BINARY_CHECK);
    for (let i = 0; i < n; i++) {
      if (content.charCodeAt(i) === 0) return true;
    }
    return false;
  }
  const n = Math.min(content.byteLength, BINARY_CHECK);
  for (let i = 0; i < n; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}
