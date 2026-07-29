import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCacheRoot } from "./env.js";
import { runCommand } from "./run.js";

const TEXT_INLINE_MAX = 512 * 1024;
const IMAGE_INLINE_MAX = 5 * 1024 * 1024;

export interface TipEnsureResult {
  prefix: string;
  git_ref: string;
  commit: string;
  bundle_id: string;
  git_dir: string;
  pack_path: string;
  mirror_mode: string | null;
  tip_pack_size: number;
  tipped_packs?: number;
  default_branch: string | null;
  name?: string | null;
  description?: string | null;
}

export interface TipTreeEntry {
  mode: string;
  type: string;
  hash: string;
  name: string;
  lastCommitSubject?: string | null;
  lastCommitDate?: string | null;
  lastCommitAuthor?: string | null;
}

export interface TipBlobResult {
  path: string;
  size: number;
  mediaType: string;
  binary: boolean;
  tooLarge: boolean;
  text: string | null;
  contentBase64: string | null;
  commit: string;
  tipPackSize: number;
}

function tipBinaryPath(): string {
  if (process.env.FREENET_HUB_TIP_BIN) {
    return process.env.FREENET_HUB_TIP_BIN;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Prefer workspace target (cargo --workspace), then browse-tool/target.
  const candidates = [
    path.resolve(here, "../../target/release/freenet-hub-tip"),
    path.resolve(here, "../../browse-tool/target/release/freenet-hub-tip"),
  ];
  for (const p of candidates) {
    try {
      fsSync.accessSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return candidates[0]!;
}

export interface TipMetaResult {
  prefix: string;
  name: string | null;
  description: string | null;
  default_branch: string | null;
  refs_count: number;
  empty: boolean;
}

/** GET RepoState only — works for empty repos (no tip pack). */
export async function tipRepoMeta(prefix: string): Promise<TipMetaResult> {
  const bin = tipBinaryPath();
  const timeoutMs = Number(process.env.FREENET_HUB_TIP_TIMEOUT_MS ?? 90_000);
  const result = await runCommand(
    bin,
    ["meta", "--prefix", prefix, "--timeout-secs", String(Math.ceil(timeoutMs / 1000))],
    { timeoutMs },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "freenet-hub-tip meta failed");
  }
  const line = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) {
    throw new Error("freenet-hub-tip meta produced no JSON");
  }
  const parsed = JSON.parse(line) as {
    prefix: string;
    name?: string | null;
    description?: string | null;
    default_branch?: string | null;
    refs_count?: number;
    empty?: boolean;
  };
  return {
    prefix: parsed.prefix,
    name: parsed.name?.trim() || null,
    description: parsed.description?.trim() || null,
    default_branch: parsed.default_branch ?? null,
    refs_count: parsed.refs_count ?? 0,
    empty: Boolean(parsed.empty),
  };
}

async function tipCacheRoot(): Promise<string> {
  if (process.env.FREENET_HUB_TIP_CACHE) {
    return path.resolve(process.env.FREENET_HUB_TIP_CACHE);
  }
  // Sibling of repos cache: ~/.local/share/freenet-hub/tips
  const reposRoot = await ensureCacheRoot();
  return path.join(path.dirname(reposRoot), "tips");
}

export async function ensureTipPack(
  prefix: string,
  gitRef = "HEAD",
): Promise<TipEnsureResult> {
  const bin = tipBinaryPath();
  const cache = await tipCacheRoot();
  const timeoutMs = Number(process.env.FREENET_HUB_TIP_TIMEOUT_MS ?? 300_000);
  const retries = Number(process.env.FREENET_HUB_TIP_RETRIES ?? 3);

  const result = await runCommand(
    bin,
    [
      "ensure",
      "--prefix",
      prefix,
      "--git-ref",
      gitRef,
      "--cache-root",
      cache,
      "--retries",
      String(retries),
    ],
    { timeoutMs },
  );

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "tip ensure failed").trim();
    throw Object.assign(new Error(detail), {
      tipBrowse: true,
      legacyOnly: detail.toLowerCase().includes("tip-browse unsupported"),
      chunkedTimeout:
        detail.toLowerCase().includes("inactivity timeout") ||
        detail.toLowerCase().includes("no fragments"),
    });
  }

  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((l) => l.startsWith("{"));
  if (!jsonLine) {
    throw new Error(
      `freenet-hub-tip produced no JSON (stderr: ${result.stderr.slice(0, 500)})`,
    );
  }
  return JSON.parse(jsonLine) as TipEnsureResult;
}

export async function tipListTree(
  prefix: string,
  gitRef: string,
  treePath = "",
): Promise<{
  ref: string;
  path: string;
  commit: string;
  tipPackSize: number;
  entries: TipTreeEntry[];
  progress: string;
}> {
  const tip = await ensureTipPack(prefix, gitRef);
  const spec = treePath ? `${tip.commit}:${treePath}` : tip.commit;
  const result = await runCommand(
    "git",
    ["--git-dir", tip.git_dir, "ls-tree", spec],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git ls-tree failed on tip pack");
  }
  const baseEntries = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split("\t");
      const [mode, type, hash] = meta.split(/\s+/);
      return { mode, type, hash, name };
    });

  const entries = await enrichTreeWithLastCommits(
    tip.git_dir,
    tip.commit,
    treePath,
    baseEntries,
  );

  return {
    ref: gitRef,
    path: treePath,
    commit: tip.commit,
    tipPackSize: tip.tip_pack_size,
    entries,
    progress: `Loaded file tree from ${tip.tipped_packs ?? "?"} tipped pack(s) (${formatBytes(tip.tip_pack_size)})`,
  };
}

async function enrichTreeWithLastCommits(
  gitDir: string,
  commit: string,
  treePath: string,
  entries: Array<{ mode: string; type: string; hash: string; name: string }>,
): Promise<TipTreeEntry[]> {
  const concurrency = 8;
  const out: TipTreeEntry[] = new Array(entries.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= entries.length) return;
      const entry = entries[i];
      const filePath = treePath ? `${treePath}/${entry.name}` : entry.name;
      const log = await runCommand(
        "git",
        [
          "--git-dir",
          gitDir,
          "log",
          "-1",
          "--format=%s%x09%cI%x09%an",
          commit,
          "--",
          filePath,
        ],
        { timeoutMs: 15_000 },
      );
      if (log.code === 0 && log.stdout.trim()) {
        const [subject, date, author] = log.stdout.trim().split("\t");
        out[i] = {
          ...entry,
          lastCommitSubject: subject || null,
          lastCommitDate: date || null,
          lastCommitAuthor: author || null,
        };
      } else {
        out[i] = {
          ...entry,
          lastCommitSubject: null,
          lastCommitDate: null,
          lastCommitAuthor: null,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, () =>
      worker(),
    ),
  );
  return out;
}

function sniffMediaType(
  filePath: string,
  buf: Buffer,
): { mediaType: string; textLike: boolean; image: boolean } {
  const lower = filePath.toLowerCase();
  const imageExt: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  for (const [ext, type] of Object.entries(imageExt)) {
    if (lower.endsWith(ext)) {
      return { mediaType: type, textLike: false, image: true };
    }
  }
  const textExt = [
    ".md",
    ".txt",
    ".rs",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".toml",
    ".yaml",
    ".yml",
    ".css",
    ".html",
    ".htm",
    ".py",
    ".go",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".java",
    ".sh",
    ".bash",
    ".zsh",
    ".env",
    ".gitignore",
    ".editorconfig",
    ".lock",
    ".svg",
  ];
  if (textExt.some((e) => lower.endsWith(e)) || !path.basename(lower).includes(".")) {
    if (!buf.includes(0)) {
      return { mediaType: "text/plain", textLike: true, image: false };
    }
  }
  if (!buf.includes(0)) {
    return { mediaType: "text/plain", textLike: true, image: false };
  }
  return { mediaType: "application/octet-stream", textLike: false, image: false };
}

/** Resolve path → blob OID then cat-file (works once tipped packs are indexed). */
async function readBlobBytes(
  gitDir: string,
  commit: string,
  filePath: string,
): Promise<Buffer> {
  const listed = await runCommand(
    "git",
    ["--git-dir", gitDir, "ls-tree", commit, "--", filePath],
    { timeoutMs: 30_000 },
  );
  if (listed.code !== 0 || !listed.stdout.trim()) {
    throw new Error(
      listed.stderr ||
        `path not found in tip tree: ${filePath} (commit ${commit.slice(0, 12)})`,
    );
  }
  const line = listed.stdout.trim().split("\n")[0];
  const [meta] = line.split("\t");
  const parts = meta.split(/\s+/);
  const type = parts[1];
  const hash = parts[2];
  if (type !== "blob" || !hash) {
    throw new Error(`expected a blob at ${filePath}, got ${type ?? "unknown"}`);
  }

  const result = await runCommand(
    "git",
    ["--git-dir", gitDir, "cat-file", "-p", hash],
    { timeoutMs: 60_000, binary: true },
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr ||
        `blob ${hash.slice(0, 12)} for ${filePath} missing from tipped packs ` +
          `(tree entry exists but object bytes were not in any tipped pack)`,
    );
  }
  return result.stdoutBuffer ?? Buffer.from(result.stdout ?? "", "utf8");
}

export async function tipShowBlob(
  prefix: string,
  gitRef: string,
  filePath: string,
): Promise<TipBlobResult> {
  const tip = await ensureTipPack(prefix, gitRef);
  const buf = await readBlobBytes(tip.git_dir, tip.commit, filePath);
  const size = buf.length;
  const sniffed = sniffMediaType(filePath, buf);
  const binary = !sniffed.textLike;
  let tooLarge = false;
  let text: string | null = null;
  let contentBase64: string | null = null;

  if (sniffed.image) {
    if (size <= IMAGE_INLINE_MAX) {
      contentBase64 = buf.toString("base64");
    } else {
      tooLarge = true;
    }
  } else if (sniffed.textLike) {
    if (size <= TEXT_INLINE_MAX) {
      text = buf.toString("utf8");
    } else {
      tooLarge = true;
      contentBase64 = null;
    }
  } else {
    tooLarge = true;
  }

  return {
    path: filePath,
    size,
    mediaType: sniffed.mediaType,
    binary,
    tooLarge,
    text,
    contentBase64,
    commit: tip.commit,
    tipPackSize: tip.tip_pack_size,
  };
}

export async function tipRawBlob(
  prefix: string,
  gitRef: string,
  filePath: string,
): Promise<{ buf: Buffer; mediaType: string; filename: string }> {
  const tip = await ensureTipPack(prefix, gitRef);
  const buf = await readBlobBytes(tip.git_dir, tip.commit, filePath);
  const sniffed = sniffMediaType(filePath, buf);
  return {
    buf,
    mediaType: sniffed.mediaType,
    filename: path.basename(filePath),
  };
}

export interface BlameLine {
  line: number;
  content: string;
  commit: string;
  short: string;
  author: string;
  date: string;
  summary: string;
}

export async function tipBlame(
  prefix: string,
  gitRef: string,
  filePath: string,
): Promise<{
  path: string;
  commit: string;
  lines: BlameLine[];
  note: string;
}> {
  const tip = await ensureTipPack(prefix, gitRef);
  const result = await runCommand(
    "git",
    [
      "--git-dir",
      tip.git_dir,
      "blame",
      "--line-porcelain",
      tip.commit,
      "--",
      filePath,
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr ||
        `git blame failed for ${filePath} (blame needs commits present in tipped packs)`,
    );
  }

  const lines: BlameLine[] = [];
  const raw = result.stdout.split("\n");
  let i = 0;
  let lineNo = 0;
  while (i < raw.length) {
    const header = raw[i];
    if (!header || !/^[0-9a-f]{40}\s/.test(header)) {
      i += 1;
      continue;
    }
    const parts = header.split(" ");
    const commit = parts[0];
    let author = "unknown";
    let authorTime = "";
    let summary = "";
    i += 1;
    while (i < raw.length && !raw[i].startsWith("\t")) {
      const row = raw[i];
      if (row.startsWith("author ")) author = row.slice(7);
      else if (row.startsWith("author-time ")) authorTime = row.slice(12);
      else if (row.startsWith("summary ")) summary = row.slice(8);
      i += 1;
    }
    const content = i < raw.length && raw[i].startsWith("\t") ? raw[i].slice(1) : "";
    if (i < raw.length && raw[i].startsWith("\t")) i += 1;
    lineNo += 1;
    const date =
      authorTime && !Number.isNaN(Number(authorTime))
        ? new Date(Number(authorTime) * 1000).toISOString()
        : "";
    lines.push({
      line: lineNo,
      content,
      commit,
      short: commit.slice(0, 7),
      author,
      date,
      summary,
    });
  }

  return {
    path: filePath,
    commit: tip.commit,
    lines,
    note: "Blame uses commits present in tipped packs only; older lines may attribute to the oldest tipped ancestor available.",
  };
}

export async function tipListCommits(
  prefix: string,
  gitRef: string,
  limit = 20,
): Promise<{
  ref: string;
  commit: string;
  commits: Array<{
    hash: string;
    short: string;
    subject: string;
    author: string;
    date: string;
  }>;
  note: string;
}> {
  const tip = await ensureTipPack(prefix, gitRef);
  const format = "%H%x09%h%x09%s%x09%an%x09%cI";
  // Tip pack may only contain the tip commit (+ parents if present in pack).
  const result = await runCommand(
    "git",
    [
      "--git-dir",
      tip.git_dir,
      "log",
      tip.commit,
      `-n${limit}`,
      `--format=${format}`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    // Fall back to single commit metadata via cat-file
    const show = await runCommand(
      "git",
      [
        "--git-dir",
        tip.git_dir,
        "show",
        "-s",
        `--format=${format}`,
        tip.commit,
      ],
      { timeoutMs: 15_000 },
    );
    if (show.code !== 0) {
      throw new Error(result.stderr || "git log failed on tip pack");
    }
    const [hash, short, subject, author, date] = show.stdout
      .trim()
      .split("\t");
    return {
      ref: gitRef,
      commit: tip.commit,
      commits: [{ hash, short, subject, author, date }],
      note: "Tip pack only — full history may live in legacy packs (not fetched).",
    };
  }
  const commits = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, date] = line.split("\t");
      return { hash, short, subject, author, date };
    });
  return {
    ref: gitRef,
    commit: tip.commit,
    commits,
    note: "Commits reachable inside the tip pack only (legacy packs not downloaded).",
  };
}

const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export interface TipBranchRow {
  name: string;
  hash: string;
  short: string;
  isDefault: boolean;
  author: string | null;
  date: string | null;
  /** Null when tip packs cannot compute divergence. */
  behind: number | null;
  ahead: number | null;
  stale: boolean;
}

/** Branch table rows for GitHub-like Branches page (tip-pack enrichment). */
export async function tipListBranches(
  prefix: string,
  defaultBranch: string,
  refs: Array<{ hash: string; name: string }>,
): Promise<{
  defaultBranch: string;
  branches: TipBranchRow[];
  note: string;
}> {
  const heads = refs
    .filter((r) => r.name.startsWith("refs/heads/"))
    .map((r) => ({
      name: r.name.replace(/^refs\/heads\//, ""),
      hash: r.hash,
    }));

  const defaultName =
    defaultBranch.replace(/^refs\/heads\//, "") || heads[0]?.name || "main";

  const rows: TipBranchRow[] = [];
  const concurrency = 3;
  let i = 0;
  async function worker() {
    while (i < heads.length) {
      const idx = i;
      i += 1;
      const head = heads[idx];
      let author: string | null = null;
      let date: string | null = null;
      let short = head.hash.slice(0, 7);
      try {
        const tip = await ensureTipPack(prefix, head.name);
        short = tip.commit.slice(0, 7);
        const show = await runCommand(
          "git",
          [
            "--git-dir",
            tip.git_dir,
            "show",
            "-s",
            "--format=%an%x09%cI%x09%h",
            tip.commit,
          ],
          { timeoutMs: 20_000 },
        );
        if (show.code === 0) {
          const [a, d, h] = show.stdout.trim().split("\t");
          author = a || null;
          date = d || null;
          if (h) short = h;
        }
      } catch {
        /* tip unavailable — still list the ref */
      }
      const age = date ? Date.now() - Date.parse(date) : 0;
      const stale = date ? age > STALE_AFTER_MS : false;
      rows.push({
        name: head.name,
        hash: head.hash,
        short,
        isDefault: head.name === defaultName,
        author,
        date,
        behind: null,
        ahead: null,
        stale,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, heads.length) }, () => worker()),
  );

  rows.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    const ad = a.date ? Date.parse(a.date) : 0;
    const bd = b.date ? Date.parse(b.date) : 0;
    return bd - ad;
  });

  return {
    defaultBranch: defaultName,
    branches: rows,
    note: "Updated times from tip packs. Ahead/behind needs shared history (not available in tip-browse).",
  };
}

export interface TipContributor {
  name: string;
  email: string | null;
  commits: number;
  /** Stable id for React keys / merge. */
  slug: string;
}

function normalizeContributorName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function contributorSlug(name: string, email?: string | null): string {
  const em = (email ?? "").trim().toLowerCase();
  if (
    em.includes("@") &&
    !em.includes("noreply") &&
    !em.endsWith(".local")
  ) {
    return em.replace(/[^a-z0-9._+-@]/g, "");
  }
  const fromName = normalizeContributorName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromName || "unknown";
}

/** Authors ranked by commit count inside tipped packs. */
export async function tipListContributors(
  prefix: string,
  gitRef: string,
): Promise<{
  ref: string;
  commit: string;
  repoName: string | null;
  description: string | null;
  contributors: TipContributor[];
  /** Heuristic owner = most commits in tipped history. */
  owner: TipContributor | null;
  note: string;
}> {
  const tip = await ensureTipPack(prefix, gitRef);
  const result = await runCommand(
    "git",
    [
      "--git-dir",
      tip.git_dir,
      "log",
      tip.commit,
      "--format=%aN%x09%aE",
    ],
    { timeoutMs: 30_000 },
  );

  const counts = new Map<string, TipContributor>();
  if (result.code === 0) {
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [nameRaw, emailRaw] = line.split("\t");
      const name = (nameRaw ?? "").trim() || "unknown";
      const email = (emailRaw ?? "").trim() || null;
      const key = `${normalizeContributorName(name)}\0${(email ?? "").toLowerCase()}`;
      const existing = counts.get(key);
      if (existing) {
        existing.commits += 1;
      } else {
        counts.set(key, {
          name,
          email,
          commits: 1,
          slug: contributorSlug(name, email),
        });
      }
    }
  } else {
    // Single tip commit fallback
    const show = await runCommand(
      "git",
      [
        "--git-dir",
        tip.git_dir,
        "show",
        "-s",
        "--format=%aN%x09%aE",
        tip.commit,
      ],
      { timeoutMs: 15_000 },
    );
    if (show.code === 0 && show.stdout.trim()) {
      const [nameRaw, emailRaw] = show.stdout.trim().split("\t");
      const name = (nameRaw ?? "").trim() || "unknown";
      const email = (emailRaw ?? "").trim() || null;
      counts.set("one", {
        name,
        email,
        commits: 1,
        slug: contributorSlug(name, email),
      });
    }
  }

  // Merge rows that share the same slug (name variants / email preference).
  const bySlug = new Map<string, TipContributor>();
  for (const c of counts.values()) {
    const prev = bySlug.get(c.slug);
    if (!prev) {
      bySlug.set(c.slug, { ...c });
      continue;
    }
    prev.commits += c.commits;
    if (!prev.email && c.email) prev.email = c.email;
    if (c.name.length > prev.name.length) prev.name = c.name;
  }

  const contributors = [...bySlug.values()].sort(
    (a, b) => b.commits - a.commits || a.name.localeCompare(b.name),
  );

  return {
    ref: gitRef,
    commit: tip.commit,
    repoName: tip.name ?? null,
    description: tip.description ?? null,
    contributors,
    owner: contributors[0] ?? null,
    note: "Contributors from tipped packs only.",
  };
}

/** Recursive paths for Go-to-file search. */
export async function tipListPaths(
  prefix: string,
  gitRef: string,
): Promise<{ commit: string; paths: string[] }> {
  const tip = await ensureTipPack(prefix, gitRef);
  const result = await runCommand(
    "git",
    ["--git-dir", tip.git_dir, "ls-tree", "-r", "--name-only", tip.commit],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git ls-tree -r failed on tip pack");
  }
  const paths = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { commit: tip.commit, paths };
}

/** Zip of tip tree (not full history). */
export async function tipArchiveZip(
  prefix: string,
  gitRef: string,
  label = "repo",
): Promise<{ buf: Buffer; filename: string; commit: string }> {
  const tip = await ensureTipPack(prefix, gitRef);
  const short = tip.commit.slice(0, 7);
  const safeLabel = label.replace(/[^A-Za-z0-9._~-]+/g, "-") || "repo";
  const filename = `${safeLabel}-${short}.zip`;
  const archived = await runCommand(
    "git",
    ["--git-dir", tip.git_dir, "archive", "--format=zip", tip.commit],
    { timeoutMs: 120_000, binary: true },
  );
  if (archived.code !== 0 || !archived.stdoutBuffer?.length) {
    throw new Error(archived.stderr || "git archive failed on tip pack");
  }
  return { buf: archived.stdoutBuffer, filename, commit: tip.commit };
}

/**
 * Best-effort tag metadata from tip pack.
 * Annotated tags expose a message (title = first line); lightweight tags have none.
 *
 * Tip packs often omit `refs/tags/*` refs — use the tip OID from ensure (tag or commit).
 */
export async function tipTagMeta(
  prefix: string,
  tagName: string,
): Promise<{
  name: string;
  commit: string;
  annotated: boolean;
  title: string | null;
  description: string | null;
}> {
  const tip = await ensureTipPack(prefix, tagName);
  const typeResult = await runCommand(
    "git",
    ["--git-dir", tip.git_dir, "cat-file", "-t", tip.commit],
    { timeoutMs: 15_000 },
  );
  const objType = typeResult.stdout.trim();
  if (objType === "tag") {
    const raw = await runCommand(
      "git",
      ["--git-dir", tip.git_dir, "cat-file", "-p", tip.commit],
      { timeoutMs: 15_000 },
    );
    if (raw.code === 0) {
      const text = raw.stdout;
      const objectLine = /^object ([0-9a-f]{40})$/m.exec(text);
      const peeled = objectLine?.[1] ?? tip.commit;
      const blank = text.indexOf("\n\n");
      const body = blank >= 0 ? text.slice(blank + 2).trim() : "";
      const lines = body.split("\n");
      const title = (lines[0] ?? "").trim() || tagName;
      const rest = lines.slice(1).join("\n").trim();
      return {
        name: tagName,
        commit: peeled,
        annotated: true,
        title,
        description: rest || null,
      };
    }
  }
  return {
    name: tagName,
    commit: tip.commit,
    annotated: false,
    title: tagName,
    description: null,
  };
}

export async function tipReadme(
  prefix: string,
  gitRef: string,
): Promise<{ path: string | null; content: string | null; ref: string }> {
  const names = ["README.md", "README.MD", "Readme.md", "README", "readme.md"];
  for (const name of names) {
    try {
      const blob = await tipShowBlob(prefix, gitRef, name);
      if (blob.text != null) {
        return { path: name, content: blob.text, ref: gitRef };
      }
    } catch {
      /* try next */
    }
  }
  return { path: null, content: null, ref: gitRef };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export async function tipBinaryExists(): Promise<boolean> {
  try {
    await fs.access(tipBinaryPath());
    return true;
  } catch {
    return false;
  }
}
