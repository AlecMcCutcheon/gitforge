import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type ForgePagesConfig, type RepoPageData } from "../api";
import { isBrowserNativeMode } from "../tip-browse";
import { invalidateRegistryCache, removeCachedRegistryEntry } from "../freenet/discover-cache";
import { clearRepoTipCaches } from "../freenet/native-api";
import {
  contributorFingerprintsForPrefix,
  isPendingInviteExpired,
  pendingInvitesForPrefix,
  searchPersonForInvite,
  sendRepoInvite,
  type PersonSearchHit,
} from "../freenet/repo-invite";
import { fetchForgeProfile } from "../freenet/forge-profile";
import {
  fetchForgeRegistry,
  type ForgeRegistryPendingInviteOp,
} from "../freenet/forge-registry";
import { fingerprintWordsJoined } from "../freenet/fingerprint-words";
import {
  getCachedIdentity,
  leaveRepositoryAsContributor,
} from "../freenet/auth-api";
import { nativeCancelPendingInvite } from "../freenet/owner-api";
import type { RepoHrefOpts } from "../lib/repo-path";
import { repoHref } from "../lib/repo-path";
import { brand, registryLabel } from "../lib/brand";
import { repoDisplayName, slugRepoLabel } from "../lib/repo-display";
import { CantEditRepoPanel } from "../components/CantEditRepoPanel";
import { FlashNotice } from "../components/FlashNotice";
import { LocalProtectPanel } from "../components/LocalProtectPanel";
import { BusyLabel, OperationStatus } from "../components/OperationStatus";
import { ProfileAvatar } from "../components/ProfileAvatar";

function GearIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0a8.2 8.2 0 0 1 .691.031C9.444.198 10 1.048 10 1.998V3a2 2 0 0 0 2 2h1.002c.95 0 1.8.556 1.967 1.309a8.2 8.2 0 0 1 0 1.382C15.802 8.444 14.952 9 14.002 9H12a2 2 0 0 0-2 2v1.002c0 .95-.556 1.8-1.309 1.967a8.2 8.2 0 0 1-1.382 0C6.556 13.802 6 12.952 6 12.002V11a2 2 0 0 0-2-2H2.998c-.95 0-1.8-.556-1.967-1.309a8.2 8.2 0 0 1 0-1.382C1.198 5.556 2.048 5 2.998 5H4a2 2 0 0 0 2-2V1.998c0-.95.556-1.8 1.309-1.967A8.2 8.2 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0ZM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.375 2.5 2.5 0 0 0-4.692 0 .75.75 0 0 1-1.434-.438 5.01 5.01 0 0 1 2.56-3.012A3.001 3.001 0 0 1 11 4Z"
      />
    </svg>
  );
}

function RepoBookIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 1.75A.75.75 0 0 1 .75 1h4.253c1.227 0 2.317.59 3 1.501A3.743 3.743 0 0 1 11.006 1h4.245a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75h-4.507a2.25 2.25 0 0 0-1.591.659l-.622.621a.75.75 0 0 1-1.06 0l-.622-.621A2.25 2.25 0 0 0 5.258 13H.75a.75.75 0 0 1-.75-.75Zm7.251 10.324.004-5.073-.002-2.253A2.25 2.25 0 0 0 5.003 2.5H1.5v9h3.757a3.75 3.75 0 0 1 1.994.574ZM8.755 4.75l-.004 7.322a3.752 3.752 0 0 1 1.991-.572H14.5v-9h-3.254a2.25 2.25 0 0 0-2.491 2.25Z"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.75 1.75 0 0 1 10.595 15H5.405a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"
      />
    </svg>
  );
}

function CollabEmptyIcon() {
  return (
    <svg
      className="gh-collab-empty-illust"
      viewBox="0 0 64 64"
      width="64"
      height="64"
      aria-hidden
    >
      <circle cx="32" cy="18" r="10" fill="none" stroke="#4493f8" strokeWidth="2.5" />
      <path
        d="M16 48c0-8.837 7.163-16 16-16s16 7.163 16 16"
        fill="none"
        stroke="#4493f8"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="18" cy="52" r="4" fill="#4493f8" opacity="0.85" />
      <circle cx="32" cy="56" r="4" fill="#4493f8" opacity="0.85" />
      <circle cx="46" cy="52" r="4" fill="#4493f8" opacity="0.85" />
      <path
        d="M32 40v8M22 48l10 4 10-4"
        fill="none"
        stroke="#4493f8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

function PagesIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM7.25 9a.75.75 0 0 1 0-1.5h.09a1.5 1.5 0 0 0 1.41-1.41V6a.75.75 0 0 1 1.5 0v.09a3 3 0 0 1-2.82 2.82H7.25ZM4 6.75A.75.75 0 0 1 4.75 6h.09a1.5 1.5 0 0 0 1.41-1.41V4.5a.75.75 0 0 1 1.5 0v.09a3 3 0 0 1-2.82 2.82H4.75A.75.75 0 0 1 4 6.75ZM9 13.25a.75.75 0 0 1-.75-.75v-.09a1.5 1.5 0 0 0-1.41-1.41H6.75a.75.75 0 0 1 0-1.5h.09a3 3 0 0 1 2.82 2.82v.09c0 .414-.336.75-.75.75Z"
      />
    </svg>
  );
}

type SettingsTab = "general" | "collaborators" | "pages";

interface RepoSettingsViewProps {
  prefix: string;
  label: string;
  ownerOpts: RepoHrefOpts;
  repo: RepoPageData;
  isOwner: boolean;
  /** Listed on GitForge registry (required for Settings). */
  registered: boolean;
  /** Session identity matches ForgeRegistry identity_fingerprint. */
  isRegistryOwner: boolean;
}

/**
 * Owner-gated repo settings — GitHub-style sidebar.
 * General: rename + Danger Zone (delete = registry owner only).
 * Collaborators: seal site-key invites (registry owner + registered only).
 * Pages: enable/sync/disable for key holders.
 */
export function RepoSettingsView({
  prefix,
  label,
  ownerOpts,
  repo,
  isOwner,
  registered,
  isRegistryOwner: isRegistryOwnerProp,
}: RepoSettingsViewProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const websiteMode = isBrowserNativeMode();
  const displayName = repoDisplayName(repo.name, label);
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [tab, setTab] = useState<SettingsTab>("general");
  // NEW CODE - TESTING: ?tab=pages from sidebar deep-link
  const tabFromUrl = ((): SettingsTab => {
    const t = searchParams.get("tab");
    if (t === "pages" || t === "collaborators" || t === "general") return t;
    return "general";
  })();
  const [tab, setTab] = useState<SettingsTab>(tabFromUrl);

  useEffect(() => {
    setTab(tabFromUrl);
  }, [tabFromUrl]);

  const selectTab = (next: SettingsTab) => {
    setTab(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next === "general") nextParams.delete("tab");
    else nextParams.set("tab", next);
    setSearchParams(nextParams, { replace: true });
  };

  const [renameValue, setRenameValue] = useState(displayName);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameOk, setRenameOk] = useState<string | null>(null);

  const [confirmName, setConfirmName] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // NEW CODE - TESTING: unregister-only (registry clear, keep tip + local key)
  const [showUnregisterConfirm, setShowUnregisterConfirm] = useState(false);
  const [unregisterConfirmName, setUnregisterConfirmName] = useState("");
  const [unregisterBusy, setUnregisterBusy] = useState(false);
  const [unregisterError, setUnregisterError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alreadyDeleted = Boolean(repo.softDelete?.deleted);
  const nameOk = confirmName.trim() === displayName;
  const unregisterNameOk = unregisterConfirmName.trim() === displayName;
  const renameChanged =
    renameValue.trim() !== displayName && renameValue.trim().length > 0;
  const previewLabel = slugRepoLabel(renameValue);

  const defaultBranch =
    repo.defaultBranch?.replace(/^refs\/heads\//, "") || "main";

  const [pages, setPages] = useState<ForgePagesConfig | null>(null);
  const [pagesBranch, setPagesBranch] = useState(defaultBranch);
  const [pagesRoot, setPagesRoot] = useState("");
  const [pagesBusy, setPagesBusy] = useState(false);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pagesError, setPagesError] = useState<string | null>(null);

  // NEW CODE - TESTING: join module-level ensure (same job as RepoBackupWorker).
  // Does not abort on navigate — only drops UI wait state.
  const [provisioning, setProvisioning] = useState(false);
  const [provisionedOk, setProvisionedOk] = useState(registered);
  // NEW CODE - TESTING: may flip true after auto-register before parent re-renders
  const [localRegistryOwner, setLocalRegistryOwner] = useState(
    isRegistryOwnerProp,
  );
  const isRegistryOwner = localRegistryOwner;
  useEffect(() => {
    setProvisionedOk(registered);
  }, [registered]);
  useEffect(() => {
    setLocalRegistryOwner(isRegistryOwnerProp);
  }, [isRegistryOwnerProp]);
  useEffect(() => {
    if (!websiteMode || !prefix || !isOwner) return;
    let cancelled = false;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Always setProvisioning(true) — blocked Settings UI while ForgeRepoMeta Put
    // hung/timed out even when already registered.
    // NEW CODE - TESTING: registered → background ensure only; unregistered waits
    if (registered) {
      setProvisionedOk(true);
      void import("../freenet/forge-repo")
        .then(({ ensureOwnerRepoSideContracts }) =>
          ensureOwnerRepoSideContracts({
            prefix,
            label,
            name: repo.name ?? null,
            description: repo.description ?? null,
          }),
        )
        .catch((e) => {
          console.warn(
            "[settings] ensure owner contracts:",
            e instanceof Error ? e.message : e,
          );
        });
      return;
    }
    setProvisioning(true);
    void import("../freenet/forge-repo")
      .then(({ ensureOwnerRepoSideContracts }) =>
        ensureOwnerRepoSideContracts({
          prefix,
          label,
          name: repo.name ?? null,
          description: repo.description ?? null,
        }),
      )
      .then(async (result) => {
        if (cancelled) return;
        if (result.registration) {
          setProvisionedOk(true);
          const fp = result.registration.identity_fingerprint;
          const session =
            (await import("../freenet/auth-api")).getCachedIdentity()
              ?.fingerprint ?? null;
          if (fp && session && fp === session) {
            setLocalRegistryOwner(true);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn(
            "[settings] ensure owner contracts:",
            e instanceof Error ? e.message : e,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setProvisioning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    websiteMode,
    prefix,
    label,
    isOwner,
    registered,
    repo.name,
    repo.description,
  ]);

  // Collaborators invite (site-key seal → profile inbox)
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [addPeopleQuery, setAddPeopleQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchHit, setSearchHit] = useState<PersonSearchHit | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStep, setInviteStep] = useState<string | null>(null);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // NEW CODE - TESTING: verified contributors from ForgeRegistry
  const [ownerFingerprint, setOwnerFingerprint] = useState<string | null>(null);
  const [contributorFps, setContributorFps] = useState<Set<string>>(
    () => new Set(),
  );
  const [collabRows, setCollabRows] = useState<
    Array<{
      fingerprint: string;
      username: string;
      avatar: string;
      role: "Owner" | "Contributor";
    }>
  >([]);
  const [pendingInvites, setPendingInvites] = useState<
    Array<
      ForgeRegistryPendingInviteOp & {
        username: string;
        avatar: string;
        wordSlug: string;
      }
    >
  >([]);
  const [collabFilter, setCollabFilter] = useState("");
  const [collabTypeFilter, setCollabTypeFilter] = useState<
    "all" | "member" | "invitation"
  >("all");
  const [collabLoading, setCollabLoading] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [leaveNote, setLeaveNote] = useState<string | null>(null);
  const [cancelInviteBusy, setCancelInviteBusy] = useState<string | null>(null);
  const sessionFp = getCachedIdentity()?.fingerprint ?? null;
  const isVerifiedContributor = Boolean(
    sessionFp && contributorFps.has(sessionFp) && !isRegistryOwner,
  );
  const contributorOnlyRows = collabRows.filter((r) => r.role === "Contributor");
  const collaboratorsCount = contributorOnlyRows.length;
  const invitationsCount = pendingInvites.length;
  const entitiesCount = collaboratorsCount + invitationsCount;
  const manageQuery = collabFilter.trim().toLowerCase();
  const filteredPending = pendingInvites.filter((p) => {
    if (collabTypeFilter === "member") return false;
    if (!manageQuery) return true;
    return (
      p.username.toLowerCase().includes(manageQuery) ||
      p.wordSlug.toLowerCase().includes(manageQuery) ||
      p.identity_fingerprint.toLowerCase().includes(manageQuery)
    );
  });
  const filteredContributors = contributorOnlyRows.filter((r) => {
    if (collabTypeFilter === "invitation") return false;
    if (!manageQuery) return true;
    return (
      r.username.toLowerCase().includes(manageQuery) ||
      fingerprintWordsJoined(r.fingerprint).toLowerCase().includes(manageQuery) ||
      r.fingerprint.toLowerCase().includes(manageQuery)
    );
  });
  const hasManagePeople =
    pendingInvites.length > 0 || collaboratorsCount > 0;
  const openAddPeople = () => {
    setShowAddPeople(true);
    setAddPeopleQuery("");
    setSearchHit(null);
    setSearchError(null);
    setInviteError(null);
    setInviteNote(null);
  };

  useEffect(() => {
    setRenameValue(displayName);
  }, [displayName]);

  useEffect(() => {
    if (tab !== "collaborators") return;
    let cancelled = false;
    setCollabLoading(true);
    void (async () => {
      try {
        const registry = await fetchForgeRegistry();
        if (cancelled) return;
        const listing = registry.repos.find((r) => r.repo_prefix === prefix);
        const ownerFp = listing?.identity_fingerprint ?? null;
        const fps = contributorFingerprintsForPrefix(
          registry.contributors ?? {},
          prefix,
        );
        const pendingOps = pendingInvitesForPrefix(
          registry.pending_invites ?? {},
          prefix,
        );
        setOwnerFingerprint(ownerFp);
        setContributorFps(fps);
        const rows: Array<{
          fingerprint: string;
          username: string;
          avatar: string;
          role: "Owner" | "Contributor";
        }> = [];
        if (ownerFp) {
          const profile = await fetchForgeProfile(ownerFp).catch(() => null);
          rows.push({
            fingerprint: ownerFp,
            username: profile?.username || "Owner",
            avatar: profile?.avatar || "",
            role: "Owner",
          });
        }
        for (const fp of fps) {
          const profile = await fetchForgeProfile(fp).catch(() => null);
          rows.push({
            fingerprint: fp,
            username: profile?.username || fingerprintWordsJoined(fp),
            avatar: profile?.avatar || "",
            role: "Contributor",
          });
        }
        const pendingRows: Array<
          ForgeRegistryPendingInviteOp & {
            username: string;
            avatar: string;
            wordSlug: string;
          }
        > = [];
        for (const op of pendingOps) {
          const profile = await fetchForgeProfile(op.identity_fingerprint).catch(
            () => null,
          );
          pendingRows.push({
            ...op,
            username:
              profile?.username ||
              fingerprintWordsJoined(op.identity_fingerprint),
            avatar: profile?.avatar || "",
            wordSlug: fingerprintWordsJoined(op.identity_fingerprint),
          });
        }
        if (!cancelled) {
          setCollabRows(rows);
          setPendingInvites(pendingRows);
        }
      } catch {
        if (!cancelled) {
          setCollabRows([]);
          setOwnerFingerprint(null);
          setContributorFps(new Set());
          setPendingInvites([]);
        }
      } finally {
        if (!cancelled) setCollabLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, prefix, inviteNote, isRegistryOwner]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // pending from localStorage + owner inbox decline notices
  // NEW CODE - TESTING: pending_invites from ForgeRegistry

  useEffect(() => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (tab !== "pages" || websiteMode) return;
    // NEW CODE - TESTING: load Pages in website mode too
    if (tab !== "pages") return;
    let cancelled = false;
    setPagesLoading(true);
    setPagesError(null);
    void (async () => {
      try {
        const row = await api.pages(prefix, label, false);
        if (cancelled) return;
        setPages(row);
        if (row.branch) setPagesBranch(row.branch);
        if (row.rootPath != null) setPagesRoot(row.rootPath);
      } catch (err) {
        if (!cancelled) {
          setPages(null);
          setPagesError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setPagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, prefix, label]);

  // Debounced people search for invite modal
  useEffect(() => {
    if (!showAddPeople) return;
    const q = addPeopleQuery.trim();
    if (!q) {
      setSearchHit(null);
      setSearchError(null);
      setSearchBusy(false);
      return;
    }
    let cancelled = false;
    setSearchBusy(true);
    setSearchError(null);
    const t = window.setTimeout(() => {
      void searchPersonForInvite(q, {
        ownerFingerprint,
        contributorFingerprints: contributorFps,
        pendingInviteFingerprints: new Set(
          pendingInvites.map((p) => p.identity_fingerprint),
        ),
      })
        .then((r) => {
          if (cancelled) return;
          if (r.ok) {
            setSearchHit(r.hit);
            setSearchError(null);
          } else {
            setSearchHit(null);
            setSearchError(r.error);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setSearchHit(null);
            setSearchError(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setSearchBusy(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [addPeopleQuery, showAddPeople, ownerFingerprint, contributorFps, pendingInvites]);

  const onRename = (e: FormEvent) => {
    e.preventDefault();
    if (!renameChanged || renameBusy) return;
    void (async () => {
      setRenameBusy(true);
      setRenameError(null);
      setRenameOk(null);
      try {
        const reg = await api.registryLookup(prefix).catch(() => null);
        const result = await api.renameRepo(prefix, renameValue.trim(), {
          description: repo.description ?? reg?.description ?? undefined,
          registrySeq: (reg?.seq ?? 0) + 1,
        });
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // invalidateRegistryCache();
        // setRenameOk(`Renamed to ${result.name}`);
        // navigate(repoHref(prefix, result.label, "settings", ownerOpts), {
        //   replace: true,
        // });
        // window.location.reload();
        // NEW CODE - TESTING: SPA navigate to new label URL (no full reload)
        invalidateRegistryCache();
        clearRepoTipCaches(prefix);
        setRenameOk(`Renamed to ${result.name}`);
        navigate(repoHref(prefix, result.label, "", ownerOpts), {
          replace: true,
        });
      } catch (err) {
        setRenameError(err instanceof Error ? err.message : String(err));
      } finally {
        setRenameBusy(false);
      }
    })();
  };

  const onDelete = (e: FormEvent) => {
    e.preventDefault();
    if (!nameOk || busy || !isRegistryOwner) return;
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        const reg = await api.registryLookup(prefix).catch(() => null);
        await api.softDeleteRepo(prefix, (reg?.seq ?? 0) + 1);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // invalidateRegistryCache();
        // window.location.reload();
        // NEW CODE - TESTING: leave Settings → repo home with deleted UI (no reload)
        removeCachedRegistryEntry(prefix);
        clearRepoTipCaches(prefix);
        navigate(repoHref(prefix, label, "", ownerOpts), {
          replace: true,
          state: {
            softDeleted: true,
            softDeletedAt: new Date().toISOString(),
            hubUnregistered: true,
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  // NEW CODE - TESTING: registry-only remove (keep RepoState + forge-identity key)
  const onUnregister = (e: FormEvent) => {
    e.preventDefault();
    if (!unregisterNameOk || unregisterBusy || !isRegistryOwner) return;
    void (async () => {
      setUnregisterBusy(true);
      setUnregisterError(null);
      try {
        const reg = await api.registryLookup(prefix).catch(() => null);
        await api.unregisterRepo(prefix, (reg?.seq ?? 0) + 1);
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // invalidateRegistryCache();
        // navigate(…) — ForgeRegistry GET often still returned the listing
        // NEW CODE - TESTING: tombstone cache + nav flag so UI is Unregistered immediately
        removeCachedRegistryEntry(prefix);
        navigate(repoHref(prefix, label, "", ownerOpts), {
          replace: true,
          state: { hubUnregistered: true },
        });
      } catch (err) {
        setUnregisterError(err instanceof Error ? err.message : String(err));
      } finally {
        setUnregisterBusy(false);
      }
    })();
  };

  const runPages = async (fn: () => Promise<ForgePagesConfig>) => {
    setPagesBusy(true);
    setPagesError(null);
    // NEW CODE - TESTING: publishing until Enable/Sync Put succeeds
    setPages((prev) =>
      prev ? { ...prev, status: "publishing", lastError: null } : prev,
    );
    try {
      setPages(await fn());
    } catch (err) {
      setPagesError(err instanceof Error ? err.message : String(err));
      try {
        setPages(await api.pages(prefix, label, false));
      } catch {
        /* ignore */
      }
    } finally {
      setPagesBusy(false);
    }
  };

  if (!provisionedOk && !registered) {
    if (provisioning && isOwner) {
      return (
        <section className="gh-repo-settings">
          <header className="gh-repo-settings-header">
            <h1>Preparing settings…</h1>
            <p className="muted">
              Creating missing {brand.displayName} contracts for this repository (registry
              listing and repo settings).
            </p>
          </header>
        </section>
      );
    }
    return (
      <section className="gh-repo-settings">
        <header className="gh-repo-settings-header">
          <h1>Settings unavailable</h1>
          <p className="muted">
            Register this repository on {brand.displayName} first. Settings (delete,
            collaborators, and other {brand.displayName}-only controls) are gated by the
            registry owner fingerprint.
          </p>
        </header>
        <p>
          <a className="btn" href={repoHref(prefix, label, "", ownerOpts)}>
            Back to code
          </a>
        </p>
      </section>
    );
  }

  if (!isOwner) {
    return (
      <section className="gh-repo-settings">
        <CantEditRepoPanel
          backHref={repoHref(prefix, label, "", ownerOpts)}
        />
      </section>
    );
  }

  return (
    <div className="gh-repo-settings">
      <div className="gh-repo-settings-layout">
        <aside className="gh-repo-settings-nav" aria-label="Repository settings">
          <button
            type="button"
            className={
              tab === "general"
                ? "gh-repo-settings-nav-item active"
                : "gh-repo-settings-nav-item"
            }
            onClick={() => selectTab("general")}
          >
            <span className="gh-repo-settings-nav-icon" aria-hidden>
              <GearIcon />
            </span>
            General
          </button>

          <div className="gh-repo-settings-nav-group-label">Access</div>
          <button
            type="button"
            className={
              tab === "collaborators"
                ? "gh-repo-settings-nav-item active"
                : "gh-repo-settings-nav-item"
            }
            onClick={() => selectTab("collaborators")}
          >
            <span className="gh-repo-settings-nav-icon" aria-hidden>
              <PeopleIcon />
            </span>
            Collaborators
          </button>

          <div className="gh-repo-settings-nav-group-label">
            Code, planning, and automation
          </div>
          <button
            type="button"
            className={
              tab === "pages"
                ? "gh-repo-settings-nav-item active"
                : "gh-repo-settings-nav-item"
            }
            onClick={() => selectTab("pages")}
          >
            <span className="gh-repo-settings-nav-icon" aria-hidden>
              <PagesIcon />
            </span>
            Pages
          </button>
        </aside>

        <div className="gh-repo-settings-main">
          {tab === "general" ? (
            <>
              <header className="gh-repo-settings-header">
                <h1>General</h1>
              </header>

              <LocalProtectPanel prefix={prefix} label={previewLabel} />

              <section className="gh-repo-settings-block">
                <form className="gh-repo-rename-row" onSubmit={onRename}>
                  <label className="gh-repo-rename-field">
                    <span className="gh-repo-settings-label">
                      Repository name
                    </span>
                    <div className="gh-repo-rename-controls">
                      <input
                        className="gh-repo-rename-input"
                        value={renameValue}
                        onChange={(e) => {
                          setRenameValue(e.target.value);
                          setRenameError(null);
                          setRenameOk(null);
                        }}
                        autoComplete="off"
                        disabled={renameBusy || alreadyDeleted}
                        maxLength={256}
                        required
                      />
                      <button
                        type="submit"
                        className="gh-repo-rename-btn"
                        disabled={
                          renameBusy || !renameChanged || alreadyDeleted
                        }
                      >
                        {renameBusy ? "Renaming…" : "Rename"}
                      </button>
                    </div>
                  </label>
                </form>
                <p className="muted tiny gh-repo-settings-help">
                  Signed on the Freenet repo contract as{" "}
                  <code>RepoState.name</code>. The contract key{" "}
                  <span className="mono">{prefix}</span> stays fixed. {brand.displayName}
                  URLs use the name (slug{" "}
                  <span className="mono">
                    {prefix}/{previewLabel}
                  </span>
                  ).
                </p>
                {renameError ? (
                  <div className="error-banner">{renameError}</div>
                ) : null}
                {renameOk ? (
                  <p className="muted tiny">{renameOk}</p>
                ) : null}
              </section>

              <section className="gh-repo-settings-block">
                <h2 className="gh-repo-settings-section-title">
                  Default branch
                </h2>
                <p className="muted tiny gh-repo-settings-help">
                  The default branch is the base branch for this repository
                  unless you specify another.
                </p>
                <div className="gh-repo-default-branch">
                  <code className="gh-repo-default-branch-value">
                    {defaultBranch}
                  </code>
                </div>
              </section>

              <section className="gh-repo-settings-block">
                <h2 className="gh-repo-settings-section-title">Remote</h2>
                <code className="mono break gh-repo-remote">
                  {repo.url.remote}
                </code>
              </section>

              <section
                className="gh-danger-zone"
                aria-labelledby="repo-danger-heading"
              >
                <h2 id="repo-danger-heading" className="gh-danger-zone-title">
                  Danger Zone
                </h2>
                <div className="gh-danger-box">
                  {/* NEW CODE - TESTING: Unregister above Delete */}
                  <div className="gh-danger-row">
                    <div className="gh-danger-copy">
                      <strong className="gh-danger-row-title">
                        Unregister from {brand.displayName}
                      </strong>
                      <p className="muted tiny">
                        Remove this repository from {registryLabel()}
                        Discover and People listings only. The Freenet repo
                        contract and your local identity key are kept — use
                        Import to list it again. If Pages is enabled, it is
                        disabled and the website is taken down first.
                        {!isRegistryOwner
                          ? ` Only the ${brand.displayName} registry owner can unregister.`
                          : null}
                      </p>
                    </div>
                    {!alreadyDeleted &&
                    !showUnregisterConfirm &&
                    isRegistryOwner ? (
                      <button
                        type="button"
                        className="gh-danger-btn"
                        onClick={() => {
                          setShowUnregisterConfirm(true);
                          setShowDeleteConfirm(false);
                          setUnregisterError(null);
                          setUnregisterConfirmName("");
                        }}
                      >
                        Unregister
                      </button>
                    ) : null}
                    {!alreadyDeleted && !isRegistryOwner ? (
                      <button
                        type="button"
                        className="gh-danger-btn"
                        disabled
                        title={`Only the identity that registered this repo on ${brand.displayName} can unregister it`}
                      >
                        Unregister
                      </button>
                    ) : null}
                  </div>

                  {!alreadyDeleted && showUnregisterConfirm ? (
                    <div className="gh-danger-confirm">
                      <p className="muted tiny">
                        Type <strong>{displayName}</strong> to confirm. This
                        only clears the ForgeRegistry listing — it does not
                        soft-delete the repo or remove your local key. Enabled
                        Pages will be disabled (website tombstoned) first.
                      </p>
                      {unregisterError ? (
                        <div className="error-banner">{unregisterError}</div>
                      ) : null}
                      <form
                        className="gh-danger-form"
                        onSubmit={onUnregister}
                      >
                        <label className="settings-field">
                          <span className="settings-label">
                            Confirm repository name
                          </span>
                          <input
                            value={unregisterConfirmName}
                            onChange={(e) =>
                              setUnregisterConfirmName(e.target.value)
                            }
                            autoComplete="off"
                            disabled={unregisterBusy}
                            required
                          />
                        </label>
                        <div className="row">
                          <button
                            type="submit"
                            className="gh-danger-btn"
                            disabled={unregisterBusy || !unregisterNameOk}
                          >
                            {unregisterBusy
                              ? "Unregistering…"
                              : `Unregister from ${brand.displayName}`}
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={unregisterBusy}
                            onClick={() => {
                              setShowUnregisterConfirm(false);
                              setUnregisterConfirmName("");
                              setUnregisterError(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  ) : null}

                  <div className="gh-danger-row">
                    <div className="gh-danger-copy">
                      <strong className="gh-danger-row-title">
                        Delete this repository
                      </strong>
                      <p className="muted tiny">
                        Soft-delete marks the freenet-git contract abandoned and
                        removes it from {registryLabel()}. Freenet cannot
                        wipe historical packs from every peer. If Pages is
                        enabled, it is disabled and the website is taken down
                        first. Once you delete a repository, there is no going
                        back. Please be certain.
                        {!isRegistryOwner
                          ? ` Only the ${brand.displayName} registry owner can delete.`
                          : null}
                      </p>
                    </div>
                    {!alreadyDeleted && !showDeleteConfirm && isRegistryOwner ? (
                      <button
                        type="button"
                        className="gh-danger-btn"
                        onClick={() => {
                          setShowDeleteConfirm(true);
                          setShowUnregisterConfirm(false);
                          setError(null);
                        }}
                      >
                        Delete this repository
                      </button>
                    ) : null}
                    {!alreadyDeleted && !isRegistryOwner ? (
                      <button
                        type="button"
                        className="gh-danger-btn"
                        disabled
                        title={`Only the identity that registered this repo on ${brand.displayName} can delete it`}
                      >
                        Delete this repository
                      </button>
                    ) : null}
                  </div>

                  {alreadyDeleted ? (
                    <div className="gh-danger-confirm" role="status">
                      <p className="muted">
                        This repository is already marked deleted
                        {repo.softDelete?.at
                          ? ` (at ${repo.softDelete.at})`
                          : ""}
                        .
                        {!websiteMode
                          ? " Bridge mode only unregisters from the local ForgeRegistry file."
                          : null}
                      </p>
                    </div>
                  ) : showDeleteConfirm ? (
                    <div className="gh-danger-confirm">
                      <p className="muted tiny">
                        Type <strong>{displayName}</strong> to confirm. This
                        publishes a <code>deleted</code> extension and{" "}
                        <code>[deleted]</code> description, then unregisters
                        from ForgeRegistry.
                      </p>
                      {error ? (
                        <div className="error-banner">{error}</div>
                      ) : null}
                      <form className="gh-danger-form" onSubmit={onDelete}>
                        <label className="settings-field">
                          <span className="settings-label">
                            Confirm repository name
                          </span>
                          <input
                            value={confirmName}
                            onChange={(e) => setConfirmName(e.target.value)}
                            autoComplete="off"
                            disabled={busy}
                            required
                          />
                        </label>
                        <div className="row">
                          <button
                            type="submit"
                            className="gh-danger-btn"
                            disabled={busy || !nameOk}
                          >
                            {busy
                              ? "Deleting…"
                              : "I understand, delete this repository"}
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={busy}
                            onClick={() => {
                              setShowDeleteConfirm(false);
                              setConfirmName("");
                              setError(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </div>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}

          {tab === "pages" ? (
            <>
              <header className="gh-repo-settings-header">
                <h1>Pages</h1>
                <p className="muted">
                  Publish a Freenet website contract from a tip branch (needs{" "}
                  <span className="mono">index.html</span>).
                </p>
              </header>

              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              {websiteMode ? (
                <section className="gh-repo-settings-block">
                  <p className="muted">
                    Pages enable / republish uses the Hub bridge…
                  </p>
                </section>
              ) : (
              */}
              <>
                  {pagesLoading ? (
                    <p className="muted">Loading Pages status…</p>
                  ) : null}
                  {pagesError ? (
                    <div className="error-banner">{pagesError}</div>
                  ) : null}

                  <section className="gh-repo-settings-block gh-pages-panel">
                    <div className="gh-pages-panel-row">
                      <div>
                        <h2 className="gh-repo-settings-section-title">
                          {brand.displayName} website Pages
                        </h2>
                        <p className="muted tiny gh-repo-settings-help">
                          Publish a Freenet website from this tip. Enable /
                          Sync / Disable require your {brand.displayName} identity to own
                          the ForgeRegistry listing for this repo. Unregister and
                          delete take Pages down first when enabled.
                        </p>
                      </div>
                      <span
                        className={`gh-pages-status ${
                          pagesBusy
                            ? "publishing"
                            : (pages?.status ?? "off")
                        }`}
                      >
                        {pagesBusy
                          ? "publishing"
                          : (pages?.status ?? "off")}
                      </span>
                    </div>

                    {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
                    {pages?.enabled || pages?.siteUrl || pages?.contractKey ? (
                      … showed URL even after disable while contract_key lingered
                    */}
                    {/* NEW CODE - TESTING: URL only after confirmed enabled deploy */}
                    {pages?.enabled &&
                    (pages.siteUrl || pages.contractKey) ? (
                      <div className="gh-pages-site-link">
                        {pages.siteUrl ? (
                          <>
                            <span className="gh-repo-settings-label">
                              Website URL
                            </span>
                            <a
                              href={pages.siteUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mono break"
                            >
                              {pages.siteUrl}
                            </a>
                          </>
                        ) : null}
                        {pages.contractKey ? (
                          <p className="muted tiny">
                            Contract key{" "}
                            <span className="mono">{pages.contractKey}</span>
                            {pages.websiteKeyName
                              ? ` (${pages.websiteKeyName})`
                              : ""}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {pages?.lastPublishedCommit ? (
                      <p className="muted tiny">
                        Last published{" "}
                        <span className="mono">
                          {pages.lastPublishedCommit.slice(0, 7)}
                        </span>
                        {pages.lastPublishedAt
                          ? ` · ${pages.lastPublishedAt}`
                          : ""}
                      </p>
                    ) : null}

                    {pages?.lastError ? (
                      <div className="error-banner tiny">{pages.lastError}</div>
                    ) : null}

                    {!registered || !isRegistryOwner ? (
                      <p className="muted tiny">
                        {!registered
                          ? `Register this repository on ${brand.displayName} before enabling Pages.`
                          : `Only the ${brand.displayName} registry owner can enable, sync, or disable Pages.`}
                      </p>
                    ) : !pages?.enabled ? (
                      <div className="gh-pages-enable-form">
                        <label className="settings-field">
                          <span className="settings-label">Branch</span>
                          <input
                            value={pagesBranch}
                            onChange={(e) => setPagesBranch(e.target.value)}
                            placeholder="main"
                            disabled={pagesBusy}
                          />
                        </label>
                        <label className="settings-field">
                          <span className="settings-label">
                            Root path (optional)
                          </span>
                          <input
                            value={pagesRoot}
                            onChange={(e) => setPagesRoot(e.target.value)}
                            placeholder="docs or leave empty for repo root"
                            disabled={pagesBusy}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={pagesBusy || !pagesBranch.trim()}
                          onClick={() =>
                            void runPages(() =>
                              api.pagesEnable(prefix, label, {
                                branch: pagesBranch.trim(),
                                rootPath: pagesRoot.trim(),
                                autoSync: true,
                              }),
                            )
                          }
                        >
                          {pagesBusy ? "Publishing…" : "Enable Pages"}
                        </button>
                      </div>
                    ) : (
                      <div className="gh-pages-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={pagesBusy}
                          onClick={() =>
                            void runPages(() => api.pagesSync(prefix, label))
                          }
                        >
                          {pagesBusy ? "Updating…" : "Republish / update site"}
                        </button>
                        <button
                          type="button"
                          className="btn secondary"
                          disabled={pagesBusy}
                          onClick={() =>
                            void runPages(() =>
                              api.pagesDisable(prefix, label, {
                                tombstone: true,
                              }),
                            )
                          }
                        >
                          Disable Pages
                        </button>
                      </div>
                    )}
                    <p className="muted tiny" style={{ marginTop: "0.75rem" }}>
                      Disable tombstones the Freenet site. If About website was
                      set to the Pages URL, it is cleared automatically.
                    </p>
                  </section>
                </>
              {/* )} */}
            </>
          ) : null}

          {tab === "collaborators" ? (
            <>
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              Previous layout put Add people next to Direct access and listed
              owner+contributors only (no pending / GitHub Manage access chrome).
              */}
              {/* NEW CODE - TESTING: GitHub Collaborators layout */}
              <header className="gh-repo-settings-header">
                <h1>Collaborators and teams</h1>
              </header>

              <section className="gh-collab-visibility">
                <div className="gh-collab-visibility-main">
                  <span className="gh-collab-visibility-icon" aria-hidden>
                    <RepoBookIcon />
                  </span>
                  <div>
                    <strong>Public repository</strong>
                    <p className="muted tiny">
                      This repository is public and visible to anyone on
                      {brand.displayName} Discover.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  disabled
                  title="Visibility controls are not available yet"
                >
                  Manage visibility
                </button>
              </section>

              <section className="gh-collab-section">
                <h2 className="gh-repo-settings-section-title">Direct access</h2>
                <div className="gh-collab-direct-box">
                  <span className="gh-collab-direct-people" aria-hidden>
                    <PeopleIcon />
                  </span>
                  {collabLoading ? (
                    <p className="muted tiny">Loading access…</p>
                  ) : entitiesCount === 0 ? (
                    <p className="muted tiny">
                      0 collaborators have access to this repository. Only you
                      can contribute to this repository.
                    </p>
                  ) : (
                    <p className="muted tiny">
                      {entitiesCount}{" "}
                      {entitiesCount === 1 ? "entity has" : "entities have"}{" "}
                      access to this repository.{" "}
                      <button
                        type="button"
                        className="gh-collab-count-link"
                        onClick={() => {
                          setCollabTypeFilter("member");
                          setCollabFilter("");
                        }}
                      >
                        {collaboratorsCount} collaborator
                        {collaboratorsCount === 1 ? "" : "s"}
                      </button>
                      .{" "}
                      <button
                        type="button"
                        className="gh-collab-count-link"
                        onClick={() => {
                          setCollabTypeFilter("invitation");
                          setCollabFilter("");
                        }}
                      >
                        {invitationsCount} invitation
                        {invitationsCount === 1 ? "" : "s"}
                      </button>
                      .
                    </p>
                  )}
                </div>
              </section>

              <section className="gh-collab-section">
                <div className="gh-collab-manage-head">
                  <h2 className="gh-repo-settings-section-title">
                    Manage access
                  </h2>
                  {hasManagePeople || !isRegistryOwner ? (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!isRegistryOwner}
                      title={
                        isRegistryOwner
                          ? undefined
                          : `Only the ${brand.displayName} registry owner can invite collaborators`
                      }
                      onClick={openAddPeople}
                    >
                      Add people
                    </button>
                  ) : null}
                </div>

                {!isRegistryOwner ? (
                  <p className="muted tiny gh-repo-settings-help">
                    {isVerifiedContributor
                      ? "You are a verified contributor. Invites stay with the registry owner. You can leave below to drop your grant and site key."
                      : `Invites and delete are reserved for the identity listed as owner on the ${brand.displayName} registry.`}
                  </p>
                ) : null}

                {leaveError ? (
                  <FlashNotice
                    variant="error"
                    onDismiss={() => setLeaveError(null)}
                  >
                    {leaveError}
                  </FlashNotice>
                ) : null}
                {leaveNote ? (
                  <FlashNotice
                    variant="success"
                    onDismiss={() => setLeaveNote(null)}
                  >
                    {leaveNote}
                  </FlashNotice>
                ) : null}

                {collabLoading ? (
                  <div className="gh-collab-manage-box gh-collab-manage-empty muted">
                    Loading access…
                  </div>
                ) : !hasManagePeople ? (
                  <div className="gh-collab-manage-box gh-collab-manage-empty">
                    <CollabEmptyIcon />
                    <p className="gh-collab-manage-empty-title">
                      You haven&apos;t invited any collaborators yet
                    </p>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!isRegistryOwner}
                      title={
                        isRegistryOwner
                          ? undefined
                          : `Only the ${brand.displayName} registry owner can invite collaborators`
                      }
                      onClick={openAddPeople}
                    >
                      Add people
                    </button>
                  </div>
                ) : (
                  <div className="gh-collab-manage-box">
                    <div className="gh-collab-manage-toolbar">
                      <label className="gh-collab-select-all">
                        <input type="checkbox" disabled aria-label="Select all" />
                        <span>Select all</span>
                      </label>
                      <div className="gh-collab-manage-toolbar-right">
                        <label className="gh-collab-type-filter">
                          <span className="sr-only">Type</span>
                          <select
                            value={collabTypeFilter}
                            onChange={(e) =>
                              setCollabTypeFilter(
                                e.target.value as
                                  | "all"
                                  | "member"
                                  | "invitation",
                              )
                            }
                            aria-label="Type"
                          >
                            <option value="all">Type</option>
                            <option value="member">Member</option>
                            <option value="invitation">Invitation</option>
                          </select>
                        </label>
                        <label className="gh-collab-find">
                          <span className="sr-only">Find a collaborator</span>
                          <input
                            value={collabFilter}
                            onChange={(e) => setCollabFilter(e.target.value)}
                            placeholder="Find a collaborator…"
                          />
                        </label>
                      </div>
                    </div>
                    <ul className="gh-collab-manage-list">
                      {filteredPending.map((p) => {
                        const expired = isPendingInviteExpired(p.updated_at);
                        return (
                          <li
                            key={`invite-${p.identity_fingerprint}-${p.seq}`}
                            className="gh-collab-manage-row"
                          >
                            <input
                              type="checkbox"
                              disabled
                              aria-label={`Select ${p.username}`}
                            />
                            <ProfileAvatar
                              fingerprint={p.identity_fingerprint}
                              vaultId=""
                              avatarUrl={p.avatar || null}
                              size={32}
                            />
                            <span className="gh-collab-result-text">
                              <span className="gh-collab-result-name gh-collab-linkish">
                                {p.username}
                              </span>
                              <span className="gh-collab-result-sub">
                                Awaiting {p.wordSlug || p.username}&apos;s
                                response
                              </span>
                            </span>
                            {expired ? (
                              <span className="gh-collab-status-expired">
                                Invite expired
                              </span>
                            ) : (
                              <span className="gh-collab-status-pending">
                                Pending invite
                              </span>
                            )}
                            {isRegistryOwner ? (
                              <button
                                type="button"
                                className="gh-collab-row-danger"
                                title="Cancel invitation on ForgeRegistry"
                                aria-label={`Cancel invite for ${p.username}`}
                                disabled={
                                  cancelInviteBusy === p.identity_fingerprint
                                }
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      `Cancel pending invite for ${p.username}? This removes it from ForgeRegistry. They may still have a sealed inbox message until they decline or you ask them to ignore it.`,
                                    )
                                  ) {
                                    return;
                                  }
                                  setCancelInviteBusy(p.identity_fingerprint);
                                  void nativeCancelPendingInvite({
                                    prefix,
                                    inviteeFingerprint: p.identity_fingerprint,
                                  })
                                    .then(() => {
                                      setPendingInvites((rows) =>
                                        rows.filter(
                                          (row) =>
                                            row.identity_fingerprint !==
                                            p.identity_fingerprint,
                                        ),
                                      );
                                    })
                                    .catch((e) => {
                                      setLeaveError(
                                        e instanceof Error
                                          ? e.message
                                          : String(e),
                                      );
                                    })
                                    .finally(() => setCancelInviteBusy(null));
                                }}
                              >
                                <TrashIcon />
                              </button>
                            ) : null}
                          </li>
                        );
                      })}
                      {filteredContributors.map((row) => (
                        <li
                          key={row.fingerprint}
                          className="gh-collab-manage-row"
                        >
                          <input
                            type="checkbox"
                            disabled
                            aria-label={`Select ${row.username}`}
                          />
                          <ProfileAvatar
                            fingerprint={row.fingerprint}
                            vaultId=""
                            avatarUrl={row.avatar || null}
                            size={32}
                          />
                          <span className="gh-collab-result-text">
                            <span className="gh-collab-result-name gh-collab-linkish">
                              {row.username}
                              {sessionFp === row.fingerprint ? " (you)" : ""}
                            </span>
                            <span className="gh-collab-result-sub mono break">
                              {fingerprintWordsJoined(row.fingerprint)}
                            </span>
                          </span>
                          <span className="gh-collab-role">Write</span>
                        </li>
                      ))}
                      {filteredPending.length === 0 &&
                      filteredContributors.length === 0 ? (
                        <li className="gh-collab-manage-row muted">
                          No matching people
                        </li>
                      ) : null}
                    </ul>
                  </div>
                )}

                {isVerifiedContributor ? (
                  <div className="gh-collab-leave">
                    <p className="muted tiny">
                      Leave removes your verified contributor grant on the
                      registry, deletes this repo’s site key from this node, and
                      pushes your vault when possible. This cannot force other
                      copies of the key elsewhere — honest opt-out only.
                    </p>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={leaveBusy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Leave ${displayName} as a contributor? Your site key for this repo will be removed from this node.`,
                          )
                        ) {
                          return;
                        }
                        setLeaveBusy(true);
                        setLeaveError(null);
                        setLeaveNote(null);
                        void leaveRepositoryAsContributor(prefix)
                          .then((r) => {
                            invalidateRegistryCache();
                            clearRepoTipCaches(prefix);
                            setLeaveNote(
                              r.vaultPushed
                                ? "Left repository — grant removed, local key cleared, vault updated."
                                : "Left repository — grant removed and local key cleared. Sync vault from Account → Sync if needed.",
                            );
                            setContributorFps((prev) => {
                              const next = new Set(prev);
                              if (sessionFp) next.delete(sessionFp);
                              return next;
                            });
                            setCollabRows((rows) =>
                              rows.filter(
                                (row) => row.fingerprint !== sessionFp,
                              ),
                            );
                            navigate(repoHref(prefix, label, "", ownerOpts), {
                              replace: true,
                            });
                          })
                          .catch((e) => {
                            setLeaveError(
                              e instanceof Error ? e.message : String(e),
                            );
                          })
                          .finally(() => setLeaveBusy(false));
                      }}
                    >
                      <BusyLabel
                        busy={leaveBusy}
                        busyText="Leaving…"
                        idleText="Leave repository"
                      />
                    </button>
                  </div>
                ) : null}
              </section>

              {showAddPeople ? (
                <div
                  className="gh-collab-modal-backdrop"
                  role="presentation"
                  onClick={() => setShowAddPeople(false)}
                >
                  <div
                    className="gh-collab-modal"
                    role="dialog"
                    aria-labelledby="gh-collab-modal-title"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <header className="gh-collab-modal-head">
                      <h2 id="gh-collab-modal-title">
                        Add people to {displayName}
                      </h2>
                      <button
                        type="button"
                        className="gh-collab-modal-close"
                        aria-label="Close"
                        onClick={() => setShowAddPeople(false)}
                      >
                        ×
                      </button>
                    </header>
                    {inviteError ? (
                      <FlashNotice
                        variant="error"
                        onDismiss={() => setInviteError(null)}
                      >
                        {inviteError}
                      </FlashNotice>
                    ) : null}
                    {inviteNote ? (
                      <FlashNotice
                        variant="success"
                        onDismiss={() => setInviteNote(null)}
                      >
                        {inviteNote}
                      </FlashNotice>
                    ) : null}
                    <p className="muted tiny">
                      Search by fingerprint or fingerprint words. Invites seal
                      the repo site key plus an owner coupon — never your
                      identity seed.
                    </p>
                    <label className="settings-field">
                      <span className="settings-label">Find people</span>
                      <input
                        value={addPeopleQuery}
                        onChange={(e) => {
                          setAddPeopleQuery(e.target.value);
                          setInviteNote(null);
                        }}
                        placeholder="freenet:id:… or six fingerprint words"
                        autoFocus
                        disabled={inviteBusy}
                      />
                    </label>
                    <div className="gh-collab-results">
                      {searchBusy ? (
                        <div className="gh-collab-results-empty">Searching…</div>
                      ) : searchHit ? (
                        <button
                          type="button"
                          className="gh-collab-result selected"
                          onClick={() => undefined}
                        >
                          <ProfileAvatar
                            fingerprint={searchHit.fingerprint}
                            vaultId=""
                            avatarUrl={searchHit.avatar || null}
                            size={32}
                          />
                          <span className="gh-collab-result-text">
                            <span className="gh-collab-result-name">
                              {searchHit.username}
                            </span>
                            <span className="gh-collab-result-sub mono break">
                              {searchHit.wordSlug}
                            </span>
                          </span>
                        </button>
                      ) : addPeopleQuery.trim() ? (
                        <div className="gh-collab-results-empty">
                          {searchError || "No profiles found"}
                        </div>
                      ) : (
                        <div className="gh-collab-results-empty">
                          Type a fingerprint or fingerprint words
                        </div>
                      )}
                    </div>
                    {searchHit && searchHit.inviteBlockedReason ? (
                      <p
                        className="muted tiny"
                        style={{ color: "var(--fgColor-attention)" }}
                      >
                        {searchHit.inviteBlockedReason}
                      </p>
                    ) : null}
                    {searchHit &&
                    !searchHit.inbox_pk &&
                    !searchHit.inviteBlockedReason ? (
                      <p className="muted tiny">
                        This profile has no inbox_pk yet — they need to create
                        or restore once on {brand.displayName}.
                      </p>
                    ) : null}
                    <OperationStatus
                      active={inviteBusy}
                      scenario="invite-send"
                      step={inviteStep}
                    />
                    <div className="gh-collab-modal-actions">
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={inviteBusy}
                        onClick={() => setShowAddPeople(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={
                          inviteBusy ||
                          !searchHit?.inbox_pk ||
                          !isRegistryOwner ||
                          Boolean(searchHit?.inviteBlockedReason)
                        }
                        onClick={() => {
                          if (!searchHit || searchHit.inviteBlockedReason)
                            return;
                          setInviteBusy(true);
                          setInviteError(null);
                          setInviteNote(null);
                          void sendRepoInvite({
                            prefix,
                            label,
                            repoName: displayName,
                            recipientFingerprint: searchHit.fingerprint,
                            onStatus: setInviteStep,
                          })
                            .then(() => {
                              setInviteNote(
                                `Invite sent to ${searchHit.username}. They’ll see it in Inbox.`,
                              );
                              setAddPeopleQuery("");
                              setSearchHit(null);
                            })
                            .catch((e) => {
                              setInviteError(
                                e instanceof Error ? e.message : String(e),
                              );
                            })
                            .finally(() => {
                              setInviteBusy(false);
                              setInviteStep(null);
                            });
                        }}
                      >
                        <BusyLabel
                          busy={inviteBusy}
                          busyText="Sending…"
                          idleText="Add to repository"
                        />
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
