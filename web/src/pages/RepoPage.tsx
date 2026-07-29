import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Link } from "../spa-link";
import {
  api,
  describeBrowseError,
  type BlobResponse,
  type CommitEntry,
  type Contributor,
  type DemoRepo,
  type HubRegistration,
  type RepoPageData,
  type TreeEntry,
} from "../api";
import { CodeCloneMenu } from "../components/CodeCloneMenu";
import { AddFileMenu } from "../components/AddFileMenu";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { CodeCloneMenu, SourceZipLink } from "../components/CodeCloneMenu";
// SourceZipLink was only used by the fake Releases UI.
import { DeletedRepoPanel } from "../components/DeletedRepoPanel";
import { FileTreeSidepanel } from "../components/FileTreeSidepanel";
import { GoToFileSearch } from "../components/GoToFileSearch";
import { BranchesView } from "../components/BranchesView";
import { BranchDivergenceBanner } from "../components/BranchDivergenceBanner";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import {
  FREENET_FETCHING_CONTRACT,
  FREENET_FETCHING_CONTRACT_HINT,
} from "../freenet/contract-fetch-status";
import { PagesSidebarBlock } from "../components/PagesSidebarBlock";
import { LanguagesSidebarBlock } from "../components/LanguagesSidebarBlock";
import { CommunityFilesPanel } from "../components/CommunityFilesPanel";
import { PersonName } from "../components/PersonName";
import { RepoAboutBlock } from "../components/RepoAboutBlock";
import { RepoHealthBlock } from "../components/RepoHealthBlock";
import { RegisterRepoModal } from "../components/RegisterRepoModal";
import { StarButton } from "../components/StarButton";
import {
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
import {
  FileContentPanel,
  isMarkdownPath,
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // ReadmePanel,
} from "../components/MarkdownPanel";
import { collapseCommitSubject, shortEmailHash } from "../lib/display";
import { repoDisplayName, slugRepoLabel } from "../lib/repo-display";
import {
  decodeRepoFilePath,
  parseRepoRouteParts,
  repoBlobHref,
  repoHref,
  repoPathDisplay,
  repoRawHref,
  repoTreeHref,
  type RepoHrefOpts,
} from "../lib/repo-path";
import { parseWhoamiStdout } from "../lib/whoami";
import { clearRepoTipCaches } from "../freenet/native-api";
import {
  cancelScheduledRepoTipCacheClear,
  scheduleRepoTipCacheClear,
} from "../freenet/tip-cache-lifecycle";
import { serveRawFileInCurrentDocument } from "../freenet/serve-raw";
import { freenetRawFileHref } from "../freenet/raw-entry";
import { isBrowserNativeMode } from "../tip-browse";
import {
  looksLikeRepoNotFound,
  NotFoundPage,
} from "./NotFoundPage";
import { RepoSettingsView } from "./RepoSettingsView";
import { RepoNewFileView } from "./RepoNewFileView";
import { RepoUploadView } from "./RepoUploadView";
import { EmptyRepoSetup } from "../components/EmptyRepoSetup";
import { useDocumentTitle } from "../lib/document-title";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 45) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  if (mo < 18) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.round(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

type RepoParamsResult =
  | {
      ok: true;
      prefix: string;
      label: string;
      ownerSlug: string | null;
      unregisteredBucket: boolean;
      ownerOpts: RepoHrefOpts;
    }
  | { ok: false; redirectTo: string };

function useRepoParams(): RepoParamsResult {
  const location = useLocation();
  const parts = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const parsed = parseRepoRouteParts(parts);
  if (!parsed) return { ok: false, redirectTo: "/" };

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // flat /prefix~label and /prefix/label as primary routes
  // NEW CODE - TESTING: legacy flat → /r/{id}
  if (parsed.legacyFlat) {
    const sub = parsed.rest.join("/");
    return {
      ok: false,
      redirectTo: repoHref(parsed.prefix, parsed.label, sub),
    };
  }

  return {
    ok: true,
    prefix: parsed.prefix,
    label: parsed.label,
    ownerSlug: parsed.ownerSlug,
    unregisteredBucket: parsed.unregisteredBucket,
    ownerOpts: parsed.ownerSlug ? { ownerSlug: parsed.ownerSlug } : {},
  };
}

function refFromBranch(defaultBranch: string | null, branchParam?: string) {
  if (branchParam) return branchParam;
  if (defaultBranch?.startsWith("refs/")) {
    return defaultBranch.replace(/^refs\/heads\//, "");
  }
  return defaultBranch ?? "HEAD";
}

function FolderIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"
      />
    </svg>
  );
}

function BranchSelect({
  branches,
  value,
  onChange,
}: {
  branches: string[];
  value: string;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = branches.includes(value) ? value : branches[0] ?? value;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className={`gh-branch-menu ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="gh-branch-btn"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gh-branch-btn-icon" aria-hidden>
          <BranchIcon />
        </span>
        <span className="gh-branch-btn-name">{current}</span>
        <span className="gh-branch-btn-chevron" aria-hidden>
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <ul className="gh-branch-dropdown" role="listbox">
          {branches.map((b) => (
            <li key={b}>
              <button
                type="button"
                role="option"
                aria-selected={b === current}
                className={b === current ? "active" : ""}
                onClick={() => {
                  setOpen(false);
                  onChange(b);
                }}
              >
                <span className="gh-branch-btn-icon" aria-hidden>
                  <BranchIcon />
                </span>
                {b}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Prefer semver-like tags for “Latest” (unused while Releases UI is removed). */
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
export function pickLatestTag(tagNames: string[]): string | null {
  if (tagNames.length === 0) return null;
  const scored = tagNames.map((name) => {
    const bare = name.replace(/^v/i, "");
    const parts = bare.split(/[.+-]/).map((p) => Number.parseInt(p, 10));
    const semver = parts.every((n) => !Number.isNaN(n)) && parts.length >= 2;
    return { name, semver, parts: semver ? parts : [] };
  });
  const sem = scored.filter((s) => s.semver);
  if (sem.length) {
    sem.sort((a, b) => {
      const len = Math.max(a.parts.length, b.parts.length);
      for (let i = 0; i < len; i += 1) {
        const d = (b.parts[i] ?? 0) - (a.parts[i] ?? 0);
        if (d) return d;
      }
      return b.name.localeCompare(a.name);
    });
    return sem[0].name;
  }
  return [...tagNames].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

function contributorLabel(
  c: Contributor,
  duplicateNames: Set<string>,
): { name: string; postfix: string | null } {
  const key = c.name.trim().toLowerCase();
  if (duplicateNames.has(key)) {
    return { name: c.name, postfix: shortEmailHash(c.email) };
  }
  return { name: c.name, postfix: null };
}

export function RepoPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useRepoParams();
  const prefix = params.ok ? params.prefix : "";
  const label = params.ok ? params.label : "";
  const ownerOpts: RepoHrefOpts = params.ok ? params.ownerOpts : {};
  const unregisteredBucket = params.ok ? params.unregisteredBucket : false;
  const [repo, setRepo] = useState<RepoPageData | null>(null);
  const [demos, setDemos] = useState<DemoRepo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [wasmBlocked, setWasmBlocked] = useState(false);
  // registryOwner init moved below navRegistrationFp
  const [isRepoOwner, setIsRepoOwner] = useState(false);
  // NEW CODE - TESTING: avoid flashing create/upload UI before ownership is known
  const [ownershipReady, setOwnershipReady] = useState(false);

  // NEW CODE - TESTING: one-shot soft-delete / unregister navigation from Settings
  const softDeleteNav = (location.state ?? null) as {
    softDeleted?: boolean;
    softDeletedAt?: string | null;
    hubUnregistered?: boolean;
    registration?: {
      repo_prefix?: string;
      identity_fingerprint?: string;
    } | null;
  } | null;
  const softDeleteFlash = Boolean(softDeleteNav?.softDeleted);
  const softDeleteFlashAt = softDeleteNav?.softDeletedAt ?? null;
  // NEW CODE - TESTING: unregister → repo home must not flash Registered
  const hubUnregistered = Boolean(softDeleteNav?.hubUnregistered);
  // NEW CODE - TESTING: create→repo navigate carries SignedRegister entry
  const navReg = softDeleteNav?.registration;
  const navRegistrationFp =
    !hubUnregistered &&
    navReg &&
    (!navReg.repo_prefix || navReg.repo_prefix === prefix) &&
    navReg.identity_fingerprint
      ? navReg.identity_fingerprint
      : null;
  const [registryOwner, setRegistryOwner] = useState<string | null>(() =>
    hubUnregistered ? null : navRegistrationFp,
  );
  // NEW CODE - TESTING: know when HubRegistry probe finished (badge vs flash)
  const [registryReady, setRegistryReady] = useState(
    () => Boolean(navRegistrationFp) || hubUnregistered,
  );

  // Drop tip/pack memory when leaving this repo (or switching prefix) so the
  // next visit is a cold Freenet load and RAM does not accumulate packs.
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // useEffect(() => {
  //   if (!prefix) return;
  //   return () => { clearRepoTipCaches(prefix); };
  // }, [prefix]);
  // NEW CODE - TESTING: defer clear so React StrictMode remount does not abort
  // soft-fill mid-flight (README relative images were failing against the
  // aborted tip while a later /blob view used a fresh full tip).
  useEffect(() => {
    if (!prefix) return;
    cancelScheduledRepoTipCacheClear(prefix);
    return () => {
      scheduleRepoTipCacheClear(prefix, clearRepoTipCaches);
    };
  }, [prefix]);

  useEffect(() => {
    if (!prefix) return;
    let cancelled = false;
    // NEW CODE - TESTING: reset until this prefix’s ownership probe finishes
    setOwnershipReady(false);
    setIsRepoOwner(false);
    void (async () => {
      try {
        if (isBrowserNativeMode()) {
          const { nativeListRepos } = await import("../freenet/owner-api");
          const repos = await nativeListRepos();
          if (!cancelled) {
            setIsRepoOwner(repos.some((r) => r.prefix === prefix));
          }
          return;
        }
        const id = await api.identity();
        if (cancelled || !id.ok) {
          if (!cancelled) setIsRepoOwner(false);
          return;
        }
        const parsed = parseWhoamiStdout(id.stdout);
        if (!cancelled) {
          setIsRepoOwner(
            Boolean(parsed?.repos.some((r) => r.prefix === prefix)),
          );
        }
      } catch {
        if (!cancelled) setIsRepoOwner(false);
      } finally {
        // NEW CODE - TESTING
        if (!cancelled) setOwnershipReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // useEffect(() => { ensureOwnerRepoSideContracts on this page … }) —
  // aborted/ignored when navigating away; work belonged on the page.
  // NEW CODE - TESTING: global RepoBackupWorker provisions; UI only reacts
  useEffect(() => {
    if (!prefix) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/hub-repo").then(({ onOwnerRepoProvisioned }) => {
      if (cancelled) return;
      unsub = onOwnerRepoProvisioned((detail) => {
        if (detail.prefix !== prefix) return;
        const fp = detail.registration?.identity_fingerprint;
        if (fp) {
          setRegistryOwner(fp);
          setRegistryReady(true);
        }
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [prefix]);

  // NEW CODE - TESTING: after Freenet tip push, soft-refetch without remount /
  // location.assign (assign 404s deep paths in the website contract sandbox).
  useEffect(() => {
    if (!params.ok || !prefix || !label) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
      if (cancelled) return;
      unsub = onRepoTipPushed((pushedPrefix) => {
        if (cancelled || pushedPrefix !== prefix) return;
        void api
          .repo(prefix, label)
          .then((data) => {
            if (cancelled) return;
            setRepo(data);
            setError(null);
            setBusy(false);
          })
          .catch(() => {
            /* keep current paint; tree/blob may still recover */
          });
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [params.ok, prefix, label]);

  // Seed registry badge from create-nav / unregister-nav once per navigation.
  useEffect(() => {
    if (hubUnregistered) {
      setRegistryOwner(null);
      setRegistryReady(true);
      // Drop the one-shot flag so a later Register can stick; cache tombstone
      // still blocks stale HubRegistry GETs from resurrecting the listing.
      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
        {
          replace: true,
          state: softDeleteFlash
            ? {
                softDeleted: true,
                softDeletedAt: softDeleteFlashAt,
              }
            : {},
        },
      );
      return;
    }
    if (navRegistrationFp) {
      setRegistryOwner(navRegistrationFp);
      setRegistryReady(true);
    }
  }, [
    hubUnregistered,
    navRegistrationFp,
    softDeleteFlash,
    softDeleteFlashAt,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  // Reset registry badge when URL prefix changes (same RepoPage instance).
  useEffect(() => {
    const nav = (location.state ?? null) as {
      hubUnregistered?: boolean;
      registration?: {
        repo_prefix?: string;
        identity_fingerprint?: string;
      } | null;
    } | null;
    const unreg = Boolean(nav?.hubUnregistered);
    const reg = nav?.registration;
    const fp =
      !unreg &&
      reg &&
      (!reg.repo_prefix || reg.repo_prefix === prefix) &&
      reg.identity_fingerprint
        ? reg.identity_fingerprint
        : null;
    if (unreg) {
      setRegistryOwner(null);
      setRegistryReady(true);
    } else if (fp) {
      setRegistryOwner(fp);
      setRegistryReady(true);
    } else {
      setRegistryOwner(null);
      setRegistryReady(false);
    }
    // Intentionally prefix-only: clearing unregister nav state must not flash loading.
  }, [prefix]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Promise.all([api.repo, demos, registryLookup]) blocked first paint on slow GETs
  // and /r/→words Navigate remounted the whole page.
  // NEW CODE - TESTING: paint as soon as refs resolve; registry/demos in background
  useEffect(() => {
    if (!params.ok || !prefix || !label) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    setWasmBlocked(false);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Kept previous repo while refetching (rename could canonicalize back to old label).
    // NEW CODE - TESTING: drop stale payload when URL label/prefix changes
    setRepo(null);
    void api
      .repo(prefix, label)
      .then((data) => {
        if (cancelled) return;
        setRepo(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setWasmBlocked(
          Boolean((err as { wasmExecBlocked?: boolean }).wasmExecBlocked) ||
            message.toLowerCase().includes("local store lookup failed") ||
            message.toLowerCase().includes("init_t"),
        );
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.ok, prefix, label]);

  // NEW CODE - TESTING: after soft-delete navigate, refetch tombstone without full reload
  useEffect(() => {
    if (!params.ok || !prefix || !label || !softDeleteFlash) return;
    let cancelled = false;
    clearRepoTipCaches(prefix);
    void api
      .repo(prefix, label)
      .then((data) => {
        if (cancelled) return;
        setRepo(data);
        setError(null);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // Always cleared nav state after any refetch.
        // NEW CODE - TESTING: keep flash until tombstone is visible on RepoState
        if (data.softDelete?.deleted) {
          navigate(
            {
              pathname: location.pathname,
              search: location.search,
              hash: location.hash,
            },
            { replace: true, state: {} },
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // Keep flash state so UI can still show a deleted panel if GET fails
        if (!looksLikeRepoNotFound(message)) {
          setError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    params.ok,
    prefix,
    label,
    softDeleteFlash,
    navigate,
    location.pathname,
    location.search,
    location.hash,
  ]);

  // NEW CODE - TESTING: canonicalize URL to slug(RepoState.name) when it differs
  useEffect(() => {
    if (!params.ok || !repo?.name || !prefix) return;
    const want = slugRepoLabel(repo.name);
    if (!want || want === label) return;
    const parts = location.pathname.split("/").filter(Boolean);
    const parsed = parseRepoRouteParts(parts);
    const sub = parsed?.rest.join("/") ?? "";
    navigate(repoHref(prefix, want, sub, ownerOpts), { replace: true });
  }, [params.ok, repo?.name, prefix, label, location.pathname, navigate, ownerOpts]);

  useEffect(() => {
    if (!params.ok || !prefix) return;
    let cancelled = false;
    void api
      .demos()
      .then((d) => {
        if (!cancelled) setDemos(d.demos);
      })
      .catch(() => {
        if (!cancelled) setDemos([]);
      });
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // void api.registryLookup(prefix) … raced HubRegistry GET against tip pack
    // NEW CODE - TESTING: warm owner from cache only until refs resolve
    void import("../freenet/discover-cache").then(({ peekCachedRegistry }) => {
      if (cancelled) return;
      // Prefer create-nav fingerprint so Registered paints before HubRegistry GET
      if (hubUnregistered) {
        setRegistryOwner(null);
        setRegistryReady(true);
        return;
      }
      if (navRegistrationFp) {
        setRegistryOwner(navRegistrationFp);
        setRegistryReady(true);
        return;
      }
      const hit = peekCachedRegistry()?.find((r) => r.repo_prefix === prefix);
      if (hit) {
        setRegistryOwner(hit.identity_fingerprint);
        setRegistryReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params.ok, prefix, navRegistrationFp, hubUnregistered]);

  // HubRegistry network after refs so tip-pack claims the FIFO WS queue first.
  useEffect(() => {
    if (!repo || !prefix) return;
    let cancelled = false;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // always registryLookup → setRegistryOwner(hit)
    // NEW CODE - TESTING: while unregister nav flag is set, don't paint Registered
    // from a lagging GET (cache tombstone also filters; this covers the first tick)
    if (hubUnregistered) {
      setRegistryOwner(null);
      setRegistryReady(true);
      return;
    }
    void api
      .registryLookup(prefix)
      .then((reg) => {
        if (!cancelled) {
          setRegistryOwner(reg.identity_fingerprint);
          setRegistryReady(true);
        }
      })
      .catch(() => {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // if (!cancelled) setRegistryOwner(null);
        // NEW CODE - TESTING: keep create-nav / cache seed when GET races empty
        if (cancelled) return;
        if (navRegistrationFp) {
          setRegistryReady(true);
          return;
        }
        void import("../freenet/discover-cache").then(
          ({ peekCachedRegistry }) => {
            if (cancelled) return;
            const hit = peekCachedRegistry()?.find(
              (r) => r.repo_prefix === prefix,
            );
            if (hit) setRegistryOwner(hit.identity_fingerprint);
            else setRegistryOwner(null);
            setRegistryReady(true);
          },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [repo, prefix, navRegistrationFp, hubUnregistered]);

  // Soft-canonicalize /r/… → /{words}/… without a Freenet iframe remount.
  useEffect(() => {
    if (!params.ok || !unregisteredBucket || !registryOwner) return;
    const rest =
      location.pathname
        .replace(/^\//, "")
        .split("/")
        .filter(Boolean)
        .slice(2)
        .join("/") || "";
    void navigate(
      repoHref(prefix, label, rest, { ownerFingerprint: registryOwner }),
      { replace: true },
    );
  }, [
    params.ok,
    unregisteredBucket,
    registryOwner,
    prefix,
    label,
    location.pathname,
    navigate,
  ]);

  const defaultBranch = useMemo(
    () => refFromBranch(repo?.defaultBranch ?? null),
    [repo],
  );

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const aboutText = useMemo(() => {
  //   const demo = demos.find((d) => d.url.includes(`/${label}`) || d.name === label);
  //   return demo?.description ?? repo?.content.detail ?? null;
  // }, [demos, label, repo]);
  // NEW CODE - TESTING: About uses RepoState.description (not content.detail status)
  const aboutText = useMemo(() => {
    const demo = demos.find((d) => d.url.includes(`/${label}`) || d.name === label);
    return (
      repo?.description?.trim() ||
      demo?.description ||
      null
    );
  }, [demos, label, repo]);

  const repoDocumentTitle = useMemo(() => {
    if (!params.ok) return "Repository";
    const shown = repo ? repoDisplayName(repo.name, label) : label;
    const ownerSlug = params.ownerSlug;
    const scope = ownerSlug ? `${ownerSlug}/${shown}` : shown;
    const parts = location.pathname.replace(/^\//, "").split("/").filter(Boolean);
    const parsed = parseRepoRouteParts(parts);
    const rest = parsed?.rest ?? [];
    const head = rest[0];

    if (softDeleteFlash || repo?.softDelete?.deleted) {
      return `Deleted · ${scope}`;
    }
    if (head === "settings") {
      const tab = new URLSearchParams(location.search).get("tab");
      if (tab === "pages") return `Pages settings · ${scope}`;
      if (tab === "collaborators") return `Collaborators · ${scope}`;
      return `Settings · ${scope}`;
    }
    if (head === "commits") return `Commits · ${scope}`;
    if (head === "branches") return `Branches · ${scope}`;
    if (head === "tags") return `Tags · ${scope}`;
    if (head === "new") return `New file · ${scope}`;
    if (head === "upload") return `Upload files · ${scope}`;
    if ((head === "blob" || head === "raw") && rest.length >= 3) {
      const filePath = decodeRepoFilePath(rest.slice(2).join("/"));
      return filePath ? `${filePath} · ${scope}` : scope;
    }
    if (head === "tree" && rest.length >= 3) {
      const treePath = decodeRepoFilePath(rest.slice(2).join("/"));
      return treePath ? `${treePath} · ${scope}` : scope;
    }
    if (aboutText) {
      const desc =
        aboutText.length > 72 ? `${aboutText.slice(0, 72)}…` : aboutText;
      return `${scope}: ${desc}`;
    }
    return scope;
  }, [
    params,
    repo,
    label,
    location.pathname,
    location.search,
    softDeleteFlash,
    aboutText,
  ]);
  useDocumentTitle(repoDocumentTitle);

  const linkOpts: RepoHrefOpts = registryOwner
    ? { ownerFingerprint: registryOwner }
    : ownerOpts;

  const sessionFp = getCachedIdentity()?.fingerprint ?? null;
  const registeredOnAtlas = Boolean(registryOwner);
  const registeredBadge: boolean | null = registryOwner
    ? true
    : registryReady
      ? false
      : null;
  const isRegistryOwner = Boolean(
    registryOwner && sessionFp && registryOwner === sessionFp,
  );

  if (!params.ok) {
    return <Navigate to={params.redirectTo} replace />;
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (unregisteredBucket && registryOwner) return <Navigate … />  // full remount
  // NEW CODE - TESTING: canonicalize via navigate() in effect above

  if (busy && !repo) {
    return (
      <main className="page">
        <PageLoadingOverlay
          skeleton="refs"
          message={
            <>
              {FREENET_FETCHING_CONTRACT}
              <span className="muted tiny block" style={{ marginTop: "0.35rem" }}>
                Reading refs for{" "}
                <span className="mono">
                  {repoPathDisplay(prefix, label, linkOpts)}
                </span>
                . {FREENET_FETCHING_CONTRACT_HINT}
              </span>
            </>
          }
        />
      </main>
    );
  }

  if (error && !repo) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return (
    //   <main className="page">
    //     <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
    //       {error}
    //     </div>
    //     ...
    //   </main>
    // );
    // NEW CODE - TESTING: missing repos get a real 404 page
    // Soft-delete flash: show deleted panel instead of 404 / blank after Settings delete
    if (softDeleteFlash) {
      return (
        <main className="page repo-page">
          <DeletedRepoPanel
            displayName={label}
            deletedAt={softDeleteFlashAt}
          />
        </main>
      );
    }
    if (!wasmBlocked && looksLikeRepoNotFound(error)) {
      return (
        <NotFoundPage
          kind="repo"
          detail={repoPathDisplay(prefix, label, linkOpts)}
        />
      );
    }
    return (
      <main className="page">
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
        {wasmBlocked ? (
          <div className="warn-banner">
            See <span className="mono">docs/04-selinux-wasm-jit.md</span> — freenet
            should run as a user service (<span className="mono">unconfined_t</span>
            ).
          </div>
        ) : null}
        <Link to="/" className="btn secondary">
          Back to GitAtlas
        </Link>
      </main>
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!repo) return null;
  // NEW CODE - TESTING: avoid white screen while refs resolve / after mutate
  if (!repo) {
    return (
      <main className="page">
        <PageLoadingOverlay
          skeleton="refs"
          message={
            <>
              {FREENET_FETCHING_CONTRACT}
              <span className="muted tiny block" style={{ marginTop: "0.35rem" }}>
                Reading refs for{" "}
                <span className="mono">
                  {repoPathDisplay(prefix, label, linkOpts)}
                </span>
                . {FREENET_FETCHING_CONTRACT_HINT}
              </span>
            </>
          }
        />
      </main>
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always Navigate index → tree/main (fails for freenet-git create with no refs).
  // NEW CODE - TESTING: empty contracts stay on repo root with push instructions
  // Soft-deleted repos get a dedicated panel instead of file explorer / empty setup.
  const isDeletedRepo =
    Boolean(repo.softDelete?.deleted) || softDeleteFlash;
  const displayRepo: RepoPageData = isDeletedRepo && !repo.softDelete?.deleted
    ? {
        ...repo,
        softDelete: {
          deleted: true,
          source: "extension",
          at: softDeleteFlashAt,
        },
      }
    : repo;
  const isEmptyRepo =
    Boolean(displayRepo.empty) || displayRepo.refs.length === 0;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const fileWorkspace =
  //   !isDeletedRepo &&
  //   /\/(blob|raw|new|upload)(\/|$)/.test(location.pathname);
  // NEW CODE - TESTING: hide repo title/about on file + branches/tags; full width
  // Nested tree paths (/tree/{branch}/…) share blob chrome (sidepanel + full width).
  const nestedTreeWorkspace =
    !isDeletedRepo && /\/tree\/[^/]+\/.+/.test(location.pathname);
  const hideRepoHeader =
    !isDeletedRepo &&
    (/\/(blob|raw|new|upload|branches|tags)(\/|$)/.test(location.pathname) ||
      nestedTreeWorkspace);
  const fileWorkspace =
    (!isDeletedRepo &&
      /\/(blob|raw|new|upload)(\/|$)/.test(location.pathname)) ||
    nestedTreeWorkspace;

  return (
    <main
      className={`page repo-page${hideRepoHeader ? " repo-page--wide" : ""}${fileWorkspace ? " repo-page--file" : ""}`}
    >
      <div
        className={`repo-page-body${hideRepoHeader ? " repo-page-body--wide" : ""}${fileWorkspace ? " repo-page-body--file" : ""}`}
      >
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        Always showed RepoHeader (Public / Freenet / Star) on every sub-route.
        <RepoHeader repo={repo} aboutText={aboutText} />
        */}
        {/* NEW CODE - TESTING: hide on blob/new/upload/branches/tags for full width */}
        {!hideRepoHeader ? (
          <RepoHeader
            repo={displayRepo}
            registered={registeredBadge}
            onRegistered={(reg) => {
              setRegistryOwner(reg.identity_fingerprint);
              setRegistryReady(true);
            }}
          />
        ) : null}
        {error ? (
          <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        ) : null}
        <Routes>
          {isDeletedRepo ? (
            <>
              <Route
                index
                element={
                  <DeletedRepoView
                    prefix={prefix}
                    label={label}
                    repo={displayRepo}
                    aboutText={aboutText}
                  />
                }
              />
              <Route
                path="*"
                element={
                  <Navigate
                    to={repoHref(prefix, label, "", linkOpts)}
                    replace
                  />
                }
              />
            </>
          ) : isEmptyRepo ? (
            <>
              <Route
                index
                element={
                  <EmptyRepoView
                    prefix={prefix}
                    label={label}
                    repo={displayRepo}
                    aboutText={aboutText}
                    isOwner={isRepoOwner}
                    isRegistryOwner={isRegistryOwner}
                    registered={registeredOnAtlas}
                    ownerOpts={linkOpts}
                  />
                }
              />
              <Route
                path="new/:branch"
                element={
                  <RepoNewFileView
                    prefix={prefix}
                    label={label}
                    remote={displayRepo.remote}
                    ownerOpts={linkOpts}
                    isOwner={isRepoOwner}
                    ownershipReady={ownershipReady}
                    displayName={repoDisplayName(displayRepo.name, label)}
                    branches={[
                      refFromBranch(displayRepo.defaultBranch) || "main",
                    ]}
                  />
                }
              />
              <Route
                path="upload/:branch"
                element={
                  <RepoUploadView
                    prefix={prefix}
                    label={label}
                    remote={displayRepo.remote}
                    ownerOpts={linkOpts}
                    isOwner={isRepoOwner}
                    ownershipReady={ownershipReady}
                    displayName={repoDisplayName(displayRepo.name, label)}
                    branches={[
                      refFromBranch(displayRepo.defaultBranch) || "main",
                    ]}
                  />
                }
              />
              <Route
                path="settings"
                element={
                  <RepoSettingsView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                    isOwner={isRepoOwner}
                    registered={registeredOnAtlas}
                    isRegistryOwner={isRegistryOwner}
                  />
                }
              />
              <Route
                path="*"
                element={
                  <Navigate
                    to={repoHref(prefix, label, "", linkOpts)}
                    replace
                  />
                }
              />
            </>
          ) : (
            <>
              <Route
                index
                element={
                  <Navigate
                    to={`tree/${encodeURIComponent(defaultBranch)}`}
                    replace
                  />
                }
              />
              <Route
                path="tree/:branch/*"
                element={
                  <TreeView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                    aboutText={aboutText}
                    isOwner={isRepoOwner}
                    isRegistryOwner={isRegistryOwner}
                    registered={registeredOnAtlas}
                  />
                }
              />
              <Route
                path="blob/:branch/*"
                element={
                  <BlobView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                    isOwner={isRepoOwner}
                  />
                }
              />
              <Route
                path="raw/:branch/*"
                element={
                  <RawView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                  />
                }
              />
              <Route
                path="commits/:branch?"
                element={
                  <CommitsView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                  />
                }
              />
              <Route
                path="branches"
                element={
                  <BranchesView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                  />
                }
              />
              <Route
                path="tags"
                element={
                  <TagsView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                  />
                }
              />
              <Route
                path="settings"
                element={
                  <RepoSettingsView
                    prefix={prefix}
                    label={label}
                    ownerOpts={linkOpts}
                    repo={displayRepo}
                    isOwner={isRepoOwner}
                    registered={registeredOnAtlas}
                    isRegistryOwner={isRegistryOwner}
                  />
                }
              />
              {/* NEW CODE - TESTING: Add file works on non-empty repos too */}
              <Route
                path="new/:branch"
                element={
                  <RepoNewFileView
                    prefix={prefix}
                    label={label}
                    remote={displayRepo.remote}
                    ownerOpts={linkOpts}
                    isOwner={isRepoOwner}
                    ownershipReady={ownershipReady}
                    displayName={repoDisplayName(displayRepo.name, label)}
                    branches={displayRepo.refs
                      .filter((r) => r.name.startsWith("refs/heads/"))
                      .map((r) => r.name.replace(/^refs\/heads\//, ""))}
                  />
                }
              />
              <Route
                path="upload/:branch"
                element={
                  <RepoUploadView
                    prefix={prefix}
                    label={label}
                    remote={displayRepo.remote}
                    ownerOpts={linkOpts}
                    isOwner={isRepoOwner}
                    ownershipReady={ownershipReady}
                    displayName={repoDisplayName(displayRepo.name, label)}
                    branches={displayRepo.refs
                      .filter((r) => r.name.startsWith("refs/heads/"))
                      .map((r) => r.name.replace(/^refs\/heads\//, ""))}
                  />
                }
              />
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              <Route path="releases" … />
              No /releases routes — fake Releases UI removed; unknown paths 404 below.
              */}
              <Route path="*" element={<NotFoundPage kind="page" />} />
            </>
          )}
        </Routes>
      </div>
    </main>
  );
}

function RepoHeader({
  repo,
  registered,
  onRegistered,
}: {
  repo: RepoPageData;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // aboutText: string | null;
  /** HubRegistry listing known (parent seeds after create / cache). null = still probing. */
  registered: boolean | null;
  onRegistered?: (registration: import("../api").HubRegistration) => void;
}) {
  const { prefix, label } = repo.url;
  const displayName = repoDisplayName(repo.name, label);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always showed Import for any signed-in + unregistered (no key check).
  // NEW CODE - TESTING: Import only when this prefix is in hub-identity (minimal match)
  const [signedIn, setSignedIn] = useState(() => Boolean(getCachedIdentity()));
  const [canImport, setCanImport] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getCachedIdentity()));
    return onAuthSessionChange(() => {
      setSignedIn(Boolean(getCachedIdentity()));
    });
  }, []);

  useEffect(() => {
    if (
      !signedIn ||
      registered !== false ||
      repo.softDelete?.deleted ||
      !isBrowserNativeMode()
    ) {
      setCanImport(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { nativeListRepos } = await import("../freenet/owner-api");
        const repos = await nativeListRepos();
        if (!cancelled) {
          setCanImport(repos.some((r) => r.prefix === prefix));
        }
      } catch {
        if (!cancelled) setCanImport(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, registered, prefix, repo.softDelete?.deleted]);

  return (
    <header className="gh-repo-header">
      {repo.softDelete?.deleted ? (
        <div className="error-banner repo-deleted-banner" role="status">
          This repository was marked deleted by the owner
          {repo.softDelete.at ? ` (${repo.softDelete.at})` : ""}. Data may still
          exist on Freenet until caches forget it; it will not appear in
          GitAtlasRegistry (GAR).
        </div>
      ) : null}
      <div className="gh-repo-title-row">
        <div className="gh-repo-title">
          <h1>
            {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
            <span className="gh-repo-prefix mono">{prefix}</span>
            <span className="sep">/</span>
            <strong className="repo-name">{label}</strong>
            */}
            {/* NEW CODE - TESTING: display name + muted repo key fingerprint */}
            <strong className="repo-name">{displayName}</strong>
            <span
              className="gh-repo-key-muted mono"
              title="Per-repo Freenet key fingerprint (not a user id)"
            >
              ({prefix})
            </span>
          </h1>
          <span className="gh-badge">Public</span>
          <span className="gh-badge muted-badge">Freenet</span>
          {registered === true ? (
            <span
              className="gh-badge success-badge"
              title="Listed on GitAtlasRegistry (GAR)"
            >
              Registered
            </span>
          ) : registered === false ? (
            <span
              className="gh-badge warn-badge"
              title="Not listed on GitAtlasRegistry (GAR)"
            >
              Unregistered
            </span>
          ) : null}
        </div>
        <div className="gh-repo-header-actions">
          {canImport ? (
            <button
              type="button"
              className="btn secondary repo-import-btn"
              title="Register this repo on GitAtlasRegistry (GAR)"
              onClick={() => setImportOpen(true)}
            >
              Import
            </button>
          ) : null}
          <StarButton
            prefix={prefix}
            label={displayName}
            registered={registered === true}
          />
        </div>
      </div>
      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
      {aboutText ? <p className="gh-repo-desc">{aboutText}</p> : null}
      */}
      {/* NEW CODE - TESTING: description lives in About sidebar only */}
      <RegisterRepoModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        prefix={prefix}
        label={label}
        displayName={displayName}
        onRegistered={(reg) => {
          onRegistered?.(reg);
          setCanImport(false);
        }}
      />
    </header>
  );
}

function DeletedRepoView({
  prefix,
  label,
  repo,
  aboutText,
}: {
  prefix: string;
  label: string;
  repo: RepoPageData;
  aboutText: string | null;
}) {
  const [registration, setRegistration] = useState<HubRegistration | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .registryLookup(prefix)
      .then((reg) => {
        if (!cancelled) setRegistration(reg);
      })
      .catch(() => {
        if (!cancelled) setRegistration(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  return (
    <div className="gh-repo-layout">
      <div className="gh-repo-main">
        <DeletedRepoPanel
          displayName={repoDisplayName(repo.name, label)}
          deletedAt={repo.softDelete?.at}
        />
      </div>
      <aside className="gh-sidebar">
        <RepoAboutBlock
          prefix={prefix}
          label={label}
          name={repo.name}
          description={aboutText}
          registration={registration}
          canEdit={false}
          emptyHint="This repository was deleted."
        />
        <section className="gh-side-block">
          <ul className="gh-side-list">
            {registration ? (
              <li>
                <span className="muted">Owner</span>
                <PersonName
                  fingerprint={registration.identity_fingerprint}
                  link
                />
              </li>
            ) : null}
            <li>
              <span className="muted">Repo key</span>
              <span
                className="mono break"
                title="Per-repo Freenet contract fingerprint (not a user id)"
              >
                {prefix}
              </span>
            </li>
            <li>
              <span className="muted">Remote</span>
              <span className="mono break">{repo.url.remote}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function EmptyRepoPanel({
  prefix,
  label,
  remote,
  defaultBranch,
  isOwner,
  ownerOpts,
  displayName,
}: {
  prefix: string;
  label: string;
  remote: string;
  defaultBranch: string;
  isOwner: boolean;
  ownerOpts?: RepoHrefOpts;
  displayName?: string;
}) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Plain “This repository is empty” + two pre blocks (no create/upload).
  // NEW CODE - TESTING: GitHub-style Quick setup + create/upload links
  return (
    <EmptyRepoSetup
      prefix={prefix}
      label={label}
      displayName={displayName}
      remote={remote}
      defaultBranch={defaultBranch}
      isOwner={isOwner}
      ownerOpts={ownerOpts}
    />
  );
}

function EmptyRepoView({
  prefix,
  label,
  repo,
  aboutText,
  isOwner,
  isRegistryOwner,
  registered,
  ownerOpts,
}: {
  prefix: string;
  label: string;
  repo: RepoPageData;
  aboutText: string | null;
  isOwner: boolean;
  isRegistryOwner: boolean;
  registered: boolean;
  ownerOpts?: RepoHrefOpts;
}) {
  const [registration, setRegistration] = useState<HubRegistration | null>(
    null,
  );
  const [aboutDesc, setAboutDesc] = useState<string | null>(aboutText);

  useEffect(() => {
    setAboutDesc(aboutText);
  }, [aboutText]);

  useEffect(() => {
    let cancelled = false;
    void api
      .registryLookup(prefix)
      .then((reg) => {
        if (!cancelled) setRegistration(reg);
      })
      .catch(() => {
        if (!cancelled) setRegistration(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  const intendedBranch = refFromBranch(repo.defaultBranch);

  return (
    <div className="gh-repo-layout">
      <div className="gh-repo-main">
        <EmptyRepoPanel
          prefix={prefix}
          label={label}
          remote={repo.remote}
          defaultBranch={intendedBranch}
          isOwner={isOwner}
          ownerOpts={ownerOpts}
          displayName={repoDisplayName(repo.name, label)}
        />
      </div>
      <aside className="gh-sidebar">
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <section className="gh-side-block">
          <h3>About</h3>
          <p>{aboutText ?? "Empty Freenet-hosted git repository."}</p>
          …
        </section>
        */}
        {/* NEW CODE - TESTING */}
        <RepoAboutBlock
          prefix={prefix}
          label={label}
          name={repo.name}
          description={aboutDesc}
          registration={registration}
          canEdit={isRegistryOwner && registered}
          onDescriptionSaved={setAboutDesc}
          onRegistrationSaved={setRegistration}
          emptyHint="No description, website, or topics provided."
        />
        <section className="gh-side-block">
          <ul className="gh-side-list">
            {registration ? (
              <li>
                <span className="muted">Owner</span>
                <PersonName
                  fingerprint={registration.identity_fingerprint}
                  link
                />
              </li>
            ) : null}
            <li>
              <span className="muted">Repo key</span>
              <span
                className="mono break"
                title="Per-repo Freenet contract fingerprint (not a user id)"
              >
                {prefix}
              </span>
            </li>
            <li>
              <span className="muted">Remote</span>
              <span className="mono break">{repo.url.remote}</span>
            </li>
            <li>
              <span className="muted">Default branch</span>
              <span className="muted">
                none yet (will be {intendedBranch || "main"})
              </span>
            </li>
          </ul>
        </section>
        <PagesSidebarBlock
          prefix={prefix}
          label={label}
          ownerOpts={ownerOpts}
          isOwner={isOwner}
          registered={registered}
          isRegistryOwner={isRegistryOwner}
        />
      </aside>
    </div>
  );
}

function TreeView({
  prefix,
  label,
  ownerOpts,
  repo,
  aboutText,
  isOwner,
  isRegistryOwner,
  registered,
}: {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
  aboutText: string | null;
  isOwner: boolean;
  isRegistryOwner: boolean;
  registered: boolean;
}) {
  const params = useParams();
  const navigate = useNavigate();
  const branch = params.branch ?? "HEAD";
  const treePath = decodeRepoFilePath(params["*"]);
  const ref = branch;
  const displayName = repoDisplayName(repo.name, label);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [readme, setReadme] = useState<{ path: string; content: string } | null>(
  //   null,
  // );
  const [latest, setLatest] = useState<CommitEntry | null>(null);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [owner, setOwner] = useState<Contributor | null>(null);
  const [registration, setRegistration] = useState<HubRegistration | null>(
    null,
  );
  const [aboutDesc, setAboutDesc] = useState<string | null>(aboutText);
  const [repoContractName, setRepoContractName] = useState<string | null>(null);
  const [tipPackSize, setTipPackSize] = useState<number | null>(null);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [busy, setBusy] = useState(true);
  // NEW CODE - TESTING: per-section loading so UI fills in as each fetch lands
  const [treeBusy, setTreeBusy] = useState(true);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [readmeBusy, setReadmeBusy] = useState(true);
  // NEW CODE - TESTING: community tabs load their own bodies
  const [commitsBusy, setCommitsBusy] = useState(true);
  const [contribBusy, setContribBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const [detectedLicense, setDetectedLicense] = useState<string | null>(null);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [progress, setProgress] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const branches = repo.refs
    .filter((r) => r.name.startsWith("refs/heads/"))
    .map((r) => r.name.replace(/^refs\/heads\//, ""));
  const tags = repo.refs.filter((r) => r.name.startsWith("refs/tags/"));
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Always tip-fetched even when freenet-git create left no refs.
  // NEW CODE - TESTING: empty contract = no tip packs yet
  const isEmpty = Boolean(repo.empty) || repo.refs.length === 0;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Ownership probed here for Pages sidebar; now passed from RepoPage as isOwner.
  // NEW CODE - TESTING: isOwner from parent (nativeListRepos / whoami)

  useEffect(() => {
    if (isEmpty) {
      setTreeBusy(false);
      setCommitsBusy(false);
      setContribBusy(false);
      setError(null);
      setErrorKind(null);
      setEntries([]);
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // setReadme(null);
      setDetectedLicense(null);
      setLatest(null);
      setCommitCount(0);
      setContributors([]);
      setOwner(null);
      setTipPackSize(null);
      return;
    }
    let cancelled = false;
    setTreeBusy(true);
    setCommitsBusy(!treePath);
    setContribBusy(!treePath);
    setError(null);
    setErrorKind(null);
    setEntries([]);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // setReadme(null);
    setDetectedLicense(null);
    setLatest(null);
    setCommitCount(null);
    setContributors([]);
    setOwner(null);
    setRepoContractName(null);
    setTipPackSize(null);

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // void Promise.all([tree, readme, commits, contributors]).finally(setBusy)
    // blocked main+sidebar until the slowest finished.
    // NEW CODE - TESTING: each section resolves independently;
    // community tabs discover/load README + CoC + … themselves.

    void api
      .tree(prefix, label, ref, treePath)
      .then((tree) => {
        if (cancelled) return;
        setEntries(
          [...tree.entries].sort((a, b) => {
            if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
        );
        setTipPackSize(tree.tipPackSize ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const described = describeBrowseError(err);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // setError(described.message); setErrorKind(described.kind);
        // NEW CODE - TESTING: GitHub redirects /tree/…/file → /blob/…/file
        // (tree walk treats the filename as a directory → "path not found").
        if (treePath && /path not found/i.test(described.message)) {
          void api
            .blob(prefix, label, ref, treePath)
            .then(() => {
              if (cancelled) return;
              navigate(
                repoBlobHref(prefix, label, ref, treePath, ownerOpts),
                { replace: true },
              );
            })
            .catch(() => {
              if (!cancelled) {
                setError(described.message);
                setErrorKind(described.kind);
              }
            });
          return;
        }
        setError(described.message);
        setErrorKind(described.kind);
      })
      .finally(() => {
        if (!cancelled) setTreeBusy(false);
      });

    if (treePath) {
      setCommitsBusy(false);
      setContribBusy(false);
    } else {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // void api.readme(...).then(setReadme)
      // NEW CODE - TESTING: CommunityFilesPanel loads community markdown

      void api
        .commits(prefix, label, ref)
        .then((commitsRes) => {
          if (cancelled) return;
          setLatest(commitsRes.commits[0] ?? null);
          setCommitCount(commitsRes.commits.length || null);
        })
        .catch(() => {
          if (!cancelled) {
            setLatest(null);
            setCommitCount(null);
          }
        })
        .finally(() => {
          if (!cancelled) setCommitsBusy(false);
        });

      void api
        .contributors(prefix, label, ref)
        .then((contribRes) => {
          if (cancelled || !contribRes) return;
          setContributors(contribRes.contributors);
          setOwner(contribRes.owner);
          setRepoContractName(contribRes.repoName);
        })
        .catch(() => {
          if (!cancelled) {
            setContributors([]);
            setOwner(null);
            setRepoContractName(null);
          }
        })
        .finally(() => {
          if (!cancelled) setContribBusy(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [prefix, label, ref, treePath, retryToken, isEmpty]);

  // NEW CODE - TESTING: after tip push, refetch tree without hard remount
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
      if (cancelled) return;
      unsub = onRepoTipPushed((p) => {
        if (p === prefix) setRetryToken((n) => n + 1);
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [prefix]);

  useEffect(() => {
    setAboutDesc(aboutText);
  }, [aboutText]);

  useEffect(() => {
    if (treePath) return;
    let cancelled = false;
    void api
      .registryLookup(prefix)
      .then((reg) => {
        if (!cancelled) setRegistration(reg);
      })
      .catch(() => {
        if (!cancelled) setRegistration(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, treePath, retryToken]);

  const crumbs = treePath ? treePath.split("/") : [];
  const tagNames = tags.map((t) => t.name.replace(/^refs\/tags\//, ""));
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const latestTag = pickLatestTag(tagNames);
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of contributors) {
      const k = c.name.trim().toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    );
  }, [contributors]);

  const fileTableBody = (
    <table className="file-table">
      <tbody>
        {treePath ? (
          <tr>
            <td colSpan={3}>
              <Link
                className="gh-file-link"
                to={
                  crumbs.length <= 1
                    ? repoTreeHref(prefix, label, ref, "", ownerOpts)
                    : repoTreeHref(
                        prefix,
                        label,
                        ref,
                        crumbs.slice(0, -1).join("/"),
                        ownerOpts,
                      )
                }
              >
                <span className="gh-file-icon muted">..</span>
                <span>..</span>
              </Link>
            </td>
          </tr>
        ) : null}
        {entries.map((entry) => {
          const next = treePath ? `${treePath}/${entry.name}` : entry.name;
          const href =
            entry.type === "tree"
              ? repoTreeHref(prefix, label, ref, next, ownerOpts)
              : repoBlobHref(prefix, label, ref, next, ownerOpts);
          return (
            <tr key={`${entry.type}-${entry.name}`}>
              <td className="gh-file-name-cell">
                <Link to={href} className="gh-file-link">
                  <span
                    className={`gh-file-icon ${
                      entry.type === "tree" ? "dir" : "file"
                    }`}
                  >
                    {entry.type === "tree" ? <FolderIcon /> : <FileIcon />}
                  </span>
                  <span>{entry.name}</span>
                </Link>
              </td>
              <td className="gh-file-msg">
                <span className="gh-file-msg-inner">
                  {collapseCommitSubject(entry.lastCommitSubject)}
                </span>
              </td>
              <td className="gh-file-time">
                {entry.lastCommitDate
                  ? relativeTime(entry.lastCommitDate)
                  : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Nested folders used the root Code layout (repo header, About sidebar,
  // no Files sidepanel) — chrome jumped when opening a file.
  // NEW CODE - TESTING: nested tree = same workspace as blob (sidepanel + panel)
  if (treePath) {
    return (
      <div className="gh-blob-layout">
        <FileTreeSidepanel
          prefix={prefix}
          label={label}
          branch={ref}
          currentPath={treePath}
          branches={branches}
          ownerOpts={ownerOpts}
          branchNav={(b) =>
            repoTreeHref(prefix, label, b, treePath, ownerOpts)
          }
        />
        <section className="gh-blob-panel">
          <div className="breadcrumbs gh-blob-breadcrumbs">
            <Link to={repoTreeHref(prefix, label, ref, "", ownerOpts)}>
              {displayName}
            </Link>
            {crumbs.map((part, idx) => {
              const sub = crumbs.slice(0, idx + 1).join("/");
              const isLast = idx === crumbs.length - 1;
              return (
                <span key={sub}>
                  <span className="sep">/</span>
                  {isLast ? (
                    <strong>{part}</strong>
                  ) : (
                    <Link to={repoTreeHref(prefix, label, ref, sub, ownerOpts)}>
                      {part}
                    </Link>
                  )}
                </span>
              );
            })}
          </div>
          {treeBusy && !isEmpty ? (
            <PageLoadingOverlay
              skeleton="tree"
              message={
                <>
                  {FREENET_FETCHING_CONTRACT}
                  <span
                    className="muted tiny block"
                    style={{ marginTop: "0.35rem" }}
                  >
                    {FREENET_FETCHING_CONTRACT_HINT}
                  </span>
                </>
              }
            />
          ) : null}
          {error ? (
            <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
              {error}
              {errorKind === "chunked" ||
              errorKind === "generic" ||
              errorKind === "missing" ||
              errorKind === "timeout" ? (
                <div style={{ marginTop: "0.75rem" }}>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setRetryToken((n) => n + 1)}
                  >
                    Retry tip fetch
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {!treeBusy && !error && !isEmpty ? (
            <div className="gh-file-box">{fileTableBody}</div>
          ) : null}
          {!treeBusy && entries.length === 0 && !error && !isEmpty ? (
            <p className="muted">Empty tree on {ref}.</p>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="gh-repo-layout">
      <div className="gh-repo-main">
        {/* NEW CODE - TESTING: tip-pack ahead/behind notice (no PR until Phase 2) */}
        {!isEmpty && !treePath ? (
          <BranchDivergenceBanner
            prefix={prefix}
            label={label}
            currentRef={ref}
            defaultBranch={refFromBranch(repo.defaultBranch)}
            ownerOpts={ownerOpts}
          />
        ) : null}
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        Always showed branch / Branches / Tags / Code toolbar (even when empty).
        */}
        {/* NEW CODE - TESTING: hide code toolbar until refs exist */}
        {!isEmpty ? (
          <div className="gh-toolbar">
            <BranchSelect
              branches={branches}
              value={branches.includes(ref) ? ref : branches[0] ?? ref}
              onChange={(b) => {
                void navigate(repoTreeHref(prefix, label, b, "", ownerOpts));
              }}
            />
            <Link
              className="gh-toolbar-link"
              to={repoHref(prefix, label, "branches", ownerOpts)}
            >
              <BranchIcon />
              <span>
                {branches.length} Branch{branches.length === 1 ? "" : "es"}
              </span>
            </Link>
            <Link
              className="gh-toolbar-link"
              to={repoHref(prefix, label, "tags", ownerOpts)}
            >
              <TagIcon />
              <span>
                {tags.length} Tag{tags.length === 1 ? "" : "s"}
              </span>
            </Link>
            <GoToFileSearch
              prefix={prefix}
              label={label}
              refName={ref}
              ownerOpts={ownerOpts}
            />
            <AddFileMenu
              prefix={prefix}
              label={label}
              branch={ref}
              ownerOpts={ownerOpts}
              isOwner={isOwner}
            />
            <CodeCloneMenu
              prefix={prefix}
              label={label}
              refName={ref}
            />
          </div>
        ) : null}

        {isEmpty ? (
          <EmptyRepoPanel
            prefix={prefix}
            label={label}
            remote={repo.remote}
            defaultBranch={refFromBranch(repo.defaultBranch)}
            isOwner={isOwner}
            ownerOpts={ownerOpts}
            displayName={displayName}
          />
        ) : null}

        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        {treePath ? ( <div className="breadcrumbs">…</div> ) : null}
        Nested breadcrumbs live in the blob-layout branch above.
        */}

        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        {busy ? ( <> tree+readme skeletons </> ) : null}
        */}
        {/* NEW CODE - TESTING: per-section skeletons + Freenet fetch copy */}
        {treeBusy && !isEmpty ? (
          <PageLoadingOverlay
            skeleton="tree"
            message={
              <>
                {FREENET_FETCHING_CONTRACT}
                <span
                  className="muted tiny block"
                  style={{ marginTop: "0.35rem" }}
                >
                  {FREENET_FETCHING_CONTRACT_HINT}
                </span>
              </>
            }
          />
        ) : null}
        {error ? (
          <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
            {error}
            {errorKind === "chunked" ||
            errorKind === "generic" ||
            errorKind === "missing" ||
            errorKind === "timeout" ? (
              <div style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setRetryToken((n) => n + 1)}
                >
                  Retry tip fetch
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!treeBusy && !error && !isEmpty ? (
          <div className="gh-file-box">
            {commitsBusy ? (
              <div
                className="gh-commit-strip skel-commit-strip"
                aria-busy="true"
              >
                <div className="gh-commit-main">
                  <span
                    className="skel-bone skel-bone--sm"
                    style={{ width: "5.5rem" }}
                  />
                  <span
                    className="skel-bone skel-bone--md"
                    style={{ width: "14rem" }}
                  />
                </div>
                <div className="gh-commit-meta">
                  <span
                    className="skel-bone skel-bone--sm"
                    style={{ width: "4rem" }}
                  />
                  <span
                    className="skel-bone skel-bone--sm"
                    style={{ width: "5rem" }}
                  />
                </div>
              </div>
            ) : latest ? (
              <div className="gh-commit-strip">
                <div className="gh-commit-main">
                  <strong className="gh-commit-author">{latest.author}</strong>
                  <span className="gh-commit-msg">{latest.subject}</span>
                </div>
                <div className="gh-commit-meta">
                  <span className="mono">{latest.short}</span>
                  <span className="muted">{relativeTime(latest.date)}</span>
                  <Link
                    className="gh-commits-count"
                    to={`${repoHref(prefix, label, "", ownerOpts)}/commits/${encodeURIComponent(ref)}`}
                  >
                    {commitCount ?? "…"} Commits
                  </Link>
                </div>
              </div>
            ) : null}

            {fileTableBody}
          </div>
        ) : null}

        {!treeBusy && entries.length === 0 && !error && !isEmpty ? (
          <p className="muted">Empty tree on {ref}.</p>
        ) : null}

        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        {readmeBusy && !treePath && !isEmpty ? (
          <PageLoadingOverlay skeleton="readme" message="" />
        ) : null}
        {readme && !treePath ? (
          <ReadmePanel
            className="readme gh-readme"
            path={readme.path}
            content={readme.content}
            blobHref={repoBlobHref(prefix, label, ref, readme.path, ownerOpts)}
          />
        ) : null}
        */}
        {/* NEW CODE - TESTING: dynamic community tabs (README / CoC / … / License) */}
        {!isEmpty ? (
          <CommunityFilesPanel
            prefix={prefix}
            label={label}
            gitRef={ref}
            ownerOpts={ownerOpts}
            rootNames={entries.map((e) => e.name)}
            onLicenseDetected={setDetectedLicense}
            canEdit={isOwner && registered}
          />
        ) : null}
      </div>

      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
      {!treePath ? (busy ? <PageLoadingOverlay skeleton="sidebar" /> : <aside>…)}
      */}
      {/* NEW CODE - TESTING: sidebar paints immediately; sections fill in */}
      {!treePath ? (
        <aside className="gh-sidebar">
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <section className="gh-side-block">
            <h3>About</h3>
            <p>{aboutText ?? "Freenet-hosted git repository."}</p>
            …
          </section>
          */}
          {/* NEW CODE - TESTING */}
          <RepoAboutBlock
            prefix={prefix}
            label={label}
            name={repo.name}
            description={aboutDesc}
            registration={registration}
            canEdit={isRegistryOwner && registered}
            onDescriptionSaved={setAboutDesc}
            onRegistrationSaved={setRegistration}
            emptyHint="No description, website, or topics provided."
          />
          <section className="gh-side-block">
            <ul className="gh-side-list">
              {repoContractName && repoContractName !== displayName ? (
                <li>
                  <span className="muted">Contract name</span>
                  <span>{repoContractName}</span>
                </li>
              ) : null}
              {registration ? (
                <li>
                  <span className="muted">Owner</span>
                  <PersonName
                    fingerprint={registration.identity_fingerprint}
                    link
                  />
                </li>
              ) : owner ? (
                <li>
                  <span className="muted">Top author</span>
                  <span>{owner.name}</span>
                </li>
              ) : contribBusy && !isEmpty ? (
                <li>
                  <span className="muted">Top author</span>
                  <span
                    className="skel-bone skel-bone--sm"
                    style={{ width: "6rem" }}
                    aria-busy="true"
                  />
                </li>
              ) : null}
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              {registration ? (
                <li>
                  <span className="muted">Owner</span>
                  <PersonName … />
                </li>
              ) : owner ? (
                <li>
                  <span className="muted">Top author</span>
                  <span>{owner.name}</span>
                </li>
              ) : null}
              */}
              <li>
                <span className="muted">Repo key</span>
                <span
                  className="mono break"
                  title="Per-repo Freenet contract fingerprint (not a user id)"
                >
                  {prefix}
                </span>
              </li>
              <li>
                <span className="muted">Remote</span>
                <span className="mono break">{repo.url.remote}</span>
              </li>
              <li>
                <span className="muted">Default branch</span>
                <span>{refFromBranch(repo.defaultBranch)}</span>
              </li>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              {tipPackSize != null ? (
                <li>
                  <span className="muted">Tip packs cached</span>
                  <span>{formatBytes(tipPackSize)}</span>
                </li>
              ) : treeBusy && !isEmpty ? (
                <li>
                  <span className="muted">Tip packs cached</span>
                  <span
                    className="skel-bone skel-bone--sm"
                    style={{ width: "4rem" }}
                  />
                </li>
              ) : null}
              */}
              {/* NEW CODE - TESTING: tip size lives in Pack health below */}
              {detectedLicense ? (
                <li>
                  <span className="muted">License</span>
                  <span>{detectedLicense}</span>
                </li>
              ) : null}
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              {readme ? (
                <li>
                  <Link to={repoBlobHref(prefix, label, ref, readme.path, ownerOpts)}>
                    {readme.path}
                  </Link>
                </li>
              ) : null}
              */}
            </ul>
          </section>
          {!isEmpty ? (
            <RepoHealthBlock
              prefix={prefix}
              tipPackSize={tipPackSize}
              tipLoadDone={!treeBusy}
              registered={registered}
            />
          ) : null}
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <section className="gh-side-block">
            <h3>Releases</h3>
            ...tags dressed as GitHub releases...
          </section>
          */}
          {/* NEW CODE - TESTING: git tags only (real git); no fake Releases */}
          <section className="gh-side-block">
            <h3>Tags</h3>
            {tagNames.length > 0 ? (
              <p className="muted tiny">
                <Link to={repoHref(prefix, label, "tags", ownerOpts)}>
                  {tagNames.length} tag{tagNames.length === 1 ? "" : "s"}
                </Link>
              </p>
            ) : (
              <p className="muted tiny">No tags yet</p>
            )}
          </section>
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          {!treePath ? (
            <LanguagesSidebarBlock
              prefix={prefix}
              label={label}
              gitRef={ref}
              enabled={!isEmpty && !busy}
            />
          ) : null}
          */}
          {/* NEW CODE - TESTING: Languages under Contributors; start without waiting on tree */}
          <PagesSidebarBlock
            prefix={prefix}
            label={label}
            ownerOpts={ownerOpts}
            isOwner={isOwner}
            registered={registered}
            isRegistryOwner={isRegistryOwner}
          />
          {contribBusy && !isEmpty ? (
            <section
              className="gh-side-block skel-side-block"
              aria-busy="true"
              aria-label="Loading contributors"
            >
              <span
                className="skel-bone skel-bone--md"
                style={{ width: "7rem" }}
              />
              <div className="skel-side-block__body">
                <span
                  className="skel-bone skel-bone--line"
                  style={{ width: "100%" }}
                />
                <span
                  className="skel-bone skel-bone--line"
                  style={{ width: "80%" }}
                />
              </div>
            </section>
          ) : contributors.length > 0 ? (
            <section className="gh-side-block">
              <h3>
                Contributors{" "}
                <span className="muted">({contributors.length})</span>
              </h3>
              <ul className="gh-contributors">
                {contributors.slice(0, 12).map((c) => {
                  const shown = contributorLabel(c, duplicateNames);
                  return (
                    <li key={c.slug}>
                      <span>
                        {shown.name}
                        {shown.postfix ? (
                          <span className="gh-contrib-postfix">
                            {" "}
                            · {shown.postfix}
                          </span>
                        ) : null}
                      </span>
                      <span className="muted tiny">{c.commits}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {!isEmpty ? (
            <LanguagesSidebarBlock
              prefix={prefix}
              label={label}
              gitRef={ref}
              enabled
            />
          ) : null}
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          {!treePath ? ( <PagesSidebarBlock … /> ) : null}
          {contributors.length > 0 ? ( … ) : null}
          {!treePath ? (
            <LanguagesSidebarBlock enabled={!isEmpty && !busy} />
          ) : null}
          */}
          <section className="gh-side-block">
            <h3>Branches</h3>
            <p className="muted tiny">
              {branches.length} branch{branches.length === 1 ? "" : "es"}
              {" · "}
              {tags.length} tag{tags.length === 1 ? "" : "s"} from Freenet refs
            </p>
            <ul className="gh-side-branches">
              {branches.slice(0, 8).map((b) => (
                <li key={b}>
                  <Link
                    to={`${repoHref(prefix, label, "", ownerOpts)}/tree/${encodeURIComponent(b)}`}
                  >
                    {b}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="gh-side-block">
            <h3>Browse mode</h3>
            <p className="muted tiny">
              Tip-pack browse — GitAtlas loads tipped packs only (not a full
              history clone). Issues / PRs / Actions are not on Freenet yet.
            </p>
          </section>
        </aside>
      ) : null}
    </div>
  );
}

function RawView({
  prefix,
  label,
  ownerOpts: _ownerOpts,
  repo: _repo,
}: {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
}) {
  const params = useParams();
  const branch = params.branch ?? "HEAD";
  const filePath = decodeRepoFilePath(params["*"]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const served = useRef(false);

  useEffect(() => {
    let cancelled = false;
    served.current = false;
    setBusy(true);
    setError(null);
    void api
      .blob(prefix, label, branch, filePath)
      .then((res) => {
        if (cancelled || served.current) return;
        if (res.tooLarge && !res.contentBase64 && !res.content) {
          setError("File too large for raw serve in the browser.");
          setBusy(false);
          return;
        }
        const ok = serveRawFileInCurrentDocument({
          text: res.content,
          contentBase64: res.contentBase64,
          mediaType: res.mediaType,
          filename: filePath.split("/").pop() || "raw",
        });
        if (ok) {
          served.current = true;
          return;
        }
        setError("Could not open raw file in this Freenet sandbox.");
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeBrowseError(err).message);
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, branch, filePath]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // SPA chrome + <pre> preview (not a real raw Content-Type response).
  // NEW CODE - TESTING: replace document with Blob / minimal raw page.
  return (
    <div className="gh-raw-page gh-raw-page--serving">
      {busy ? (
        <PageLoadingOverlay
          skeleton="blob"
          message="Loading raw file from Freenet tip pack…"
        />
      ) : null}
      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function BlobView({
  prefix,
  label,
  ownerOpts,
  repo,
  isOwner,
}: {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
  isOwner: boolean;
}) {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const wantEdit = searchParams.get("edit") === "1";
  const branch = params.branch ?? "HEAD";
  const filePath = decodeRepoFilePath(params["*"]);
  const displayName = repoDisplayName(repo.name, label);
  const [file, setFile] = useState<BlobResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [pathCopied, setPathCopied] = useState(false);

  const branches = repo.refs
    .filter((r) => r.name.startsWith("refs/heads/"))
    .map((r) => r.name.replace(/^refs\/heads\//, ""));

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setErrorKind(null);
    setFile(null);
    void api
      .blob(prefix, label, branch, filePath)
      .then((res) => {
        if (!cancelled) setFile(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const described = describeBrowseError(err);
          setError(described.message);
          setErrorKind(described.kind);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, branch, filePath, retryToken]);

  // NEW CODE - TESTING: after tip push, refetch blob without hard remount
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/tip-cache-lifecycle").then(({ onRepoTipPushed }) => {
      if (cancelled) return;
      unsub = onRepoTipPushed((p) => {
        if (p === prefix) setRetryToken((n) => n + 1);
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [prefix]);

  const rawHref = repoRawHref(prefix, label, branch, filePath, ownerOpts);
  const imageSrc =
    file?.contentBase64 && file.mediaType.startsWith("image/")
      ? `data:${file.mediaType};base64,${file.contentBase64}`
      : null;
  const markdown =
    Boolean(file?.content) && !file?.tooLarge && isMarkdownPath(filePath);

  const copyPath = () => {
    void navigator.clipboard.writeText(filePath).then(
      () => {
        setPathCopied(true);
        window.setTimeout(() => setPathCopied(false), 1600);
      },
      () => {},
    );
  };

  const downloadBinary = () => {
    if (!file?.contentBase64) return;
    const bin = Uint8Array.from(atob(file.contentBase64), (c) =>
      c.charCodeAt(0),
    );
    const blob = new Blob([bin], { type: file.mediaType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filePath.split("/").pop() || "file";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  };

  return (
    <div className="gh-blob-layout">
      <FileTreeSidepanel
        prefix={prefix}
        label={label}
        branch={branch}
        currentPath={filePath}
        branches={branches}
        ownerOpts={ownerOpts}
      />
      <section className="gh-blob-panel">
        <div className="breadcrumbs gh-blob-breadcrumbs">
          <Link to={repoTreeHref(prefix, label, branch, "", ownerOpts)}>
            {displayName}
          </Link>
          {filePath.split("/").filter(Boolean).map((part, idx, all) => {
            const sub = all.slice(0, idx + 1).join("/");
            const isLast = idx === all.length - 1;
            return (
              <span key={sub}>
                <span className="sep">/</span>
                {isLast ? (
                  <strong>{part}</strong>
                ) : (
                  <Link to={repoTreeHref(prefix, label, branch, sub, ownerOpts)}>
                    {part}
                  </Link>
                )}
              </span>
            );
          })}
          <button
            type="button"
            className="gh-icon-btn"
            onClick={copyPath}
            title={pathCopied ? "Copied!" : "Copy path"}
            aria-label={pathCopied ? "Copied path" : "Copy path"}
          >
            {pathCopied ? "✓" : "⧉"}
          </button>
        </div>
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <div className="blob-actions">
          <Link className="btn secondary" to={…}>Back to tree</Link>
          <a className="btn secondary" href={rawHref}>View raw</a>
        </div>
        */}
        {busy ? (
          <PageLoadingOverlay
            skeleton="blob"
            message={
              <>
                {FREENET_FETCHING_CONTRACT}
                <span
                  className="muted tiny block"
                  style={{ marginTop: "0.35rem" }}
                >
                  Loading file from tip pack…
                </span>
              </>
            }
          />
        ) : null}
        {error ? (
          <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
            {error}
            {errorKind === "chunked" ||
            errorKind === "generic" ||
            errorKind === "missing" ||
            errorKind === "timeout" ? (
              <div style={{ marginTop: "0.75rem" }}>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setRetryToken((n) => n + 1)}
                >
                  Retry tip fetch
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {file && markdown ? (
          <FileContentPanel
            key={filePath}
            className="file-view md-as-file"
            path={filePath}
            content={file.content}
            prefix={prefix}
            label={label}
            displayName={displayName}
            branch={branch}
            allowPreview
            defaultMode="preview"
            mediaType={file.mediaType}
            isOwner={isOwner}
            initialEditing={wantEdit}
            rawHref={rawHref}
            meta={`${file.content.split(/\r\n|\r|\n/).length} lines · ${formatBytes(file.size)}`}
          />
        ) : null}
        {file && !markdown && file.content && !imageSrc && !file.tooLarge ? (
          <FileContentPanel
            key={filePath}
            className="file-view md-as-file"
            path={filePath}
            content={file.content}
            prefix={prefix}
            label={label}
            displayName={displayName}
            branch={branch}
            allowPreview={false}
            defaultMode="code"
            mediaType={file.mediaType}
            isOwner={isOwner}
            initialEditing={wantEdit}
            rawHref={rawHref}
            meta={`${file.content.split(/\r\n|\r|\n/).length} lines · ${formatBytes(file.size)}`}
          />
        ) : null}
        {file && !markdown && (imageSrc || file.tooLarge || !file.content) ? (
          <div className="file-view">
            <div className="md-panel-header gh-file-toolbar">
              <div className="gh-file-toolbar-left">
                <span className="muted tiny gh-file-stats">
                  {file.mediaType} · {formatBytes(file.size)}
                  {file.tooLarge ? " · too large for inline preview" : ""}
                </span>
              </div>
              <div className="gh-file-toolbar-actions">
                {file.contentBase64 ? (
                  <button
                    type="button"
                    className="gh-file-action-btn"
                    onClick={downloadBinary}
                  >
                    Download
                  </button>
                ) : (
                  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
                  // href={freenetNodeRawFileHref(...)} — needs non-stock freenet git-raw
                  // NEW CODE - TESTING: GitAtlas /?raw=… (any stock node)
                  <a
                    className="gh-file-action-btn"
                    href={freenetRawFileHref(rawHref)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Raw
                  </a>
                )}
              </div>
            </div>
            {imageSrc && !file.tooLarge ? (
              <img className="blob-image" src={imageSrc} alt={filePath} />
            ) : null}
            {(file.tooLarge || (!file.content && !imageSrc)) && !busy ? (
              <p className="muted" style={{ padding: "1rem" }}>
                Preview unavailable. Use <strong>Download</strong> or{" "}
                <strong>Raw</strong> for the blob bytes.
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function CommitsView({
  prefix,
  label,
  ownerOpts: _ownerOpts,
  repo,
}: {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
}) {
  const { branch } = useParams();
  const ref = branch ?? refFromBranch(repo.defaultBranch);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api
      .commits(prefix, label, ref)
      .then((res) => {
        if (!cancelled) {
          setCommits(res.commits);
          setNote(res.note ?? null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeBrowseError(err).message);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prefix, label, ref]);

  return (
    <section className="gh-blob-panel">
      {busy ? (
        <PageLoadingOverlay
          skeleton="commits"
          message="Loading commits from Freenet tip pack…"
        />
      ) : null}
      {note ? <p className="muted tiny">{note}</p> : null}
      {error ? (
        <div className="error-banner" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
      <ul className="commit-list">
        {commits.map((c) => (
          <li key={c.hash}>
            <span className="hash">{c.short}</span>
            <div>
              <strong>{c.subject}</strong>
              <div className="muted">
                {c.author} · {relativeTime(c.date)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function tagEntries(
  repo: RepoPageData,
): Array<{ name: string; hash: string }> {
  return repo.refs
    .filter((r) => r.name.startsWith("refs/tags/"))
    .map((r) => ({
      name: r.name.replace(/^refs\/tags\//, ""),
      hash: r.hash,
    }));
}

function TagsView({
  prefix,
  label,
  ownerOpts,
  repo,
}: {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
}): ReactElement {
  const tags = [...tagEntries(repo)].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <section className="gh-blob-panel">
      <h2>Tags</h2>
      {tags.length === 0 ? (
        <p className="muted">No tags in this repository.</p>
      ) : (
        <ul className="gh-tag-list">
          {tags.map((t) => (
            <li key={t.name}>
              <Link
                to={`${repoHref(prefix, label, "", ownerOpts)}/tree/${encodeURIComponent(t.name)}`}
              >
                {t.name}
              </Link>
              <span className="mono muted">{t.hash.slice(0, 7)}</span>
              <Link
                className="muted tiny"
                to={`${repoHref(prefix, label, "", ownerOpts)}/tree/${encodeURIComponent(t.name)}`}
              >
                Browse files
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// function ReleasesView(...) { ... tags presented as GitHub Releases ... }
// function ReleaseDetailView(...) { ... }
// Removed: GitAtlas should not fake Releases from git tags. See
// docs/12-future-releases-actions.md. No /releases routes (404).

