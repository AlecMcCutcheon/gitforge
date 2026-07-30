import { EMBEDDED_DEMOS } from "./demos";
import { isBrowserNativeMode } from "./tip-browse";
import type { LanguageBreakdown } from "@gitforge/linguist";
import {
  nativeBlob,
  nativeBranches,
  nativeCommits,
  nativeContributors,
  nativeLanguageStats,
  nativePaths,
  nativeReadme,
  nativeRepo,
  nativeTagMeta,
  nativeTree,
} from "./freenet/native-api";

export interface HealthResponse {
  service: string;
  cacheRoot: string;
  node: { ok: boolean; wsUrl: string; detail: string };
  tools: {
    freenetGit: boolean;
    gitRemoteFreenet: boolean;
    git: boolean;
    fdev?: boolean;
    freenetHubTip?: boolean;
    paths: Record<string, string | null>;
  };
  mode?: string;
}

export interface DemoRepo {
  name: string;
  description: string;
  url: string;
  mode: "snapshot" | "history";
}

/** Empty in local Vite (proxy). Never used in Freenet website mode (CSP blocks :8787). */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!API_BASE) return path;
  // NEW CODE - TESTING: Freenet sandbox CSP connect-src is only the node origin
  if (isBrowserNativeMode() || !API_BASE) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface TreeEntry {
  mode: string;
  type: string;
  hash: string;
  name: string;
  lastCommitSubject?: string | null;
  lastCommitDate?: string | null;
  lastCommitAuthor?: string | null;
}

export interface TreeResponse {
  path: string;
  entries: TreeEntry[];
  ref: string;
  commit?: string;
  tipPackSize?: number;
  progress?: string;
}

export interface BlobResponse {
  path: string;
  content: string;
  contentBase64: string | null;
  mediaType: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  ref: string;
  commit?: string;
  tipPackSize?: number;
  rawUrl?: string;
}

export interface CommitEntry {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface BranchRow {
  name: string;
  hash: string;
  short: string;
  isDefault: boolean;
  author: string | null;
  date: string | null;
  behind: number | null;
  ahead: number | null;
  stale: boolean;
}

export interface BranchesResponse {
  defaultBranch: string;
  branches: BranchRow[];
  note?: string;
}

export interface Contributor {
  name: string;
  email: string | null;
  commits: number;
  slug: string;
}

export interface ContributorsResponse {
  ref: string;
  commit: string;
  repoName: string | null;
  description: string | null;
  contributors: Contributor[];
  owner: Contributor | null;
  note?: string;
}

export interface ForgeRegistration {
  schema_version: number;
  repo_prefix: string;
  label: string;
  name: string | null;
  description: string | null;
  /** Project / homepage URL (About). */
  website?: string | null;
  /** Custom tags (About / future Discover search). */
  topics?: string[];
  /** Light adaptive Discover flags. */
  public_meta?: Record<string, string>;
  identity_fingerprint: string;
  /** Unused for display — ForgeProfile.username is the live display name. */
  identity_name: string;
  identity_email: string | null;
  /** Base58 repo owner VK — required for dual-sig-v1. */
  repo_owner_vk?: string | null;
  attestation: string;
  identity_sig?: string | null;
  repo_owner_sig?: string | null;
  seq: number;
  updated_at: string;
}

export interface PersonResponse {
  fingerprint: string;
  displayName: string;
  email: string | null;
  repos: ForgeRegistration[];
  note?: string;
}

export interface ForgePagesConfig {
  schema_version?: number;
  repo_prefix: string;
  label: string;
  enabled: boolean;
  autoSync: boolean;
  branch: string;
  rootPath: string;
  websiteKeyName: string | null;
  contractKey: string | null;
  siteUrl: string | null;
  lastPublishedCommit: string | null;
  lastPublishedAt: string | null;
  status: "off" | "ready" | "publishing" | "error";
  lastError: string | null;
  version: number;
  note?: string;
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// function pagesOffStub(prefix: string, label: string): ForgePagesConfig {
//   return {
//     repo_prefix: prefix,
//     label,
//     enabled: false,
//     autoSync: false,
//     branch: "main",
//     rootPath: "",
//     websiteKeyName: null,
//     contractKey: null,
//     siteUrl: null,
//     lastPublishedCommit: null,
//     lastPublishedAt: null,
//     status: "off",
//     lastError: null,
//     version: 0,
//     note: "Pages require the Hub bridge (not available in Freenet website mode)",
//   };
// }

export interface BlameLine {
  line: number;
  content: string;
  commit: string;
  short: string;
  author: string;
  date: string;
  summary: string;
}

export interface BlameResponse {
  path: string;
  ref: string;
  commit: string;
  lines: BlameLine[];
  note?: string;
}

export interface ApiErrorFlags {
  peerExhausted?: boolean;
  wasmExecBlocked?: boolean;
  tipBrowse?: boolean;
  legacyOnly?: boolean;
  chunkedTimeout?: boolean;
}

export interface RepoPageData {
  url: {
    prefix: string;
    label: string;
    remote: string;
    display: string;
    cacheKey: string;
  };
  /** Signed RepoState.name when available (prefer over URL label for display). */
  name?: string | null;
  /** Signed RepoState.description when available. */
  description?: string | null;
  refs: Array<{ hash: string; name: string }>;
  headTarget: string | null;
  defaultBranch: string | null;
  remote: string;
  summary: { head: string; branch: string; remotes: string[] };
  content: { detail: string; action: string };
  /**
   * True when the contract exists but has no refs/packs yet
   * (`freenet-git create` before the first push).
   */
  empty?: boolean;
  /** Soft-delete / abandonment (Freenet cannot hard-erase). */
  softDelete?: {
    deleted: boolean;
    source: "extension" | "tip-file" | "description" | null;
    at: string | null;
  };
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string } & ApiErrorFlags;
  if (!res.ok) {
    throw Object.assign(new Error(data.error ?? res.statusText), {
      peerExhausted: data.peerExhausted,
      wasmExecBlocked: data.wasmExecBlocked,
      tipBrowse: data.tipBrowse,
      legacyOnly: data.legacyOnly,
      chunkedTimeout: data.chunkedTimeout,
      data,
    });
  }
  return data;
}

export function describeBrowseError(err: unknown): {
  message: string;
  kind: "legacy" | "chunked" | "wasm" | "missing" | "timeout" | "generic";
} {
  const message = err instanceof Error ? err.message : String(err);
  const flags = err as ApiErrorFlags;
  const lower = message.toLowerCase();
  if (
    flags.legacyOnly ||
    lower.includes("tip-browse unsupported") ||
    lower.includes("legacy_untipped")
  ) {
    return {
      kind: "legacy",
      message:
        message +
        "\n\nThis mirror has no tip-pack metadata. GitForge will not download every legacy pack for browse. Use freenet-stdlib / freenet-git demos, or republish with freenet-git ≥ 0.1.16.",
    };
  }
  if (
    flags.chunkedTimeout ||
    lower.includes("inactivity timeout") ||
    lower.includes("no fragments")
  ) {
    return {
      kind: "chunked",
      message:
        message +
        "\n\nChunked tip-pack stream timed out. GitForge retried; try again, or open a smaller tipped repo (stdlib / freenet-git).",
    };
  }
  if (
    flags.wasmExecBlocked ||
    lower.includes("local store lookup failed") ||
    lower.includes("init_t")
  ) {
    return { kind: "wasm", message };
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // return { kind: "generic", message }; // raw "Contract not found" with silent skeleton
  // NEW CODE - TESTING: Freenet-aligned miss / deadline copy
  if (
    /contract not found/.test(lower) ||
    /missing contract/.test(lower) ||
    /empty state/.test(lower)
  ) {
    return {
      kind: "missing",
      message:
        "Contract not found on this node or its peers.\n\n" +
        "GitForge asked Freenet for a tip-pack (or related) contract and got a terminal miss — " +
        "not a slow sync. The bytes may have left peer caches. " +
        "Retry after rescue/re-push, or restore from a durable backup.",
    };
  }
  if (
    /tip load deadline/.test(lower) ||
    /timed out/.test(lower) ||
    /request timeout/.test(lower)
  ) {
    return {
      kind: "timeout",
      message:
        "Fetching contract from the network timed out.\n\n" +
        "Your node is still allowed to keep asking peers; try Retry tip fetch, " +
        "or check the Freenet dashboard if this persists.",
    };
  }
  return { kind: "generic", message };
}

async function apiFetch<T>(
  input: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // OLD: const res = await fetch(input, { ...init, signal: controller.signal });
    // NEW: prefix with VITE_API_BASE for Freenet website → local bridge hybrid
    const res = await fetch(apiUrl(input), {
      ...init,
      signal: controller.signal,
    });
    return await parseJson<T>(res);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s while talking to Freenet.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function branchName(ref: string | null | undefined): string {
  if (!ref) return "HEAD";
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

export const api = {
  health: () => {
    if (isBrowserNativeMode()) {
      return Promise.reject(new Error("health API unavailable in website mode"));
    }
    return apiFetch<HealthResponse>("/api/health", undefined, 8_000);
  },
  demos: async () => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // try {
    //   return await apiFetch<{ demos: DemoRepo[] }>("/api/demos", undefined, 8_000);
    // } catch {
    //   return { demos: EMBEDDED_DEMOS as DemoRepo[] };
    // }
    // NEW CODE - TESTING: never hit :8787 under Freenet CSP
    if (isBrowserNativeMode()) {
      return { demos: EMBEDDED_DEMOS as DemoRepo[] };
    }
    try {
      return await apiFetch<{ demos: DemoRepo[] }>("/api/demos", undefined, 8_000);
    } catch {
      return { demos: EMBEDDED_DEMOS as DemoRepo[] };
    }
  },
  identity: async () => {
    if (isBrowserNativeMode()) {
      const { nativeGetIdentity } = await import("./freenet/owner-api");
      const id = await nativeGetIdentity();
      if (!id) {
        return { ok: false, stdout: "", stderr: "No GitForge identity in delegate" };
      }
      const stdout = `${id.name} <${id.email}>\n${id.fingerprint}\n`;
      return { ok: true, stdout, stderr: "" };
    }
    return apiFetch<{ ok: boolean; stdout: string; stderr: string }>(
      "/api/identity",
      undefined,
      10_000,
    );
  },
  initIdentity: async (body: {
    name: string;
    email: string;
    passphrase?: string;
    noPassphrase?: boolean;
  }) => {
    if (isBrowserNativeMode()) {
      const { nativeCreateIdentity } = await import("./freenet/owner-api");
      const id = await nativeCreateIdentity(body.name, body.email);
      return {
        ok: true,
        stdout: `${id.name} <${id.email}>\n${id.fingerprint}\n`,
        stderr: "",
      };
    }
    return apiFetch<{ ok: boolean; stdout: string; stderr: string; error?: string }>(
      "/api/identity/init",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      60_000,
    );
  },
  cache: async () => {
    if (isBrowserNativeMode()) {
      return { repos: [] as Array<{ cacheKey: string; path: string; remote?: string }> };
    }
    return apiFetch<{
      repos: Array<{ cacheKey: string; path: string; remote?: string }>;
    }>("/api/cache", undefined, 10_000);
  },
  createRepo: async (name: string, description?: string) => {
    if (isBrowserNativeMode()) {
      const { nativeCreateRepo } = await import("./freenet/owner-api");
      const result = await nativeCreateRepo(name, description);
      return {
        ok: true,
        stdout: result.url,
        stderr: "",
        url: result.url,
        registration: result.registration ?? null,
        registerError: result.registration
          ? null
          : "create Put ok; ForgeRegistry register skipped or failed",
      };
    }
    return apiFetch<{
      ok: boolean;
      stdout: string;
      stderr: string;
      url?: string;
      error?: string;
      registration?: ForgeRegistration | null;
      registerError?: string | null;
    }>(
      "/api/repos/create",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      },
      120_000,
    );
  },
  rescue: (url: string) =>
    apiFetch<{ ok: boolean; stdout: string; stderr: string }>(
      "/api/repos/rescue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      },
      300_000,
    ),
  repo: (prefix: string, label: string) =>
    isBrowserNativeMode()
      ? nativeRepo(prefix, label)
      : apiFetch<RepoPageData>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}`,
          undefined,
          180_000,
        ),
  tree: (prefix: string, label: string, ref: string, path = "") =>
    isBrowserNativeMode()
      ? nativeTree(prefix, label, ref, path)
      : apiFetch<TreeResponse>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
          undefined,
          300_000,
        ),
  /** Tip language breakdown (freenet-linguist). Website/native only for now. */
  languages: async (
    prefix: string,
    _label: string,
    ref: string,
    opts?: {
      onPartial?: (row: LanguageBreakdown) => void;
      signal?: AbortSignal;
    },
  ) => {
    if (isBrowserNativeMode()) {
      return nativeLanguageStats(prefix, ref, opts);
    }
    throw new Error("Language stats require Freenet website (native tip) mode");
  },
  blob: (prefix: string, label: string, ref: string, path: string) =>
    isBrowserNativeMode()
      ? nativeBlob(prefix, label, ref, path)
      : apiFetch<BlobResponse>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
          undefined,
          300_000,
        ),
  commits: (prefix: string, label: string, ref: string) =>
    isBrowserNativeMode()
      ? nativeCommits(prefix, label, ref)
      : apiFetch<{ commits: CommitEntry[]; ref: string; note?: string }>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/commits?ref=${encodeURIComponent(ref)}`,
          undefined,
          300_000,
        ),
  branches: (prefix: string, label: string) =>
    isBrowserNativeMode()
      ? nativeBranches(prefix, label)
      : apiFetch<BranchesResponse>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/branches`,
          undefined,
          600_000,
        ),
  contributors: (prefix: string, label: string, ref = "HEAD") =>
    isBrowserNativeMode()
      ? nativeContributors(prefix, label, ref)
      : apiFetch<ContributorsResponse>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/contributors?ref=${encodeURIComponent(ref)}`,
          undefined,
          300_000,
        ),
  paths: (prefix: string, label: string, ref = "HEAD") =>
    isBrowserNativeMode()
      ? nativePaths(prefix, label, ref)
      : apiFetch<{ commit: string; paths: string[] }>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/paths?ref=${encodeURIComponent(ref)}`,
          undefined,
          300_000,
        ),
  archiveZipUrl: (prefix: string, label: string, ref = "HEAD") =>
    apiUrl(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/archive.zip?ref=${encodeURIComponent(ref)}`,
    ),
  tagMeta: (prefix: string, label: string, name: string) =>
    isBrowserNativeMode()
      ? nativeTagMeta(prefix, label, name)
      : apiFetch<{
          name: string;
          commit: string;
          annotated: boolean;
          title: string | null;
          description: string | null;
        }>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/tag?name=${encodeURIComponent(name)}`,
          undefined,
          120_000,
        ),
  pages: async (prefix: string, label: string, autoSync = false) => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (isBrowserNativeMode()) return pagesOffStub(prefix, label);
    // NEW CODE - TESTING: Freenet-native Pages
    if (isBrowserNativeMode()) {
      const { nativePagesStatus } = await import("./freenet/native-pages");
      return nativePagesStatus(prefix, label, autoSync);
    }
    return apiFetch<ForgePagesConfig>(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/pages${autoSync ? "?autoSync=1" : ""}`,
      undefined,
      autoSync ? 600_000 : 15_000,
    );
  },
  pagesEnable: async (
    prefix: string,
    label: string,
    body: { branch?: string; rootPath?: string; autoSync?: boolean } = {},
  ) => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (isBrowserNativeMode()) {
    //   throw new Error("Pages require the Hub bridge (not available in website mode)");
    // }
    // NEW CODE - TESTING
    if (isBrowserNativeMode()) {
      const { nativePagesEnable } = await import("./freenet/native-pages");
      return nativePagesEnable(prefix, label, body);
    }
    return apiFetch<ForgePagesConfig>(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/pages/enable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      600_000,
    );
  },
  pagesSync: async (prefix: string, label: string) => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (isBrowserNativeMode()) {
    //   throw new Error("Pages require the Hub bridge (not available in website mode)");
    // }
    // NEW CODE - TESTING
    if (isBrowserNativeMode()) {
      const { nativePagesSync } = await import("./freenet/native-pages");
      return nativePagesSync(prefix, label);
    }
    return apiFetch<ForgePagesConfig>(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/pages/sync`,
      { method: "POST" },
      600_000,
    );
  },
  pagesDisable: async (
    prefix: string,
    label: string,
    body: { tombstone?: boolean } = {},
  ) => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (isBrowserNativeMode()) {
    //   throw new Error("Pages require the Hub bridge (not available in website mode)");
    // }
    // NEW CODE - TESTING
    if (isBrowserNativeMode()) {
      const { nativePagesDisable } = await import("./freenet/native-pages");
      const cfg = await nativePagesDisable(prefix, label, body);
      // NEW CODE - TESTING: if About.website was the Pages URL, clear it
      const { clearAboutWebsiteIfMatchesPages } = await import(
        "./freenet/pages-about"
      );
      await clearAboutWebsiteIfMatchesPages(prefix, label, cfg);
      return cfg;
    }
    return apiFetch<ForgePagesConfig>(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/pages/disable`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      600_000,
    );
  },
  registry: async () => {
    if (isBrowserNativeMode()) {
      const { fetchForgeRegistry } = await import("./freenet/forge-registry");
      const { loadRegistryCached } = await import("./freenet/discover-cache");
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // return fetchForgeRegistry();
      // NEW CODE - TESTING: share one ForgeRegistry GET across discover/repo/header
      const repos = await loadRegistryCached(() => fetchForgeRegistry());
      return { repos, note: undefined as string | undefined, source: "contract" as const };
    }
    return apiFetch<{ repos: ForgeRegistration[]; note?: string }>(
      "/api/registry",
      undefined,
      15_000,
    );
  },
  registryLookup: async (prefix: string) => {
    if (isBrowserNativeMode()) {
      const { fetchForgeRegistry } = await import("./freenet/forge-registry");
      const { loadRegistryCached } = await import("./freenet/discover-cache");
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const { repos } = await fetchForgeRegistry();
      // NEW CODE - TESTING
      const repos = await loadRegistryCached(() => fetchForgeRegistry());
      const hit = repos.find((r) => r.repo_prefix === prefix);
      if (!hit) throw new Error("not found");
      return hit;
    }
    return apiFetch<ForgeRegistration>(
      `/api/registry/${encodeURIComponent(prefix)}`,
      undefined,
      10_000,
    );
  },
  person: async (fingerprint: string) => {
    if (isBrowserNativeMode()) {
      const { loadPerson } = await import("./registry/client");
      return loadPerson(fingerprint);
    }
    return apiFetch<PersonResponse>(
      `/api/people/${encodeURIComponent(fingerprint)}`,
      undefined,
      15_000,
    );
  },
  registerRepo: async (body: {
    prefix: string;
    label: string;
    name?: string;
    description?: string;
    website?: string | null;
    topics?: string[];
  }) => {
    if (isBrowserNativeMode()) {
      const { nativeRegisterRepo } = await import("./freenet/owner-api");
      return nativeRegisterRepo(body);
    }
    return apiFetch<ForgeRegistration>("/api/registry/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);
  },
  unregisterRepo: async (prefix: string, registrySeq?: number) => {
    if (isBrowserNativeMode()) {
      const { nativeUnregisterRepo } = await import("./freenet/owner-api");
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // await nativeUnregisterRepo({ prefix });
      // NEW CODE - TESTING: optional seq to beat live ForgeRegistry listing
      await nativeUnregisterRepo({ prefix, seq: registrySeq });
      return;
    }
    await apiFetch<{ ok: boolean }>("/api/registry/unregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    }, 30_000);
  },
  softDeleteRepo: async (prefix: string, registrySeq?: number) => {
    if (isBrowserNativeMode()) {
      const { nativeSoftDeleteRepo } = await import("./freenet/owner-api");
      await nativeSoftDeleteRepo({ prefix, registrySeq });
      return;
    }
    // Bridge: unregister only (no Freenet RepoState Update from Express).
    await api.unregisterRepo(prefix);
  },
  renameRepo: async (
    prefix: string,
    newName: string,
    opts?: { description?: string | null; registrySeq?: number },
  ): Promise<{ label: string; name: string }> => {
    if (isBrowserNativeMode()) {
      const { nativeRenameRepo } = await import("./freenet/owner-api");
      return nativeRenameRepo({
        prefix,
        name: newName,
        description: opts?.description,
        registrySeq: opts?.registrySeq,
      });
    }
    throw new Error(
      "Rename requires Freenet website mode (owner-signed RepoState update).",
    );
  },
  /** About: RepoState.description + ForgeRegistry website/topics. */
  updateRepoAbout: async (input: {
    prefix: string;
    label: string;
    name?: string | null;
    description: string;
    website?: string | null;
    topics?: string[];
  }): Promise<{ description: string; registration: ForgeRegistration }> => {
    if (isBrowserNativeMode()) {
      const { nativeUpdateRepoAbout } = await import("./freenet/owner-api");
      return nativeUpdateRepoAbout(input);
    }
    throw new Error(
      "About edits require Freenet website mode (owner-signed updates).",
    );
  },
  rawUrl: (prefix: string, label: string, ref: string, path: string) =>
    apiUrl(
      `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/raw?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
    ),
  blame: (prefix: string, label: string, ref: string, path: string) =>
    isBrowserNativeMode()
      ? import("./freenet/native-blame").then(({ nativeBlame }) =>
          nativeBlame(prefix, label, ref, path),
        )
      : apiFetch<BlameResponse>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/blame?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
          undefined,
          180_000,
        ),
  readme: (prefix: string, label: string, ref: string) =>
    isBrowserNativeMode()
      ? nativeReadme(prefix, label, ref)
      : apiFetch<{ path: string | null; content: string | null; ref: string }>(
          `/api/r/${encodeURIComponent(prefix)}/${encodeURIComponent(label)}/readme?ref=${encodeURIComponent(ref)}`,
          undefined,
          180_000,
        ),
  branchName,
};
