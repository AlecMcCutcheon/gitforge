import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureCacheRoot } from "./env.js";
import { whoami } from "./freenet-git-ops.js";
import { parseWhoami } from "./hub-registry.js";
import { runCommand } from "./run.js";
import { ensureTipPack } from "./tip-browse.js";

export type HubPagesStatus = "off" | "ready" | "publishing" | "error";

export interface HubPagesConfig {
  schema_version: number;
  repo_prefix: string;
  label: string;
  enabled: boolean;
  autoSync: boolean;
  branch: string;
  rootPath: string;
  websiteKeyName: string;
  contractKey: string | null;
  siteUrl: string | null;
  lastPublishedCommit: string | null;
  lastPublishedAt: string | null;
  status: HubPagesStatus;
  lastError: string | null;
  version: number;
}

interface PagesFile {
  schema_version: number;
  repos: Record<string, HubPagesConfig>;
}

const syncLocks = new Map<string, Promise<HubPagesConfig>>();

function pagesBaseUrl(): string {
  return (
    process.env.FREENET_HUB_PAGES_BASE?.replace(/\/$/, "") ??
    "http://127.0.0.1:7509/v1/contract/web"
  );
}

function siteUrlForKey(contractKey: string): string {
  return `${pagesBaseUrl()}/${contractKey}/`;
}

function websiteKeyNameFor(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 24) || "repo";
  return `hub-pages-${safe}`;
}

async function pagesPath(): Promise<string> {
  const reposRoot = await ensureCacheRoot();
  const root = path.dirname(reposRoot);
  await fs.mkdir(root, { recursive: true });
  return path.join(root, "hub-pages.json");
}

async function loadPages(): Promise<PagesFile> {
  const file = await pagesPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as PagesFile;
    if (!data.repos || typeof data.repos !== "object") {
      return { schema_version: 1, repos: {} };
    }
    return { schema_version: 1, repos: data.repos };
  } catch {
    return { schema_version: 1, repos: {} };
  }
}

async function savePages(data: PagesFile): Promise<void> {
  const file = await pagesPath();
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function getPages(prefix: string): Promise<HubPagesConfig | null> {
  const data = await loadPages();
  return data.repos[prefix] ?? null;
}

async function assertOwnsPrefix(prefix: string): Promise<{
  name: string;
  fingerprint: string;
  repos: Array<{ prefix: string; label: string }>;
}> {
  const id = await whoami();
  if (!id.ok) {
    throw new Error(id.stderr || "freenet-git whoami failed — create an identity first");
  }
  const parsed = parseWhoami(id.stdout);
  if (!parsed) throw new Error("Could not parse freenet-git whoami output");
  const owned = parsed.repos.find((r) => r.prefix === prefix);
  if (!owned) {
    throw new Error(
      `Repo prefix ${prefix} is not in your identity bundle. Only the owner can manage Pages.`,
    );
  }
  return parsed;
}

async function resolveCommitOid(gitDir: string, tipOid: string): Promise<string> {
  const type = await runCommand(
    "git",
    ["--git-dir", gitDir, "cat-file", "-t", tipOid],
    { timeoutMs: 15_000 },
  );
  if (type.code === 0 && type.stdout.trim() === "tag") {
    const peeled = await runCommand(
      "git",
      ["--git-dir", gitDir, "rev-parse", `${tipOid}^{commit}`],
      { timeoutMs: 15_000 },
    );
    if (peeled.code === 0 && peeled.stdout.trim()) {
      return peeled.stdout.trim();
    }
  }
  return tipOid;
}

/** Extract tip tree (optional subdirectory) to a temp dir for fdev publish. */
export async function extractTipSiteDir(
  prefix: string,
  branch: string,
  rootPath: string,
): Promise<{ dir: string; commit: string; cleanup: () => Promise<void> }> {
  const tip = await ensureTipPack(prefix, branch);
  const commit = await resolveCommitOid(tip.git_dir, tip.commit);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freenet-hub-pages-"));
  const archive = await runCommand(
    "git",
    ["--git-dir", tip.git_dir, "archive", "--format=tar", commit],
    { timeoutMs: 120_000, binary: true },
  );
  if (archive.code !== 0 || !archive.stdoutBuffer?.length) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(archive.stderr || "git archive failed for Pages extract");
  }
  const tarPath = path.join(tmp, "tree.tar");
  await fs.writeFile(tarPath, archive.stdoutBuffer);
  const extractRoot = path.join(tmp, "tree");
  await fs.mkdir(extractRoot, { recursive: true });
  const untar = await runCommand("tar", ["-xf", tarPath, "-C", extractRoot], {
    timeoutMs: 60_000,
  });
  if (untar.code !== 0) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(untar.stderr || "tar extract failed for Pages");
  }
  await fs.rm(tarPath, { force: true });

  const rel = rootPath.replace(/^\/+|\/+$/g, "");
  const siteDir = rel ? path.join(extractRoot, ...rel.split("/")) : extractRoot;
  try {
    await fs.access(path.join(siteDir, "index.html"));
  } catch {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(
      rel
        ? `No index.html under tip path "${rel}" on branch ${branch}`
        : `No index.html at tip root on branch ${branch}`,
    );
  }

  return {
    dir: siteDir,
    commit,
    cleanup: async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

function parseContractKeyFromFdev(stdout: string, stderr: string): string | null {
  const text = `${stdout}\n${stderr}`;
  const url =
    /Website URL:\s*(\S*\/v1\/contract\/web\/([1-9A-HJ-NP-Za-km-z]+)\/?)/i.exec(
      text,
    );
  if (url) return url[2];
  const keyLine = /(?:Your website contract key|contract key):\s*([1-9A-HJ-NP-Za-km-z]+)/i.exec(
    text,
  );
  if (keyLine) return keyLine[1];
  return null;
}

async function fdevWebsiteListKey(keyName: string): Promise<string | null> {
  const listed = await runCommand("fdev", ["website", "list"], {
    timeoutMs: 30_000,
  });
  if (listed.code !== 0) return null;
  for (const line of listed.stdout.split("\n")) {
    const m = new RegExp(
      `^${keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([1-9A-HJ-NP-Za-km-z]+)`,
    ).exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

async function ensureWebsiteKey(keyName: string): Promise<{
  contractKey: string;
  created: boolean;
}> {
  const existing = await fdevWebsiteListKey(keyName);
  if (existing) {
    return { contractKey: existing, created: false };
  }
  const init = await runCommand("fdev", ["website", "init", keyName], {
    timeoutMs: 60_000,
  });
  if (init.code !== 0) {
    // Race / already exists
    const again = await fdevWebsiteListKey(keyName);
    if (again) return { contractKey: again, created: false };
    throw new Error(init.stderr || init.stdout || "fdev website init failed");
  }
  const fromOut = parseContractKeyFromFdev(init.stdout, init.stderr);
  const listed = fromOut ?? (await fdevWebsiteListKey(keyName));
  if (!listed) {
    throw new Error("fdev website init succeeded but contract key not found");
  }
  return { contractKey: listed, created: true };
}

async function fdevPublishOrUpdate(
  dir: string,
  keyName: string,
  mode: "publish" | "update",
): Promise<void> {
  const result = await runCommand(
    "fdev",
    ["website", mode, dir, "--key", keyName],
    { timeoutMs: 600_000 },
  );
  if (result.code !== 0) {
    // First publish may need publish; updates need update. Retry other verb once.
    if (mode === "update") {
      const pub = await runCommand(
        "fdev",
        ["website", "publish", dir, "--key", keyName],
        { timeoutMs: 600_000 },
      );
      if (pub.code === 0) return;
      throw new Error(
        pub.stderr ||
          result.stderr ||
          "fdev website update/publish failed",
      );
    }
    const upd = await runCommand(
      "fdev",
      ["website", "update", dir, "--key", keyName],
      { timeoutMs: 600_000 },
    );
    if (upd.code === 0) return;
    throw new Error(
      result.stderr || upd.stderr || "fdev website publish failed",
    );
  }
}

async function writeTombstone(dir: string, label: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${label} — Pages disabled</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #e6edf3; background: #0d1117; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
  <h1>Pages disabled</h1>
  <p>GitAtlas Pages for <strong>${label}</strong> is turned off. The last live site may remain on the network until replaced.</p>
</body>
</html>
`,
    "utf8",
  );
}

export async function enablePages(input: {
  prefix: string;
  label: string;
  branch?: string;
  rootPath?: string;
  autoSync?: boolean;
}): Promise<HubPagesConfig> {
  await assertOwnsPrefix(input.prefix);
  const data = await loadPages();
  const existing = data.repos[input.prefix];
  const branch = (input.branch ?? existing?.branch ?? "main").trim() || "main";
  const rootPath = (input.rootPath ?? existing?.rootPath ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const autoSync = input.autoSync ?? existing?.autoSync ?? true;
  const keyName = existing?.websiteKeyName ?? websiteKeyNameFor(input.prefix);

  let row: HubPagesConfig = {
    schema_version: 1,
    repo_prefix: input.prefix,
    label: input.label || existing?.label || "repo",
    enabled: true,
    autoSync,
    branch,
    rootPath,
    websiteKeyName: keyName,
    contractKey: existing?.contractKey ?? null,
    siteUrl: existing?.siteUrl ?? null,
    lastPublishedCommit: existing?.lastPublishedCommit ?? null,
    lastPublishedAt: existing?.lastPublishedAt ?? null,
    status: "publishing",
    lastError: null,
    version: existing?.version ?? 0,
  };
  data.repos[input.prefix] = row;
  await savePages(data);

  try {
    const { contractKey } = await ensureWebsiteKey(keyName);
    row = {
      ...row,
      contractKey,
      siteUrl: siteUrlForKey(contractKey),
    };
    data.repos[input.prefix] = row;
    await savePages(data);

    const extracted = await extractTipSiteDir(input.prefix, branch, rootPath);
    try {
      const first = !existing?.lastPublishedCommit;
      await fdevPublishOrUpdate(
        extracted.dir,
        keyName,
        first ? "publish" : "update",
      );
      row = {
        ...row,
        enabled: true,
        status: "ready",
        lastError: null,
        lastPublishedCommit: extracted.commit,
        lastPublishedAt: new Date().toISOString(),
        version: row.version + 1,
      };
    } finally {
      await extracted.cleanup();
    }
  } catch (err) {
    row = {
      ...row,
      enabled: true,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
    };
    data.repos[input.prefix] = row;
    await savePages(data);
    throw err;
  }

  data.repos[input.prefix] = row;
  await savePages(data);
  return row;
}

export async function syncPages(prefix: string): Promise<HubPagesConfig> {
  const existingLock = syncLocks.get(prefix);
  if (existingLock) return existingLock;

  const job = (async () => {
    await assertOwnsPrefix(prefix);
    const data = await loadPages();
    const row = data.repos[prefix];
    if (!row || !row.enabled) {
      throw new Error("Pages is not enabled for this repo");
    }

    data.repos[prefix] = {
      ...row,
      status: "publishing",
      lastError: null,
    };
    await savePages(data);

    try {
      const tip = await ensureTipPack(prefix, row.branch);
      const commit = await resolveCommitOid(tip.git_dir, tip.commit);
      if (
        row.lastPublishedCommit &&
        row.lastPublishedCommit === commit &&
        row.status === "ready"
      ) {
        const unchanged = { ...row, status: "ready" as const, lastError: null };
        data.repos[prefix] = unchanged;
        await savePages(data);
        return unchanged;
      }

      if (!row.contractKey) {
        const { contractKey } = await ensureWebsiteKey(row.websiteKeyName);
        row.contractKey = contractKey;
        row.siteUrl = siteUrlForKey(contractKey);
      }

      const extracted = await extractTipSiteDir(
        prefix,
        row.branch,
        row.rootPath,
      );
      try {
        await fdevPublishOrUpdate(
          extracted.dir,
          row.websiteKeyName,
          row.lastPublishedCommit ? "update" : "publish",
        );
        const next: HubPagesConfig = {
          ...row,
          status: "ready",
          lastError: null,
          lastPublishedCommit: extracted.commit,
          lastPublishedAt: new Date().toISOString(),
          version: row.version + 1,
          siteUrl: row.contractKey
            ? siteUrlForKey(row.contractKey)
            : row.siteUrl,
        };
        data.repos[prefix] = next;
        await savePages(data);
        return next;
      } finally {
        await extracted.cleanup();
      }
    } catch (err) {
      const failed: HubPagesConfig = {
        ...row,
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      };
      data.repos[prefix] = failed;
      await savePages(data);
      throw err;
    }
  })().finally(() => {
    syncLocks.delete(prefix);
  });

  syncLocks.set(prefix, job);
  return job;
}

export async function disablePages(
  prefix: string,
  options: { tombstone?: boolean } = {},
): Promise<HubPagesConfig> {
  await assertOwnsPrefix(prefix);
  const data = await loadPages();
  const row = data.repos[prefix];
  if (!row) {
    throw new Error("Pages was never configured for this repo");
  }

  let next: HubPagesConfig = {
    ...row,
    enabled: false,
    status: "off",
    lastError: null,
  };

  if (options.tombstone && row.websiteKeyName) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "freenet-hub-pages-off-"));
    try {
      await writeTombstone(tmp, row.label);
      if (!row.contractKey) {
        const { contractKey } = await ensureWebsiteKey(row.websiteKeyName);
        next.contractKey = contractKey;
        next.siteUrl = siteUrlForKey(contractKey);
      }
      await fdevPublishOrUpdate(
        tmp,
        row.websiteKeyName,
        row.lastPublishedCommit ? "update" : "publish",
      );
      next = {
        ...next,
        lastPublishedAt: new Date().toISOString(),
        version: next.version + 1,
      };
    } catch (err) {
      next = {
        ...next,
        status: "off",
        lastError: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  data.repos[prefix] = next;
  await savePages(data);
  return next;
}

/** Background auto-sync when enabled; no-op / swallow if not owner or unchanged. */
export async function maybeAutoSyncPages(
  prefix: string,
): Promise<HubPagesConfig | null> {
  const row = await getPages(prefix);
  if (!row?.enabled || !row.autoSync) return row;
  try {
    return await syncPages(prefix);
  } catch {
    return getPages(prefix);
  }
}
