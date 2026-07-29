/**
 * Undeltified git pack v2 encode for Freenet first-commit push.
 * Mirrors tip-browse/pack-decode.ts object hashing + pack framing.
 */
import { zlibSync } from "fflate";
import { sha1 as sha1Bytes } from "@noble/hashes/sha1";

export type GitObjType = "commit" | "tree" | "blob" | "tag";

const TYPE_CODE: Record<GitObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

export function hexToBytesFlexible(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Git object id: SHA-1(`type size\\0` ‖ payload). */
export function hashGitObject(
  type: GitObjType,
  data: Uint8Array,
): { hashHex: string; hashBytes: Uint8Array; store: Uint8Array } {
  const header = new TextEncoder().encode(`${type} ${data.length}\0`);
  const store = concatBytes([header, data]);
  const hashBytes = sha1Bytes(store);
  return { hashHex: bytesToHex(hashBytes), hashBytes, store: data };
}

export function encodeBlob(content: Uint8Array | string): {
  type: "blob";
  data: Uint8Array;
  hashHex: string;
  hashBytes: Uint8Array;
} {
  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const { hashHex, hashBytes } = hashGitObject("blob", data);
  return { type: "blob", data, hashHex, hashBytes };
}

export interface TreeEntryInput {
  name: string;
  /** e.g. 100644 for file, 40000 for tree */
  mode: string;
  hashBytes: Uint8Array;
}

/** Git tree body: sorted by name (`mode SP name NUL sha1`). */
export function encodeTree(entries: TreeEntryInput[]): {
  type: "tree";
  data: Uint8Array;
  hashHex: string;
  hashBytes: Uint8Array;
} {
  const sorted = [...entries].sort((a, b) => {
    // Git sorts by name with a trailing slash for trees — approximate with mode.
    const an = a.mode === "40000" ? `${a.name}/` : a.name;
    const bn = b.mode === "40000" ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    if (e.hashBytes.length !== 20) {
      throw new Error(`tree entry ${e.name}: hash must be 20 bytes`);
    }
    if (e.name.includes("\0") || e.name.includes("/")) {
      throw new Error(`invalid tree entry name: ${e.name}`);
    }
    const head = new TextEncoder().encode(`${e.mode} ${e.name}\0`);
    parts.push(head, e.hashBytes);
  }
  const data = concatBytes(parts);
  const { hashHex, hashBytes } = hashGitObject("tree", data);
  return { type: "tree", data, hashHex, hashBytes };
}

export function encodeCommit(input: {
  treeHashBytes: Uint8Array;
  parents?: Uint8Array[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds */
  when?: number;
  message: string;
}): {
  type: "commit";
  data: Uint8Array;
  hashHex: string;
  hashBytes: Uint8Array;
} {
  if (input.treeHashBytes.length !== 20) {
    throw new Error("tree hash must be 20 bytes");
  }
  const when = input.when ?? Math.floor(Date.now() / 1000);
  const tz = "+0000";
  const ident = `${input.authorName} <${input.authorEmail}> ${when} ${tz}`;
  const msg = input.message.endsWith("\n")
    ? input.message
    : `${input.message}\n`;
  const header =
    `tree ${bytesToHex(input.treeHashBytes)}\n` +
    (input.parents ?? [])
      .map((p) => {
        if (p.length !== 20) throw new Error("parent hash must be 20 bytes");
        return `parent ${bytesToHex(p)}\n`;
      })
      .join("") +
    `author ${ident}\n` +
    `committer ${ident}\n` +
    `\n` +
    msg;
  const data = new TextEncoder().encode(header);
  const { hashHex, hashBytes } = hashGitObject("commit", data);
  return { type: "commit", data, hashHex, hashBytes };
}

function writeTypeSizeHeader(typeCode: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

export interface PackObject {
  type: GitObjType;
  data: Uint8Array;
}

/** Pack v2 with undeltified objects + SHA-1 trailer. */
export function encodePack(objects: PackObject[]): Uint8Array {
  if (!objects.length) throw new Error("pack needs at least one object");
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header[0] = 0x50; // P
  header[1] = 0x41; // A
  header[2] = 0x43; // C
  header[3] = 0x4b; // K
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, objects.length, false);
  chunks.push(header);

  for (const obj of objects) {
    const code = TYPE_CODE[obj.type];
    chunks.push(writeTypeSizeHeader(code, obj.data.length));
    chunks.push(zlibSync(obj.data, { level: 6 }));
  }

  const body = concatBytes(chunks);
  const trailer = sha1Bytes(body);
  return concatBytes([body, trailer]);
}

export interface CommitFile {
  path: string;
  content: string | Uint8Array;
}

interface BuiltObj {
  type: GitObjType;
  data: Uint8Array;
  hashBytes: Uint8Array;
  hashHex: string;
}

/**
 * Build a root tree covering all paths (nested dirs supported).
 * Returns pack objects in commit → trees → blobs order plus tip commit hash.
 */
export function buildCommitFromFiles(input: {
  files: CommitFile[];
  authorName: string;
  authorEmail: string;
  message: string;
  parents?: Uint8Array[];
  when?: number;
}): {
  tipHashHex: string;
  tipHashBytes: Uint8Array;
  objects: PackObject[];
} {
  if (!input.files.length) throw new Error("need at least one file");

  const blobs = new Map<string, BuiltObj>();
  const fileNodes: Array<{ path: string; hashBytes: Uint8Array }> = [];

  for (const f of input.files) {
    const path = f.path.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!path || path.includes("..") || path.endsWith("/")) {
      throw new Error(`bad path: ${f.path}`);
    }
    const blob = encodeBlob(f.content);
    blobs.set(blob.hashHex, blob);
    fileNodes.push({ path, hashBytes: blob.hashBytes });
  }

  /** dir path "" = root → list of entries */
  type Node = {
    files: Array<{ name: string; hashBytes: Uint8Array }>;
    dirs: Map<string, Node>;
  };
  const root: Node = { files: [], dirs: new Map() };

  for (const { path, hashBytes } of fileNodes) {
    const parts = path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      let next = cur.dirs.get(part);
      if (!next) {
        next = { files: [], dirs: new Map() };
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.files.push({ name: parts[parts.length - 1]!, hashBytes });
  }

  const trees: BuiltObj[] = [];
  function buildNode(node: Node): BuiltObj {
    const entries: TreeEntryInput[] = [];
    for (const [name, child] of node.dirs) {
      const t = buildNode(child);
      entries.push({ name, mode: "40000", hashBytes: t.hashBytes });
    }
    for (const f of node.files) {
      entries.push({ name: f.name, mode: "100644", hashBytes: f.hashBytes });
    }
    const tree = encodeTree(entries);
    trees.push(tree);
    return tree;
  }

  const rootTree = buildNode(root);
  const commit = encodeCommit({
    treeHashBytes: rootTree.hashBytes,
    parents: input.parents,
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    message: input.message,
    when: input.when,
  });

  const objects: PackObject[] = [
    { type: "commit", data: commit.data },
    ...trees.map((t) => ({ type: "tree" as const, data: t.data })),
    ...[...blobs.values()].map((b) => ({ type: "blob" as const, data: b.data })),
  ];

  return {
    tipHashHex: commit.hashHex,
    tipHashBytes: commit.hashBytes,
    objects,
  };
}

export function packFirstCommit(input: {
  files: CommitFile[];
  authorName: string;
  authorEmail: string;
  message: string;
}): {
  packBytes: Uint8Array;
  tipHashHex: string;
  tipHashBytes: Uint8Array;
} {
  const built = buildCommitFromFiles(input);
  const packBytes = encodePack(built.objects);
  return {
    packBytes,
    tipHashHex: built.tipHashHex,
    tipHashBytes: built.tipHashBytes,
  };
}
