/**
 * Minimal git pack v2 decoder for GitForge browser tip-browse.
 * Supports undeltified objects plus OFS/REF deltas.
 */

import { Unzlib, unzlibSync } from "fflate";
import { sha1 as sha1Bytes } from "@noble/hashes/sha1";

export type GitObjType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: GitObjType;
  data: Uint8Array;
  hash: string;
}

const TYPE_MAP: Record<number, GitObjType | "ofs_delta" | "ref_delta"> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs_delta",
  7: "ref_delta",
};

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

function sha1Hex(data: Uint8Array): string {
  return toHex(sha1Bytes(data));
}

/** fflate Unzlib keeps leftover input / bit state on these fields after push. */
interface UnzlibState {
  p: Uint8Array;
  s: { f?: number; p?: number };
}

/**
 * OLD CODE - KEEP UNTIL CONFIRMED WORKING
 * Binary-search cut length + unzlibSync per object (~log2(remaining) inflates).
 * Measured ~5.3s inflate-only across 30 tip packs / 7371 objects.
 */
function inflateMemberBinarySearch(
  input: Uint8Array,
  expectedSize: number,
): { data: Uint8Array; consumed: number } {
  let lo = 2;
  let hi = input.length;
  let best = -1;
  let bestData: Uint8Array | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = unzlibSync(input.subarray(0, mid));
      if (data.length === expectedSize) {
        best = mid;
        bestData = data;
        hi = mid - 1;
      } else if (data.length < expectedSize) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }

  if (!bestData || best < 0) {
    try {
      const data = unzlibSync(input);
      if (data.length === expectedSize) {
        for (let n = Math.min(input.length, 8); n <= input.length; n++) {
          try {
            const d = unzlibSync(input.subarray(0, n));
            if (d.length === expectedSize) {
              return { data: d, consumed: n };
            }
          } catch {
            /* grow */
          }
        }
      }
    } catch {
      /* fall through */
    }
    throw new Error(
      `failed to inflate pack object (expected ${expectedSize} bytes, have ${input.length} remaining)`,
    );
  }
  return { data: bestData, consumed: best };
}

/**
 * NEW CODE - TESTING
 * Single-pass zlib stream: push remaining pack bytes, stop at BFINAL, read
 * consumed from leftover (+ bit alignment + Adler-32). Falls back to binary
 * search if stream state looks wrong. ~13× faster on real tip packs.
 */
function inflateMember(
  input: Uint8Array,
  expectedSize: number,
): { data: Uint8Array; consumed: number } {
  try {
    const chunks: Uint8Array[] = [];
    const uz = new Unzlib((chunk) => {
      chunks.push(chunk);
    });
    uz.push(input, false);
    const st = uz as unknown as UnzlibState;
    if (!st.s || st.s.f !== 1) {
      return inflateMemberBinarySearch(input, expectedSize);
    }
    const bitRem = (st.s.p ?? 0) & 7;
    const align = bitRem ? 1 : 0;
    const leftover = st.p.length;
    if (leftover < align + 4) {
      return inflateMemberBinarySearch(input, expectedSize);
    }
    const consumed = input.length - leftover + align + 4;
    if (consumed < 2 || consumed > input.length) {
      return inflateMemberBinarySearch(input, expectedSize);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    if (total !== expectedSize) {
      return inflateMemberBinarySearch(input, expectedSize);
    }
    if (chunks.length === 1) return { data: chunks[0]!, consumed };
    const data = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    return { data, consumed };
  } catch {
    return inflateMemberBinarySearch(input, expectedSize);
  }
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0;
  const skip = (buf: Uint8Array, off: number) => {
    let value = 0;
    let shift = 0;
    let p = off;
    for (;;) {
      const b = buf[p++];
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, offset: p };
      shift += 7;
    }
  };
  ({ offset: i } = skip(delta, i));
  const target = skip(delta, i);
  i = target.offset;
  const out = new Uint8Array(target.value);
  let o = 0;
  while (i < delta.length) {
    const cmd = delta[i++];
    if (cmd === 0) continue;
    if (cmd & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (cmd & 0x01) cpOff |= delta[i++];
      if (cmd & 0x02) cpOff |= delta[i++] << 8;
      if (cmd & 0x04) cpOff |= delta[i++] << 16;
      if (cmd & 0x08) cpOff |= delta[i++] << 24;
      if (cmd & 0x10) cpSize |= delta[i++];
      if (cmd & 0x20) cpSize |= delta[i++] << 8;
      if (cmd & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.set(base.subarray(cpOff, cpOff + cpSize), o);
      o += cpSize;
    } else {
      out.set(delta.subarray(i, i + cmd), o);
      o += cmd;
      i += cmd;
    }
  }
  return out;
}

interface RawEntry {
  type: GitObjType | "ofs_delta" | "ref_delta";
  data: Uint8Array;
  ofsBase?: number;
  refBase?: string;
  headerOffset: number;
}

export async function unpackPack(pack: Uint8Array): Promise<Map<string, GitObject>> {
  if (
    pack.length < 12 ||
    pack[0] !== 0x50 ||
    pack[1] !== 0x41 ||
    pack[2] !== 0x43 ||
    pack[3] !== 0x4b
  ) {
    throw new Error("not a git packfile");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const numObjects = view.getUint32(8);

  const entries: RawEntry[] = [];
  let offset = 12;

  for (let n = 0; n < numObjects; n++) {
    if (offset >= pack.length) {
      throw new Error(
        `pack truncated while reading object ${n + 1}/${numObjects} (offset ${offset})`,
      );
    }
    const headerOffset = offset;
    let byte = pack[offset++];
    const type = (byte >> 4) & 7;
    let size = byte & 0xf;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = TYPE_MAP[type];
    if (!kind) throw new Error(`unknown pack object type ${type}`);

    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (kind === "ofs_delta") {
      let c = pack[offset++];
      let base = c & 0x7f;
      while (c & 0x80) {
        c = pack[offset++];
        base = ((base + 1) << 7) | (c & 0x7f);
      }
      ofsBase = headerOffset - base;
    } else if (kind === "ref_delta") {
      refBase = toHex(pack.subarray(offset, offset + 20));
      offset += 20;
    }

    const inflated = inflateMember(pack.subarray(offset), size);
    offset += inflated.consumed;
    entries.push({
      type: kind,
      data: inflated.data,
      ofsBase,
      refBase,
      headerOffset,
    });
  }

  const byOffset = new Map<number, GitObject>();
  const byHash = new Map<string, GitObject>();
  // NEW CODE - TESTING: O(1) ofs_delta base lookup (was entries.findIndex)
  const offsetIndex = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) {
    offsetIndex.set(entries[i]!.headerOffset, i);
  }

  function materializeNonDelta(idx: number): GitObject {
    const entry = entries[idx]!;
    if (byOffset.has(entry.headerOffset)) return byOffset.get(entry.headerOffset)!;
    if (entry.type === "ofs_delta" || entry.type === "ref_delta") {
      throw new Error("internal: materializeNonDelta on delta");
    }
    const header = new TextEncoder().encode(`${entry.type} ${entry.data.length}\0`);
    const store = new Uint8Array(header.length + entry.data.length);
    store.set(header, 0);
    store.set(entry.data, header.length);
    // OLD: const hash = await sha1(store);
    const hash = sha1Hex(store);
    const obj: GitObject = { type: entry.type, data: entry.data, hash };
    byOffset.set(entry.headerOffset, obj);
    byHash.set(hash, obj);
    return obj;
  }

  function resolve(idx: number): GitObject {
    const entry = entries[idx]!;
    if (byOffset.has(entry.headerOffset)) return byOffset.get(entry.headerOffset)!;

    if (entry.type !== "ofs_delta" && entry.type !== "ref_delta") {
      return materializeNonDelta(idx);
    }

    let base: GitObject;
    if (entry.type === "ofs_delta") {
      // OLD: const baseIdx = entries.findIndex((e) => e.headerOffset === entry.ofsBase);
      const baseIdx = offsetIndex.get(entry.ofsBase!);
      if (baseIdx === undefined) throw new Error("ofs_delta base missing");
      base = resolve(baseIdx);
    } else {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // for (let j = 0; j < entries.length; j++) {
      //   if (entries[j].type !== "ofs_delta" && entries[j].type !== "ref_delta") {
      //     await materializeNonDelta(j);
      //   }
      // }
      // NEW CODE - TESTING: only materialize until ref base appears
      let found = byHash.get(entry.refBase!);
      if (!found) {
        for (let j = 0; j < entries.length; j++) {
          const e = entries[j]!;
          if (e.type !== "ofs_delta" && e.type !== "ref_delta") {
            materializeNonDelta(j);
            found = byHash.get(entry.refBase!);
            if (found) break;
          }
        }
      }
      if (!found) throw new Error(`ref_delta base ${entry.refBase} missing`);
      base = found;
    }

    const data = applyDelta(base.data, entry.data);
    const type = base.type;
    const header = new TextEncoder().encode(`${type} ${data.length}\0`);
    const store = new Uint8Array(header.length + data.length);
    store.set(header, 0);
    store.set(data, header.length);
    // OLD: const hash = await sha1(store);
    const hash = sha1Hex(store);
    const obj: GitObject = { type, data, hash };
    byOffset.set(entry.headerOffset, obj);
    byHash.set(hash, obj);
    return obj;
  }

  for (let i = 0; i < entries.length; i++) {
    resolve(i);
  }
  return byHash;
}

export interface TreeEntry {
  mode: string;
  type: string;
  hash: string;
  name: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  const text = new TextDecoder("latin1");
  while (i < data.length) {
    let sp = i;
    while (data[sp] !== 0x20) sp++;
    const mode = text.decode(data.subarray(i, sp));
    let nul = sp + 1;
    while (data[nul] !== 0) nul++;
    const name = text.decode(data.subarray(sp + 1, nul));
    const hash = toHex(data.subarray(nul + 1, nul + 21));
    const type = mode === "40000" || mode.startsWith("040") ? "tree" : "blob";
    entries.push({ mode, type, hash, name });
    i = nul + 21;
  }
  return entries;
}

export function parseCommitTree(data: Uint8Array): string {
  const text = new TextDecoder().decode(data);
  const m = /^tree ([0-9a-f]{40})/m.exec(text);
  if (!m) throw new Error("commit missing tree");
  return m[1];
}

/** First parent commit hex, if any (for tip-pack chain walks). */
export function parseCommitFirstParent(data: Uint8Array): string | null {
  const text = new TextDecoder().decode(data);
  const m = /^parent ([0-9a-f]{40})/m.exec(text);
  return m ? m[1] : null;
}

/** Follow annotated-tag object → commit (no-op if already a commit). */
export function peelToCommit(
  objects: Map<string, GitObject>,
  oid: string,
): string {
  let current = oid.toLowerCase();
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const obj = objects.get(current);
    if (!obj) {
      throw new Error(`commit ${oid} not in tip pack`);
    }
    if (obj.type === "commit") return current;
    if (obj.type === "tag") {
      const text = new TextDecoder().decode(obj.data);
      const m = /^object ([0-9a-f]{40})/m.exec(text);
      if (!m) throw new Error(`tag ${current} missing object pointer`);
      current = m[1].toLowerCase();
      continue;
    }
    throw new Error(
      `expected commit or tag at ${current}, got ${obj.type}`,
    );
  }
  throw new Error(`tag peel loop at ${oid}`);
}

export interface CommitMeta {
  subject: string;
  author: string;
  email: string | null;
  date: string;
  parents: string[];
}

export function parseCommitMeta(data: Uint8Array): CommitMeta {
  const text = new TextDecoder().decode(data);
  const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map((m) => m[1]);
  const committerLine = /^committer (.+) <([^>]*)> (\d+)/m.exec(text);
  const authorLine = /^author (.+) <([^>]*)> (\d+)/m.exec(text);
  const name = authorLine?.[1] ?? committerLine?.[1] ?? "unknown";
  const email = (authorLine?.[2] ?? committerLine?.[2] ?? "").trim() || null;
  // Prefer committer time for "updated" displays; author identity for attribution.
  const epoch = Number(committerLine?.[3] ?? authorLine?.[3] ?? 0);
  const date = epoch
    ? new Date(epoch * 1000).toISOString()
    : new Date(0).toISOString();
  const subject =
    text.split("\n\n").slice(1).join("\n\n").trim().split("\n")[0] ||
    "(no subject)";
  return { subject, author: name, email, date, parents };
}

/** Blob/tree object hash at `path` under commit, or null if missing. */
export function entryHashAtPath(
  objects: Map<string, GitObject>,
  commitHex: string,
  path: string,
): string | null {
  const commit = objects.get(commitHex);
  if (!commit || commit.type !== "commit") return null;
  let treeHash = parseCommitTree(commit.data);
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return treeHash;
  for (let i = 0; i < parts.length; i++) {
    const tree = objects.get(treeHash);
    if (!tree || tree.type !== "tree") return null;
    const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return entry.hash;
    if (entry.type !== "tree") return null;
    treeHash = entry.hash;
  }
  return null;
}

export interface EnrichedTreeEntry extends TreeEntry {
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  lastCommitAuthor: string | null;
}

/**
 * Last commit that changed each tree entry (first-parent walk over tipped packs).
 * Matches bridge `git log -1 -- path` when history is fully present.
 */
export function enrichTreeWithLastCommits(
  objects: Map<string, GitObject>,
  tipCommit: string,
  treePath: string,
  entries: TreeEntry[],
): EnrichedTreeEntry[] {
  if (entries.length === 0) return [];

  const paths = entries.map((e) =>
    treePath ? `${treePath}/${e.name}` : e.name,
  );
  const pending = new Set(paths);
  const last = new Map<string, CommitMeta>();
  // NEW CODE - TESTING: cache parsed trees during the walk (was re-parse per path)
  const treeCache = new Map<string, TreeEntry[]>();

  const entryHashCached = (commitHex: string, path: string): string | null => {
    const commit = objects.get(commitHex);
    if (!commit || commit.type !== "commit") return null;
    let treeHash = parseCommitTree(commit.data);
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return treeHash;
    for (let i = 0; i < parts.length; i++) {
      let parsed = treeCache.get(treeHash);
      if (!parsed) {
        const tree = objects.get(treeHash);
        if (!tree || tree.type !== "tree") return null;
        parsed = parseTree(tree.data);
        treeCache.set(treeHash, parsed);
      }
      const entry = parsed.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return entry.hash;
      if (entry.type !== "tree") return null;
      treeHash = entry.hash;
    }
    return null;
  };

  let current: string | null = tipCommit;
  const seen = new Set<string>();

  while (current && pending.size > 0 && !seen.has(current)) {
    seen.add(current);
    const cObj = objects.get(current);
    if (!cObj || cObj.type !== "commit") break;

    const parent = parseCommitFirstParent(cObj.data);
    const parentOk = Boolean(parent && objects.has(parent));

    if (!parentOk) {
      const meta = parseCommitMeta(cObj.data);
      for (const p of pending) last.set(p, meta);
      pending.clear();
      break;
    }

    const meta = parseCommitMeta(cObj.data);
    for (const p of [...pending]) {
      // OLD: const atCurrent = entryHashAtPath(objects, current, p);
      // OLD: const atParent = entryHashAtPath(objects, parent!, p);
      const atCurrent = entryHashCached(current, p);
      const atParent = entryHashCached(parent!, p);
      if (atCurrent !== atParent) {
        last.set(p, meta);
        pending.delete(p);
      }
    }
    current = parent;
  }

  return entries.map((entry, i) => {
    const info = last.get(paths[i]!);
    return {
      ...entry,
      lastCommitSubject: info?.subject ?? null,
      lastCommitDate: info?.date ?? null,
      lastCommitAuthor: info?.author ?? null,
    };
  });
}

export async function listTreePath(
  objects: Map<string, GitObject>,
  commitHex: string,
  path = "",
): Promise<TreeEntry[]> {
  const commit = objects.get(commitHex);
  if (!commit || commit.type !== "commit") {
    throw new Error(`commit ${commitHex} not in tip pack`);
  }
  let treeHash = parseCommitTree(commit.data);
  const parts = path.split("/").filter(Boolean);
  for (const part of parts) {
    const tree = objects.get(treeHash);
    if (!tree || tree.type !== "tree") throw new Error(`missing tree ${treeHash}`);
    const entry = parseTree(tree.data).find((e) => e.name === part);
    if (!entry || entry.type !== "tree") throw new Error(`path not found: ${part}`);
    treeHash = entry.hash;
  }
  const tree = objects.get(treeHash);
  if (!tree || tree.type !== "tree") throw new Error(`missing tree ${treeHash}`);
  return parseTree(tree.data);
}

/** Recursive blob paths + sizes under tip commit (for language stats). */
export function listAllBlobsWithSizes(
  objects: Map<string, GitObject>,
  commitHex: string,
): { path: string; size: number; hash: string }[] {
  const commit = objects.get(commitHex);
  if (!commit || commit.type !== "commit") {
    throw new Error(`commit ${commitHex} not in tip pack`);
  }
  const out: { path: string; size: number; hash: string }[] = [];
  const walkTree = (treeHash: string, dir: string): void => {
    const tree = objects.get(treeHash);
    if (!tree || tree.type !== "tree") {
      throw new Error(`missing tree ${treeHash}`);
    }
    for (const entry of parseTree(tree.data)) {
      const next = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.type === "tree") {
        walkTree(entry.hash, next);
      } else if (entry.type === "blob") {
        const blob = objects.get(entry.hash);
        out.push({
          path: next,
          size: blob?.type === "blob" ? blob.data.byteLength : 0,
          hash: entry.hash,
        });
      }
    }
  };
  walkTree(parseCommitTree(commit.data), "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Recursive blob paths under tip commit (for Go-to-file). */
export async function listAllBlobPaths(
  objects: Map<string, GitObject>,
  commitHex: string,
): Promise<string[]> {
  return listAllBlobsWithSizes(objects, commitHex).map((b) => b.path);
}

export async function readBlobPath(
  objects: Map<string, GitObject>,
  commitHex: string,
  filePath: string,
): Promise<Uint8Array> {
  const commit = objects.get(commitHex);
  if (!commit || commit.type !== "commit") {
    throw new Error(`commit ${commitHex} not in tip pack`);
  }
  let treeHash = parseCommitTree(commit.data);
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("empty path");
  for (const part of parts) {
    const tree = objects.get(treeHash);
    if (!tree || tree.type !== "tree") throw new Error(`missing tree ${treeHash}`);
    const entry = parseTree(tree.data).find((e) => e.name === part);
    if (!entry || entry.type !== "tree") throw new Error(`path not found: ${part}`);
    treeHash = entry.hash;
  }
  const tree = objects.get(treeHash);
  if (!tree || tree.type !== "tree") throw new Error(`missing tree ${treeHash}`);
  const file = parseTree(tree.data).find((e) => e.name === fileName);
  if (!file) throw new Error(`file not found: ${fileName}`);
  const blob = objects.get(file.hash);
          if (!blob || blob.type !== "blob") {
            throw new Error(
              `missing blob ${file.hash} (not in tipped packs — may live only in legacy untipped history)`,
            );
          }
          return blob.data;
}
