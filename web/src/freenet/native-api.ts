import {
  browserListPaths,
  browserListTree,
  browserShowBlob,
  summarizeRepoState,
} from "../tip-browse";
import { listAllBlobsWithSizes } from "../tip-browse/pack-decode";
import {
  analyzeFilesAsync,
  analyzeFilesPathOnly,
  parseGitattributes,
  pathDetectionNeedsContent,
  type LanguageBreakdown,
} from "@gitforge/linguist";
import type {
  BlobResponse,
  BranchesResponse,
  BranchRow,
  CommitEntry,
  ContributorsResponse,
  RepoPageData,
  TreeResponse,
} from "../api";
import { fetchRepoState, loadBrowserTip, clearRepoStateCache, type TipHandle } from "./tip-fetch";
import { clearBrowserTipCaches } from "../tip-browse/browser-api";
import { bumpTipCacheEpoch } from "./tip-cache-lifecycle";
import { abortContractGets } from "./ws";
import {
  parseCommitFirstParent,
  parseCommitMeta,
} from "../tip-browse/pack-decode";
import { softDeleteFromSummary } from "../lib/repo-soft-delete";

export interface NativeTagMeta {
  name: string;
  commit: string;
  annotated: boolean;
  title: string | null;
  description: string | null;
}

function parseAnnotatedTagObject(
  data: Uint8Array,
  tagName: string,
): NativeTagMeta {
  const text = new TextDecoder().decode(data);
  const objectLine = /^object ([0-9a-f]{40})$/m.exec(text);
  const peeled = objectLine?.[1] ?? "";
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

const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const tipCache = new Map<string, Promise<TipHandle>>();

function tipKey(prefix: string, gitRef: string): string {
  return `${prefix}\0${gitRef}`;
}

export async function nativeEnsureTip(
  prefix: string,
  gitRef: string,
): Promise<TipHandle> {
  const key = tipKey(prefix, gitRef || "HEAD");
  let pending = tipCache.get(key);
  if (!pending) {
    pending = loadBrowserTip(prefix, gitRef || "HEAD").catch((err) => {
      tipCache.delete(key);
      throw err;
    });
    tipCache.set(key, pending);
  }
  return pending;
}

/** Drop tip handles for one prefix (or all). */
export function clearNativeTipCache(prefix?: string): void {
  if (!prefix) {
    tipCache.clear();
    return;
  }
  const needle = `${prefix}\0`;
  for (const key of [...tipCache.keys()]) {
    if (key.startsWith(needle)) tipCache.delete(key);
  }
}

/**
 * Clear tip-pack / RepoState / decoded-object caches for a repo (or all).
 * Used when navigating away so memory stays bounded and reloads are cold.
 * Also aborts in-flight / queued Freenet GETs for that repo so a stalling
 * tip load cannot clog the shared WS pump for the next page.
 */
export function clearRepoTipCaches(prefix?: string): void {
  bumpTipCacheEpoch(prefix);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // clearNativeTipCache(prefix);
  // clearRepoStateCache(prefix);
  // clearBrowserTipCaches(prefix);
  // NEW CODE - TESTING: cancel WS GETs first so the pump can serve the next route
  abortContractGets(prefix);
  clearNativeTipCache(prefix);
  clearRepoStateCache(prefix);
  clearBrowserTipCaches(prefix);
}

function branchName(ref: string | null | undefined): string {
  if (!ref) return "HEAD";
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

interface SummaryShape {
  refs?: Array<{ name: string; target: string }>;
  default_branch?: string | null;
  mirror_mode?: string | null;
  deleted?: string | null;
  name?: string | null;
  description?: string | null;
  tipped_bundles?: unknown[];
  legacy_untipped_count?: number;
}

export async function nativeRepo(
  prefix: string,
  label: string,
): Promise<RepoPageData> {
  const state = await fetchRepoState(prefix);
  const summary = (await summarizeRepoState(state)) as SummaryShape;
  const refs = (summary.refs ?? []).map((r) => ({
    name: r.name,
    hash: r.target,
  }));
  const defaultBranch = summary.default_branch
    ? branchName(summary.default_branch)
    : refs.find((r) => r.name === "refs/heads/main" || r.name === "refs/heads/master")
      ? branchName(
          refs.find((r) => r.name.startsWith("refs/heads/"))?.name ?? "main",
        )
      : "main";
  const headRef =
    refs.find((r) => r.name === `refs/heads/${defaultBranch}`) ??
    refs.find((r) => r.name.startsWith("refs/heads/")) ??
    null;
  // Prefer signed RepoState.name for remotes / display; URL label is cosmetic.
  const displayName = summary.name?.trim() || label;
  const remote = `freenet::${prefix}/${displayName}`;
  const softDelete = softDeleteFromSummary(summary);
  const empty =
    refs.length === 0 &&
    !(summary.tipped_bundles && summary.tipped_bundles.length > 0);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // void nativeEnsureTip(prefix, defaultBranch).catch(() => undefined);
  // Prefetch raced TreeView's tip load; tip deadline abortContractGets(prefix)
  // killed the Code tab GETs → Discover→repo stuck until hard reload.
  // NEW CODE - TESTING: tip packs load only from tree/blob/commits views
  return {
    url: {
      prefix,
      label,
      remote,
      display: `freenet:${prefix}/${displayName}`,
      cacheKey: `${prefix}__${label}`,
    },
    // NEW CODE - TESTING: signed contract display name
    name: summary.name?.trim() || null,
    description: summary.description?.trim() || null,
    refs,
    headTarget: headRef?.hash ?? null,
    defaultBranch,
    remote,
    summary: {
      head: headRef?.hash?.slice(0, 7) ?? "—",
      branch: defaultBranch,
      remotes: [remote],
    },
    content: {
      detail: softDelete.deleted
        ? summary.description?.trim() ||
          "This repository was marked deleted by the owner."
        : empty
          ? "Empty repository — push with freenet-git to add the first commit."
          : "Browser Freenet tip-browse (no Hub bridge)",
      action: "ok",
    },
    empty,
    softDelete,
  };
}

export async function nativeTree(
  prefix: string,
  _label: string,
  ref: string,
  path: string,
): Promise<TreeResponse> {
  const tip = await nativeEnsureTip(prefix, ref);
  const listed = await browserListTree(tip, path);
  return {
    path,
    entries: listed.entries.map((e) => ({
      mode: e.mode,
      type: e.type,
      hash: e.hash,
      name: e.name,
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // lastCommitSubject: null,
      // lastCommitDate: null,
      // lastCommitAuthor: null,
      // NEW CODE - TESTING
      lastCommitSubject: e.lastCommitSubject,
      lastCommitDate: e.lastCommitDate,
      lastCommitAuthor: e.lastCommitAuthor,
    })),
    ref,
    commit: listed.commit,
    tipPackSize: listed.tipPackSize,
    progress: listed.progress,
  };
}

/** freenet-linguist breakdown of tip blobs (full detect + classifier). */
export async function nativeLanguageStats(
  prefix: string,
  ref: string,
  opts?: {
    onPartial?: (breakdown: LanguageBreakdown) => void;
    signal?: AbortSignal;
  },
): Promise<LanguageBreakdown> {
  const tip = await nativeEnsureTip(prefix, ref || "HEAD");
  if (opts?.signal?.aborted) {
    return { totalBytes: 0, languages: [], skipped: 0 };
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Started detect while soft-fill still merging older tip packs → size 0 skips
  // and main-thread thrash attaching every blob body.
  // if (tip.softFill) await tip.softFill;
  // …then single full pass with content…
  // Path-only paint ASAP; refine after soft-fill settles — but path pass ran
  // BEFORE soft-fill, so listAllBlobsWithSizes threw `missing tree` on multi-pack
  // tips (trees only in parent packs). Widget catch → null; settings→back worked
  // because soft-fill had finished by then.
  // NEW CODE - TESTING: await soft-fill first (same as browserListTree / blob)
  if (tip.softFill) await tip.softFill;
  if (opts?.signal?.aborted) {
    return { totalBytes: 0, languages: [], skipped: 0 };
  }

  const CONTENT_CAP = 64 * 1024;

  const loadGitattributes = (
    blobs: ReturnType<typeof listAllBlobsWithSizes>,
    objects: TipHandle["objects"],
  ) => {
    try {
      const attrBlob = blobs.find(
        (b) =>
          b.path === ".gitattributes" || b.path.endsWith("/.gitattributes"),
      );
      if (attrBlob) {
        const obj = objects.get(attrBlob.hash);
        if (obj?.type === "blob") {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(
            obj.data,
          );
          return parseGitattributes(text);
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  const runPass = async (attachContent: boolean): Promise<{
    result: LanguageBreakdown;
    blobCount: number;
    withContent: number;
  }> => {
    const blobs = listAllBlobsWithSizes(tip.objects, tip.commit);
    const gitattributes = loadGitattributes(blobs, tip.objects);

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Path pass used analyzeFilesAsync with content:null → after path-only
    // partial (Rust via popularity), full detect fell through to
    // extension_index[0]=RenderScript and flipped the sidebar.
    // NEW CODE - TESTING: path pass is path-only; content refine uses async.
    if (!attachContent) {
      const files = blobs.map((b) => ({
        path: b.path,
        size: b.size,
        content: null as Uint8Array | null,
      }));
      const result = analyzeFilesPathOnly(files, { gitattributes });
      return { result, blobCount: blobs.length, withContent: 0 };
    }

    let withContent = 0;
    const files = blobs.map((b) => {
      if (!pathDetectionNeedsContent(b.path)) {
        return {
          path: b.path,
          size: b.size,
          content: null as Uint8Array | null,
        };
      }
      const obj = tip.objects.get(b.hash);
      if (obj?.type !== "blob") {
        return {
          path: b.path,
          size: b.size,
          content: null as Uint8Array | null,
        };
      }
      withContent += 1;
      const data = obj.data;
      return {
        path: b.path,
        size: b.size,
        content:
          data.byteLength > CONTENT_CAP
            ? data.subarray(0, CONTENT_CAP)
            : data,
      };
    });
    const result = await analyzeFilesAsync(files, {
      gitattributes,
      onPartial: opts?.onPartial,
      signal: opts?.signal,
    });
    return { result, blobCount: blobs.length, withContent };
  };

  const t0 = performance.now();
  const pathPass = await runPass(false);
  if (!opts?.signal?.aborted && pathPass.result.languages.length > 0) {
    opts?.onPartial?.(pathPass.result);
  }
  console.info(
    `[freenet-forge] language stats path-pass ${pathPass.blobCount} blobs ${(performance.now() - t0).toFixed(0)}ms`,
  );

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (tip.softFill) await tip.softFill;
  // if (opts?.signal?.aborted) {
  //   return pathPass.result;
  // }
  // NEW CODE - TESTING: soft-fill already awaited above

  if (opts?.signal?.aborted) {
    return pathPass.result;
  }

  const t1 = performance.now();
  const full = await runPass(true);
  console.info(
    `[freenet-forge] language stats content-pass ${full.blobCount} blobs (${full.withContent} with content) ${(performance.now() - t1).toFixed(0)}ms`,
  );
  return full.result;
}

export async function nativeBlob(
  prefix: string,
  _label: string,
  ref: string,
  path: string,
): Promise<BlobResponse> {
  const tip = await nativeEnsureTip(prefix, ref);
  const shown = await browserShowBlob(tip, path);
  return {
    path: shown.path,
    content: shown.text ?? "",
    contentBase64: shown.contentBase64,
    mediaType: shown.mediaType,
    size: shown.size,
    binary: shown.binary,
    tooLarge: shown.tooLarge,
    ref,
    commit: shown.commit,
    tipPackSize: tip.tipPackSize,
  };
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// function parseCommitMeta(data: Uint8Array): {
//   subject: string;
//   author: string;
//   date: string;
//   parents: string[];
// } {
//   const text = new TextDecoder().decode(data);
//   const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map((m) => m[1]);
//   const authorLine = /^author (.+) <[^>]*> (\d+)/m.exec(text);
//   const subject =
//     text.split("\n\n").slice(1).join("\n\n").trim().split("\n")[0] ||
//     "(no subject)";
//   const author = authorLine?.[1] ?? "unknown";
//   const epoch = authorLine ? Number(authorLine[2]) : 0;
//   const date = epoch
//     ? new Date(epoch * 1000).toISOString()
//     : new Date(0).toISOString();
//   return { subject, author, date, parents };
// }

export async function nativeCommits(
  prefix: string,
  _label: string,
  ref: string,
): Promise<{ commits: CommitEntry[]; ref: string; note?: string }> {
  const tip = await nativeEnsureTip(prefix, ref);
  const commits: CommitEntry[] = [];
  let current: string | undefined = tip.commit;
  const seen = new Set<string>();
  while (current && !seen.has(current) && commits.length < 50) {
    seen.add(current);
    const obj = tip.objects.get(current);
    if (!obj || obj.type !== "commit") break;
    const meta = parseCommitMeta(obj.data);
    commits.push({
      hash: current,
      short: current.slice(0, 7),
      subject: meta.subject,
      author: meta.author,
      date: meta.date,
    });
    current = meta.parents[0];
    if (current && !tip.objects.has(current)) {
      break;
    }
  }
  return {
    commits,
    ref,
    note:
      commits.length > 0 && current && !tip.objects.has(current)
        ? "Commit list stops where tipped packs run out (legacy untipped packs are skipped)."
        : undefined,
  };
}

export async function nativePaths(
  prefix: string,
  _label: string,
  ref: string,
): Promise<{ commit: string; paths: string[] }> {
  const tip = await nativeEnsureTip(prefix, ref);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return browserListPaths(tip);
  // NEW CODE - TESTING: wait soft-fill so Files sidepanel sees older tip blobs
  if (tip.softFill) await tip.softFill;
  return browserListPaths(tip);
}

export async function nativeReadme(
  prefix: string,
  label: string,
  ref: string,
): Promise<{ path: string | null; content: string | null; ref: string }> {
  const candidates = [
    "README.md",
    "README.MD",
    "Readme.md",
    "README",
    "readme.md",
  ];
  for (const path of candidates) {
    try {
      const blob = await nativeBlob(prefix, label, ref, path);
      if (!blob.binary && blob.content) {
        return { path, content: blob.content, ref };
      }
    } catch {
      /* try next */
    }
  }
  return { path: null, content: null, ref };
}

/** Annotated/lightweight tag meta from tip packs (no Hub bridge HTTP). */
export async function nativeTagMeta(
  prefix: string,
  _label: string,
  name: string,
): Promise<NativeTagMeta> {
  const tip = await nativeEnsureTip(prefix, name);
  const state = await fetchRepoState(prefix);
  const summary = (await summarizeRepoState(state)) as SummaryShape;
  const ref = (summary.refs ?? []).find((r) => r.name === `refs/tags/${name}`);
  const target = (ref?.target ?? tip.commit).toLowerCase();
  const atTarget = tip.objects.get(target);
  if (atTarget?.type === "tag") {
    return parseAnnotatedTagObject(atTarget.data, name);
  }
  // Tip may already be peeled to commit — find matching tag object in pack.
  for (const obj of tip.objects.values()) {
    if (obj.type !== "tag") continue;
    const text = new TextDecoder().decode(obj.data);
    const tagLine = /^tag (.+)$/m.exec(text);
    if (tagLine && tagLine[1].trim() !== name) continue;
    const objectLine = /^object ([0-9a-f]{40})$/m.exec(text);
    if (
      objectLine &&
      objectLine[1].toLowerCase() === tip.commit.toLowerCase()
    ) {
      return parseAnnotatedTagObject(obj.data, name);
    }
    if (tagLine?.[1].trim() === name) {
      return parseAnnotatedTagObject(obj.data, name);
    }
  }
  return {
    name,
    commit: tip.commit,
    annotated: false,
    title: name,
    description: null,
  };
}

function firstParentSet(
  objects: TipHandle["objects"],
  tip: string,
  max = 500,
): Set<string> {
  const set = new Set<string>();
  let current: string | null = tip;
  while (current && !set.has(current) && set.size < max) {
    set.add(current);
    const obj = objects.get(current);
    if (!obj || obj.type !== "commit") break;
    current = parseCommitFirstParent(obj.data);
  }
  return set;
}

/** Commits on `from` first-parent walk until a commit in `until`, or null if incomplete. */
function aheadCount(
  objects: TipHandle["objects"],
  from: string,
  until: Set<string>,
  max = 500,
): number | null {
  if (until.has(from)) return 0;
  let n = 0;
  let current: string | null = from;
  const seen = new Set<string>();
  while (current && !seen.has(current) && n < max) {
    if (until.has(current)) return n;
    seen.add(current);
    const obj = objects.get(current);
    if (!obj || obj.type !== "commit") return null;
    n += 1;
    current = parseCommitFirstParent(obj.data);
  }
  return current && until.has(current) ? n : null;
}

export async function nativeBranches(
  prefix: string,
  label: string,
): Promise<BranchesResponse> {
  const repo = await nativeRepo(prefix, label);
  const defaultBranch = repo.defaultBranch ?? "main";
  const heads = repo.refs
    .filter((r) => r.name.startsWith("refs/heads/"))
    .map((r) => ({
      name: branchName(r.name),
      hash: r.hash.toLowerCase(),
    }));

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const branches: BranchRow[] = heads.map((r) => ({
  //   name: r.name,
  //   hash: r.hash,
  //   short: r.hash.slice(0, 7),
  //   isDefault: r.name === defaultBranch,
  //   author: null,
  //   date: null,
  //   behind: null,
  //   ahead: null,
  //   stale: false,
  // }));

  // NEW CODE - TESTING — enrich from tipped packs (dates/authors/stale + ahead/behind when history overlaps)
  const tipByBranch = new Map<string, TipHandle>();
  const loadBranchTip = async (name: string): Promise<TipHandle | null> => {
    const cached = tipByBranch.get(name);
    if (cached) return cached;
    try {
      const tip = await nativeEnsureTip(prefix, name);
      tipByBranch.set(name, tip);
      return tip;
    } catch (err) {
      console.warn(`[freenet-forge] branch tip ${name} unavailable`, err);
      return null;
    }
  };

  // Seed with default branch so shared packs are warm for siblings.
  const defaultTip = await loadBranchTip(defaultBranch);
  const defaultSet = defaultTip
    ? firstParentSet(defaultTip.objects, defaultTip.commit)
    : new Set<string>();

  const rows: BranchRow[] = [];
  const concurrency = 3;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= heads.length) return;
      const head = heads[i];
      let author: string | null = null;
      let date: string | null = null;
      let short = head.hash.slice(0, 7);
      let ahead: number | null = null;
      let behind: number | null = null;
      let tipCommit = head.hash;

      const tip = await loadBranchTip(head.name);
      if (tip) {
        tipCommit = tip.commit;
        short = tip.commit.slice(0, 7);
        const obj = tip.objects.get(tip.commit);
        if (obj && obj.type === "commit") {
          const meta = parseCommitMeta(obj.data);
          author = meta.author;
          date = meta.date;
        }
        if (head.name === defaultBranch) {
          ahead = 0;
          behind = 0;
        } else if (defaultTip && defaultSet.size > 0) {
          const branchSet = firstParentSet(tip.objects, tip.commit);
          // Merge object maps for walks that cross packs loaded under either tip handle.
          const objects = new Map(defaultTip.objects);
          for (const [k, v] of tip.objects) {
            if (!objects.has(k)) objects.set(k, v);
          }
          ahead = aheadCount(objects, tip.commit, defaultSet);
          behind = aheadCount(objects, defaultTip.commit, branchSet);
        }
      }

      const age = date ? Date.now() - Date.parse(date) : 0;
      const stale = date ? age > STALE_AFTER_MS : false;
      rows.push({
        name: head.name,
        hash: tipCommit,
        short,
        isDefault: head.name === defaultBranch,
        author,
        date,
        behind,
        ahead,
        stale,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(heads.length, 1)) }, () =>
      worker(),
    ),
  );

  rows.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    const ad = a.date ? Date.parse(a.date) : 0;
    const bd = b.date ? Date.parse(b.date) : 0;
    return bd - ad;
  });

  const missingMeta = rows.some((r) => !r.date);
  const missingDiv = rows.some(
    (r) => !r.isDefault && (r.ahead == null || r.behind == null),
  );
  let note =
    "Updated times from tip packs.";
  if (missingDiv) {
    note +=
      " Ahead/behind needs shared history in tipped packs (null when packs do not overlap).";
  }
  if (missingMeta) {
    note += " Some branches lack tip packs — dates may be empty.";
  }

  return {
    defaultBranch,
    branches: rows,
    note,
  };
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

/** Authors ranked by commit count inside tipped packs (first-parent walk). */
export async function nativeContributors(
  prefix: string,
  label: string,
  ref = "HEAD",
): Promise<ContributorsResponse> {
  let contractName: string | null = null;
  let contractDescription: string | null = null;
  try {
    const state = await fetchRepoState(prefix);
    const summary = (await summarizeRepoState(state)) as SummaryShape;
    contractName = summary.name?.trim() || null;
    contractDescription = summary.description?.trim() || null;
  } catch {
    /* tip path still useful without meta */
  }

  const tip = await nativeEnsureTip(prefix, ref);
  type Row = {
    name: string;
    email: string | null;
    commits: number;
    slug: string;
  };
  const counts = new Map<string, Row>();
  let current: string | null = tip.commit;
  const seen = new Set<string>();
  let walked = 0;
  const MAX = 500;

  while (current && !seen.has(current) && walked < MAX) {
    seen.add(current);
    walked += 1;
    const obj = tip.objects.get(current);
    if (!obj || obj.type !== "commit") break;
    const meta = parseCommitMeta(obj.data);
    const name = meta.author.trim() || "unknown";
    const email = meta.email;
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
    current = parseCommitFirstParent(obj.data);
  }

  const bySlug = new Map<string, Row>();
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

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // repoName: label.replace(/\.git$/i, "") || label,
  // description: null,
  // NEW CODE - TESTING: prefer signed RepoState.name
  return {
    ref,
    commit: tip.commit,
    repoName: contractName || label.replace(/\.git$/i, "") || label,
    description: contractDescription,
    contributors,
    owner: contributors[0] ?? null,
    note: "Contributors from tipped packs only (first-parent history).",
  };
}
