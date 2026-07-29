/**
 * Minimal ustar builder for Freenet website archives (matches fdev tar shape).
 */

const BLOCK = 512;

function encodeOctal(value: number, length: number): string {
  const s = value.toString(8);
  if (s.length > length - 1) {
    throw new Error(`octal field overflow: ${value} needs ${length}`);
  }
  return s.padStart(length - 1, "0") + "\0";
}

function writeString(buf: Uint8Array, offset: number, str: string, len: number): void {
  const bytes = new TextEncoder().encode(str);
  const n = Math.min(bytes.length, len - 1);
  buf.set(bytes.subarray(0, n), offset);
}

function checksumHeader(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // checksum field treated as spaces during calculation
    if (i >= 148 && i < 156) sum += 32;
    else sum += header[i]!;
  }
  return sum;
}

function fileHeader(name: string, size: number, mtimeSec: number): Uint8Array {
  if (name.length > 100) {
    throw new Error(`path too long for ustar (max 100): ${name}`);
  }
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, name, 100);
  header.set(new TextEncoder().encode(encodeOctal(0o644, 8)), 100); // mode
  header.set(new TextEncoder().encode(encodeOctal(0, 8)), 108); // uid
  header.set(new TextEncoder().encode(encodeOctal(0, 8)), 116); // gid
  header.set(new TextEncoder().encode(encodeOctal(size, 12)), 124);
  header.set(new TextEncoder().encode(encodeOctal(mtimeSec, 12)), 136);
  // checksum placeholder
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0); // typeflag regular file
  writeString(header, 257, "ustar", 6);
  writeString(header, 263, "00", 2);
  const sum = checksumHeader(header);
  const sumStr = encodeOctal(sum, 7) + " ";
  header.set(new TextEncoder().encode(sumStr.slice(0, 8)), 148);
  return header;
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/**
 * Build an uncompressed ustar archive from a path → bytes map.
 * Paths must be relative, no `..`, max 100 chars (ustar name field).
 */
export function buildUstarArchive(files: Map<string, Uint8Array>): Uint8Array {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Uint8Array[] = [];
  const names = [...files.keys()].sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    const data = files.get(name)!;
    const path = name.replace(/^\/+/, "");
    if (!path || path.includes("..") || path.startsWith("/")) {
      throw new Error(`invalid archive path: ${name}`);
    }
    parts.push(fileHeader(path, data.length, mtime));
    parts.push(data);
    const pad = padToBlock(data.length);
    if (pad) parts.push(new Uint8Array(pad));
  }

  // two empty blocks end the archive
  parts.push(new Uint8Array(BLOCK * 2));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Pack WebApp state: u64be(metaLen) || meta || u64be(webLen) || web */
export function packWebAppState(
  metadata: Uint8Array,
  compressedWeb: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(8 + metadata.length + 8 + compressedWeb.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(metadata.length), false);
  out.set(metadata, 8);
  view.setBigUint64(8 + metadata.length, BigInt(compressedWeb.length), false);
  out.set(compressedWeb, 16 + metadata.length);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
