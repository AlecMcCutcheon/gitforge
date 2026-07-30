/**
 * B1: Tip branch + optional rootPath → site file map.
 * Requires index.html at the publish root. No Freenet publish.
 */

import { loadBrowserTip } from "./tip-fetch";
import { listAllBlobPaths, readBlobPath } from "../tip-browse/pack-decode";

export interface SiteExtractResult {
  /** Paths relative to publish root (posix, no leading slash). */
  files: Map<string, Uint8Array>;
  /** Tip commit SHA-1 (40 hex). */
  commit: string;
  branch: string;
  rootPath: string;
}

function normalizeRootPath(rootPath: string): string {
  return rootPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeBranch(branch: string): string {
  const b = branch.trim() || "main";
  return b.startsWith("refs/") ? b : b;
}

/**
 * Materialize the Pages publish tree from a tip pack.
 * @throws if index.html is missing under the publish root
 */
export async function extractSiteFromTip(
  prefix: string,
  branch: string,
  rootPath = "",
): Promise<SiteExtractResult> {
  const branchNorm = normalizeBranch(branch);
  const root = normalizeRootPath(rootPath);
  const tip = await loadBrowserTip(prefix, branchNorm);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const allPaths = await listAllBlobPaths(tip.objects, tip.commit);
  // NEW CODE - TESTING: await soft-fill — tip packs are incremental; site blobs
  // often live only in older tipped packs (same as Code tree browse).
  if (tip.softFill) {
    await tip.softFill;
  }
  const allPaths = await listAllBlobPaths(tip.objects, tip.commit);

  const files = new Map<string, Uint8Array>();
  const prefixWithSlash = root ? `${root}/` : "";

  for (const path of allPaths) {
    let rel: string | null = null;
    if (!root) {
      rel = path;
    } else if (path === root) {
      // blob named exactly as root — unusual; skip
      continue;
    } else if (path.startsWith(prefixWithSlash)) {
      rel = path.slice(prefixWithSlash.length);
    }
    if (rel == null || rel === "" || rel.includes("..")) continue;
    const data = await readBlobPath(tip.objects, tip.commit, path);
    files.set(rel, data);
  }

  if (!files.has("index.html")) {
    const where = root ? `${root}/index.html` : "index.html";
    throw new Error(
      `Pages require ${where} at the tip of ${branchNorm} (found ${files.size} file(s) under publish root)`,
    );
  }

  return {
    files,
    commit: tip.commit.toLowerCase(),
    branch: branchNorm.replace(/^refs\/heads\//, ""),
    rootPath: root,
  };
}

/** Build a minimal tombstone site (Disable with tombstone: true). */
export function tombstoneSiteFiles(): Map<string, Uint8Array> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Pages disabled</title>
</head>
<body>
  <p>This GitForge Pages site has been disabled.</p>
</body>
</html>
`;
  return new Map([["index.html", new TextEncoder().encode(html)]]);
}
