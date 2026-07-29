import fs from "node:fs/promises";
import path from "node:path";
import { ensureCacheRoot } from "./env.js";
import { classifyFreenetError, isPeerExhausted, runCommand } from "./run.js";
import { parseFreenetUrl, type FreenetGitUrl } from "./urls.js";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.FREENET_GIT_PASSPHRASE) {
    env.FREENET_GIT_PASSPHRASE = process.env.FREENET_GIT_PASSPHRASE;
  }
  return env;
}

export async function repoDirFor(url: FreenetGitUrl): Promise<string> {
  const root = await ensureCacheRoot();
  return path.join(root, url.cacheKey);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function inspectRemote(rawUrl: string): Promise<{
  url: FreenetGitUrl;
  refs: Array<{ hash: string; name: string }>;
  headTarget: string | null;
  defaultBranch: string | null;
  cachedLocally: boolean;
  localPath: string | null;
  detail: string;
}> {
  const url = parseFreenetUrl(rawUrl);
  const dir = await repoDirFor(url);
  const gitDir = path.join(dir, ".git");
  const cachedLocally = await pathExists(gitDir);

  // Metadata-only: freenet-git remote helper lists refs from the repo
  // contract GET. No pack download.
  const result = await runCommand(
    "git",
    ["ls-remote", "--symref", url.remote],
    { env: gitEnv(), timeoutMs: 25_000 },
  );

  if (result.code !== 0) {
    const classified = classifyFreenetError(result.stderr, result.stdout);
    const base = result.stderr || result.stdout || "git ls-remote failed";
    throw Object.assign(
      new Error(classified.hint ? `${base}\n\n${classified.hint}` : base),
      {
        peerExhausted: classified.peerExhausted,
        wasmExecBlocked: classified.wasmExecBlocked,
        url,
      },
    );
  }

  const refs: Array<{ hash: string; name: string }> = [];
  let defaultBranch: string | null = null;
  let headTarget: string | null = null;

  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    // symref line: "ref: refs/heads/main\tHEAD"
    if (line.startsWith("ref: ")) {
      const [left, right] = line.split("\t");
      if (right === "HEAD") {
        defaultBranch = left.replace(/^ref:\s+/, "").trim();
      }
      continue;
    }
    const [hash, name] = line.split("\t");
    if (!hash || !name) continue;
    if (name === "HEAD") {
      headTarget = hash;
      continue;
    }
    refs.push({ hash, name });
  }

  return {
    url,
    refs,
    headTarget,
    defaultBranch,
    cachedLocally,
    localPath: cachedLocally ? dir : null,
    detail: `Listed ${refs.length} refs (no pack download)`,
  };
}

export async function ensureContent(
  rawUrl: string,
): Promise<{
  url: FreenetGitUrl;
  path: string;
  action: "cloned" | "fetched" | "exists";
  peerExhausted: boolean;
  detail: string;
}> {
  const url = parseFreenetUrl(rawUrl);
  const dir = await repoDirFor(url);
  const gitDir = path.join(dir, ".git");

  if (await pathExists(gitDir)) {
    const fetch = await runCommand(
      "git",
      ["-C", dir, "fetch", "--prune", "origin"],
      { env: gitEnv(), timeoutMs: 300_000 },
    );
    const peerExhausted = isPeerExhausted(fetch.stderr, fetch.stdout);
    if (fetch.code !== 0 && !peerExhausted) {
      const classified = classifyFreenetError(fetch.stderr, fetch.stdout);
      const base = fetch.stderr || fetch.stdout || "git fetch failed";
      throw Object.assign(
        new Error(classified.hint ? `${base}\n\n${classified.hint}` : base),
        {
          peerExhausted: classified.peerExhausted,
          wasmExecBlocked: classified.wasmExecBlocked,
          url,
        },
      );
    }
    return {
      url,
      path: dir,
      action: fetch.code === 0 ? "fetched" : "exists",
      peerExhausted,
      detail: peerExhausted
        ? fetch.stderr || "Peers exhausted — try Rescue"
        : "Content ready from Freenet",
    };
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });
  // Full clone: freenet-git's fetch walks commit parents across packs.
  // `--depth` breaks that walk (missing parents) — do not shallow-clone.
  const clone = await runCommand(
    "git",
    ["clone", url.remote, dir],
    { env: gitEnv(), timeoutMs: 600_000 },
  );
  const peerExhausted = isPeerExhausted(clone.stderr, clone.stdout);
  if (clone.code !== 0) {
    const classified = classifyFreenetError(clone.stderr, clone.stdout);
    const base = clone.stderr || clone.stdout || "git clone failed";
    // Clean partial clone dir so the next attempt starts fresh.
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw Object.assign(
      new Error(classified.hint ? `${base}\n\n${classified.hint}` : base),
      {
        peerExhausted: classified.peerExhausted || peerExhausted,
        wasmExecBlocked: classified.wasmExecBlocked,
        url,
        path: dir,
      },
    );
  }
  return {
    url,
    path: dir,
    action: "cloned",
    peerExhausted: false,
    detail: "Loaded content from Freenet",
  };
}

export async function openOrClone(rawUrl: string): Promise<{
  url: FreenetGitUrl;
  path: string;
  action: "cloned" | "fetched" | "exists";
  peerExhausted: boolean;
  detail: string;
}> {
  return ensureContent(rawUrl);
}

export async function listCommits(
  dir: string,
  limit = 40,
  ref = "HEAD",
): Promise<
  Array<{ hash: string; short: string; subject: string; author: string; date: string }>
> {
  const format = "%H%x09%h%x09%s%x09%an%x09%cI";
  const result = await runCommand(
    "git",
    ["-C", dir, "log", ref, `-n${limit}`, `--format=${format}`],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git log failed");
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, date] = line.split("\t");
      return { hash, short, subject, author, date };
    });
}

export async function listTree(
  dir: string,
  treePath = "",
  ref = "HEAD",
): Promise<Array<{ mode: string; type: string; hash: string; name: string }>> {
  const spec = treePath ? `${ref}:${treePath}` : ref;
  const result = await runCommand(
    "git",
    ["-C", dir, "ls-tree", spec],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git ls-tree failed");
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split("\t");
      const [mode, type, hash] = meta.split(/\s+/);
      return { mode, type, hash, name };
    });
}

export async function showFile(
  dir: string,
  filePath: string,
  ref = "HEAD",
): Promise<{ path: string; content: string; binary: boolean }> {
  const result = await runCommand(
    "git",
    ["-C", dir, "show", `${ref}:${filePath}`],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git show failed");
  }
  const buf = Buffer.from(result.stdout, "utf8");
  const binary = buf.includes(0);
  return {
    path: filePath,
    content: binary ? "" : result.stdout,
    binary,
  };
}

export async function listBranches(dir: string): Promise<string[]> {
  const result = await runCommand(
    "git",
    ["-C", dir, "branch", "-a", "--format=%(refname:short)"],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "git branch failed");
  }
  return result.stdout.split("\n").filter(Boolean);
}

export async function repoSummary(dir: string): Promise<{
  head: string;
  branch: string;
  remotes: string[];
}> {
  const [head, branch, remotes] = await Promise.all([
    runCommand("git", ["-C", dir, "rev-parse", "--short", "HEAD"]),
    runCommand("git", ["-C", dir, "branch", "--show-current"]),
    runCommand("git", ["-C", dir, "remote", "-v"]),
  ]);
  return {
    head: head.stdout.trim(),
    branch: branch.stdout.trim() || "DETACHED",
    remotes: remotes.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim()),
  };
}

export async function listCachedRepos(): Promise<
  Array<{ cacheKey: string; path: string; remote?: string }>
> {
  const root = await ensureCacheRoot();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const out: Array<{ cacheKey: string; path: string; remote?: string }> = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    const gitDir = path.join(dir, ".git");
    if (!(await pathExists(gitDir))) continue;
    const remote = await runCommand(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      { timeoutMs: 5_000 },
    );
    out.push({
      cacheKey: name,
      path: dir,
      remote: remote.code === 0 ? remote.stdout.trim() : undefined,
    });
  }
  return out;
}
