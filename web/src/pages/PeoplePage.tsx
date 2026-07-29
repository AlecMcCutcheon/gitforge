import { useEffect, useMemo, useState } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Link } from "../spa-link";
import { api, type HubRegistration, type PersonResponse } from "../api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { ProfileAvatar } from "../components/ProfileAvatar";
import {
  RepoProtectChrome,
} from "../components/RepoProtectControls";
import { EditPinnedModal } from "../components/EditPinnedModal";
import { EditStatusModal } from "../components/EditStatusModal";
import { PinnedReposGrid } from "../components/PinnedReposGrid";
import {
  currentIdentity,
  getCachedIdentity,
  getCachedProfile,
  getSessionVaultId,
  onAuthSessionChange,
  updatePublicProfile,
} from "../freenet/auth-api";
import {
  loadRegistryCached,
  loadStarsCached,
  peekCachedRegistry,
  peekCachedStars,
} from "../freenet/discover-cache";
import { fetchHubRegistry } from "../freenet/hub-registry";
import { parseRegistryLanguage } from "../freenet/registry-lang";
import {
  fetchHubProfile,
  parsePinnedPrefixes,
  parseProfileStatus,
} from "../freenet/hub-profile";
import {
  fingerprintFromSearch,
  fingerprintWordsJoined,
  isFingerprintId,
  peoplePath,
} from "../freenet/fingerprint-words";
import {
  fetchHubStars,
  reposStarredBy,
  starCountForRepo,
} from "../freenet/hub-stars";
import {
  rememberPersonFingerprint,
  resolvePersonRef,
} from "../freenet/people-resolve";
import { repoHref, repoPathDisplay } from "../lib/repo-path";
import { isBrowserNativeMode } from "../tip-browse";
import {
  looksLikePersonNotFound,
  NotFoundPage,
} from "./NotFoundPage";
import { useDocumentTitle } from "../lib/document-title";

type PeopleTab = "overview" | "repos" | "stars";

/** One row on a person's Repositories list (registry and/or local delegate). */
interface PersonRepoRow {
  prefix: string;
  label: string;
  name: string | null;
  description: string | null;
  /** HubRegistry owner fingerprint when registered. */
  ownerFingerprint: string | null;
  role: "owner" | "contributor";
  registration: "registered" | "unregistered";
  /** Cached HubRegistry public_meta.lang (null = unknown / omit). */
  language: string | null;
  languageColor: string | null;
}

function tabFromQuery(raw: string | null): PeopleTab {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (raw === "repos" || raw === "stars" || raw === "overview") return raw;
  // NEW CODE - TESTING: public query uses repositories (repos still accepted)
  if (raw === "repositories" || raw === "repos") return "repos";
  if (raw === "stars" || raw === "overview") return raw;
  return "overview";
}

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// function tabToQuery(tab: PeopleTab): string | null {
//   if (tab === "repos") return "repositories";
//   if (tab === "stars") return "stars";
//   return null;
// }

/** Cold-load hint: legacy `?fp=` still accepted; clean URLs omit it. */
function peekFpHintFromWindow(): string | null {
  try {
    // Prefer normal search (BrowserRouter); fall back to hash query for old links.
    if (window.location.search) {
      return fingerprintFromSearch(window.location.search);
    }
    const hash = window.location.hash;
    if (hash.includes("?")) {
      return fingerprintFromSearch(hash.slice(hash.indexOf("?")));
    }
    return null;
  } catch {
    return null;
  }
}

function isDeletedListing(description: string | null | undefined): boolean {
  return (description ?? "").trim().toLowerCase().startsWith("[deleted]");
}

function rowFromRegistration(
  r: HubRegistration,
  profileFingerprint: string,
): PersonRepoRow {
  const owner = r.identity_fingerprint;
  const isOwner =
    owner.toLowerCase() === profileFingerprint.toLowerCase();
  const lang = parseRegistryLanguage(r.public_meta);
  return {
    prefix: r.repo_prefix,
    label: r.label,
    name: r.name,
    description: r.description,
    ownerFingerprint: owner,
    role: isOwner ? "owner" : "contributor",
    registration: "registered",
    language: lang?.name ?? null,
    languageColor: lang?.color ?? null,
  };
}

function sortPersonRepoRows(rows: PersonRepoRow[]): PersonRepoRow[] {
  return [...rows].sort((a, b) => {
    const reg =
      (a.registration === "registered" ? 0 : 1) -
      (b.registration === "registered" ? 0 : 1);
    if (reg) return reg;
    const role =
      (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1);
    if (role) return role;
    return (a.name ?? a.label).localeCompare(b.name ?? b.label, undefined, {
      sensitivity: "base",
    });
  });
}

function RepoList({
  rows,
  empty,
  showBackup = false,
}: {
  rows: PersonRepoRow[];
  empty: string;
  /** Local tip/registry backup controls (self profile only). */
  showBackup?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  const visible = rows.filter((r) => !isDeletedListing(r.description));
  if (visible.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  return (
    <ul className="repo-cards">
      {visible.map((r) => {
        const opts = r.ownerFingerprint
          ? { ownerFingerprint: r.ownerFingerprint }
          : undefined;
        const title = r.name?.trim() || r.label;
        return (
          <li key={r.prefix}>
            <div className="repo-card">
              <div className="repo-card-title-row">
                <Link
                  to={repoHref(r.prefix, r.label, "", opts)}
                  className="repo-card-title-link"
                >
                  <strong>{title}</strong>
                </Link>
                <span className="repo-card-badges">
                  <span
                    className={
                      r.role === "owner" ? "gh-badge" : "gh-badge muted-badge"
                    }
                    title={
                      r.role === "owner"
                        ? "HubRegistry owner fingerprint matches this profile"
                        : "Local key held here; HubRegistry lists a different owner"
                    }
                  >
                    {r.role === "owner" ? "Owner" : "Contributor"}
                  </span>
                  <span
                    className={
                      r.registration === "registered"
                        ? "gh-badge success-badge"
                        : "gh-badge warn-badge"
                    }
                    title={
                      r.registration === "registered"
                        ? "Listed on GitAtlasRegistry (GAR)"
                        : "In your identity delegate on this device — not on HubRegistry (only you see this)"
                    }
                  >
                    {r.registration === "registered"
                      ? "Registered"
                      : "Unregistered"}
                  </span>
                  {showBackup ? (
                    <RepoProtectChrome
                      prefix={r.prefix}
                      reason="own"
                    />
                  ) : null}
                </span>
              </div>
              {r.description?.trim() ? (
                <Link
                  to={repoHref(r.prefix, r.label, "", opts)}
                  className="repo-card-body-link"
                >
                  <span className="muted">{r.description}</span>
                </Link>
              ) : null}
              <Link
                to={repoHref(r.prefix, r.label, "", opts)}
                className="repo-card-body-link"
              >
                <span className="mono">
                  {repoPathDisplay(r.prefix, r.label, opts)}
                </span>
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PeoplePage() {
  const { fingerprint: rawParam = "" } = useParams();
  const [searchParams] = useSearchParams();
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const [searchParams, setSearchParams] = useSearchParams();
  const rawRef = (() => {
    try {
      return decodeURIComponent(rawParam);
    } catch {
      return rawParam;
    }
  })();

  const [resolvedFp, setResolvedFp] = useState<string | null>(() => {
    const hint = peekFpHintFromWindow();
    if (hint) {
      rememberPersonFingerprint(hint);
      return hint;
    }
    if (isFingerprintId(rawRef)) {
      rememberPersonFingerprint(rawRef);
      return rawRef;
    }
    return null;
  });
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<PeopleTab>(() =>
    tabFromQuery(searchParams.get("tab")),
  );
  const [starRows, setStarRows] = useState<
    Array<{ repo_prefix: string; starred_at: string; label?: string }>
  >([]);
  const [starsReady, setStarsReady] = useState(false);
  const [publicProfile, setPublicProfile] = useState<{
    bio: string;
    url: string;
    avatar: string;
    username: string;
    statusText: string;
    statusEmoji: string;
    pinnedPrefixes: string[];
  } | null>(null);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [statusModalOpen, setStatusModalOpen] = useState(false);
  const [selfFp, setSelfFp] = useState(
    () => getCachedIdentity()?.fingerprint ?? null,
  );
  const [selfProfile, setSelfProfile] = useState(() => getCachedProfile());
  const websiteMode = isBrowserNativeMode();
  // NEW CODE - TESTING: self-only rows from hub-identity not on / beyond HubRegistry
  const [delegateExtraRows, setDelegateExtraRows] = useState<PersonRepoRow[]>(
    [],
  );
  const [delegateReposReady, setDelegateReposReady] = useState(true);

  const id = resolvedFp;
  const wordSlug = id ? fingerprintWordsJoined(id) : "";
  const fpHint =
    fingerprintFromSearch(searchParams.toString()) ?? peekFpHintFromWindow();

  const isSelf =
    Boolean(selfFp) &&
    Boolean(id) &&
    selfFp!.toLowerCase() === id!.toLowerCase();

  // Rewrite bare freenet:id paths to word-slug URLs (clean — no ?fp=).
  const shouldCanonicalize =
    Boolean(id) && isFingerprintId(rawRef);

  // Strip legacy ?fp= from the address bar once resolved.
  const shouldStripFp =
    Boolean(id) && Boolean(fpHint) && !isFingerprintId(rawRef);

  useEffect(() => {
    setTab(tabFromQuery(searchParams.get("tab")));
  }, [searchParams]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const selectTab = (next: PeopleTab) => {
  //   setTab(next);
  //   const tabQ = tabToQuery(next);
  //   void setSearchParams(tabQ ? { tab: tabQ } : {}, { replace: true });
  // };
  // — only used by removed Overview "View all repositories" button; tabs are in PeopleSiteNav

  useEffect(() => {
    const sync = () => {
      setSelfFp(getCachedIdentity()?.fingerprint ?? null);
      setSelfProfile(getCachedProfile());
    };
    sync();
    return onAuthSessionChange(sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // setResolvedFp(null);
    // NEW CODE - TESTING: keep sync hint so reload does not flash forever-skeleton
    if (!fpHint && !isFingerprintId(rawRef)) {
      setResolvedFp(null);
    }
    setResolveError(null);
    setPerson(null);
    setError(null);
    void (async () => {
      if (fpHint && isFingerprintId(fpHint)) {
        rememberPersonFingerprint(fpHint);
        if (!cancelled) setResolvedFp(fpHint);
        return;
      }
      // Word slug without ?fp= (sandbox has no localStorage): wait for identity.
      if (websiteMode) {
        await Promise.race([
          currentIdentity().catch(() => null),
          new Promise((r) => setTimeout(r, 12_000)),
        ]);
      }
      if (cancelled) return;
      const res = await resolvePersonRef(rawRef, fpHint);
      if (cancelled) return;
      if (!res.ok) {
        setResolveError(res.error);
        return;
      }
      rememberPersonFingerprint(res.fingerprint);
      setResolvedFp(res.fingerprint);
    })();
    return () => {
      cancelled = true;
    };
  }, [rawRef, websiteMode, fpHint]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setPerson(null);
    setError(null);
    void api
      .person(id)
      .then((p) => {
        if (!cancelled) setPerson(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // Still paint an empty person so the page is not stuck loading.
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // displayName: id,
          // NEW CODE - TESTING: words slug — never put freenet:id: in the H1
          setPerson({
            fingerprint: id,
            displayName: fingerprintWordsJoined(id),
            email: null,
            repos: [],
            note: err instanceof Error ? err.message : String(err),
          });
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || !websiteMode) {
      setPublicProfile(null);
      return;
    }
    let cancelled = false;
    setPublicProfile(null);
    void fetchHubProfile(id)
      .then((state) => {
        if (cancelled || !state) return;
        const status = parseProfileStatus(state.public_meta);
        setPublicProfile({
          bio: state.bio,
          url: state.url,
          avatar: state.avatar,
          username: state.username,
          statusText: status?.text ?? "",
          statusEmoji: status?.emoji ?? "",
          pinnedPrefixes: parsePinnedPrefixes(state.public_meta),
        });
      })
      .catch(() => {
        if (!cancelled) setPublicProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, websiteMode]);

  // HubStars is a public singleton — prefetch on mount (not per-person).
  useEffect(() => {
    if (!websiteMode) return;
    void loadStarsCached(() => fetchHubStars()).catch(() => null);
  }, [websiteMode]);

  // NEW CODE - TESTING: refresh HubRegistry so pin lang/public_meta is current
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    if (!websiteMode || !id) return;
    void loadRegistryCached(() => fetchHubRegistry())
      .then(() => setRegistryTick((n) => n + 1))
      .catch(() => null);
  }, [websiteMode, id]);

  useEffect(() => {
    if (!id) {
      setStarsReady(!websiteMode);
      return;
    }
    if (!websiteMode) {
      setStarsReady(true);
      return;
    }
    let cancelled = false;
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // setStarsReady(false);
    // void fetchHubStars().then(…).finally(() => setStarsReady(true));
    // NEW CODE - TESTING: paint from cache immediately; bound network wait
    const cached = peekCachedStars();
    if (cached) {
      setStarRows(reposStarredBy(cached, id));
      setStarsReady(true);
    } else {
      setStarsReady(false);
    }
    void Promise.race([
      loadStarsCached(() => fetchHubStars()),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ])
      .then((state) => {
        if (cancelled) return;
        if (state) {
          setStarRows(reposStarredBy(state, id));
        } else if (!cached) {
          setStarRows([]);
        }
        setStarsReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          if (!cached) setStarRows([]);
          setStarsReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, websiteMode]);

  // NEW CODE - TESTING: on your own profile, merge delegate keys (unregistered + contributor)
  useEffect(() => {
    if (!id || !isSelf || !websiteMode) {
      setDelegateExtraRows([]);
      setDelegateReposReady(true);
      return;
    }
    // Wait for HubRegistry person seed so we do not flash Unregistered on owned listings
    if (!person && !error) {
      setDelegateReposReady(false);
      return;
    }
    let cancelled = false;
    setDelegateReposReady(false);
    void (async () => {
      try {
        const { nativeListRepos } = await import("../freenet/owner-api");
        const { loadRegistryCached } = await import(
          "../freenet/discover-cache"
        );
        const { fetchHubRegistry } = await import("../freenet/hub-registry");
        const local = await nativeListRepos();
        if (cancelled) return;
        const registry =
          peekCachedRegistry() ??
          (await loadRegistryCached(() => fetchHubRegistry()).catch(
            () => [] as HubRegistration[],
          ));
        if (cancelled) return;
        const ownedPrefixes = new Set(
          (person?.repos ?? []).map((r) => r.repo_prefix),
        );
        const extras: PersonRepoRow[] = [];
        for (const d of local) {
          if (ownedPrefixes.has(d.prefix)) continue;
          const hit = registry.find((r) => r.repo_prefix === d.prefix);
          if (hit) {
            if (isDeletedListing(hit.description)) continue;
            extras.push(rowFromRegistration(hit, id));
          } else {
            extras.push({
              prefix: d.prefix,
              label: d.label,
              name: d.label,
              description: null,
              ownerFingerprint: id,
              role: "owner",
              registration: "unregistered",
              language: null,
              languageColor: null,
            });
          }
        }
        if (!cancelled) setDelegateExtraRows(extras);
      } catch {
        if (!cancelled) setDelegateExtraRows([]);
      } finally {
        if (!cancelled) setDelegateReposReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isSelf, websiteMode, person, error]);

  const labelByPrefix = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of person?.repos ?? []) {
      m.set(r.repo_prefix, r.label);
    }
    return m;
  }, [person]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // publicProfile?.username || (isSelf ? …) || person?.displayName || "Person"
  // NEW CODE - TESTING: never use raw freenet:id: as the profile title
  const displayName =
    publicProfile?.username ||
    (isSelf ? getCachedIdentity()?.name : null) ||
    (person?.displayName && !isFingerprintId(person.displayName)
      ? person.displayName
      : null) ||
    (id ? fingerprintWordsJoined(id) : null) ||
    "Person";
  const peopleTitle = useMemo(() => {
    if (!id) return "Profile";
    if (tab === "repos") {
      return isSelf ? "Your repositories" : `${displayName} / Repositories`;
    }
    if (tab === "stars") {
      return isSelf ? "Stars" : `${displayName} / Stars`;
    }
    // Overview — username (fingerprint-words), GitHub-style
    if (wordSlug && displayName !== wordSlug) {
      return `${displayName} (${wordSlug})`;
    }
    return displayName;
  }, [id, tab, isSelf, displayName, wordSlug]);
  useDocumentTitle(peopleTitle);
  const bio =
    publicProfile?.bio || (isSelf ? selfProfile?.bio ?? "" : "");
  const profileUrl =
    publicProfile?.url || (isSelf ? selfProfile?.url ?? "" : "");
  const avatarUrl =
    publicProfile?.avatar || (isSelf ? selfProfile?.avatar ?? "" : "");
  const vaultId = isSelf ? getSessionVaultId() ?? "" : "";
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const repos = person?.repos ?? [];
  // const overviewRepos = repos.slice(0, 6);
  // NEW CODE - TESTING: registry rows + (self-only) delegate extras with role badges
  const registryRows = useMemo(() => {
    if (!id) return [] as PersonRepoRow[];
    return sortPersonRepoRows(
      (person?.repos ?? [])
        .filter((r) => !isDeletedListing(r.description))
        .map((r) => rowFromRegistration(r, id)),
    );
  }, [person?.repos, id]);

  const repoRows = useMemo(() => {
    if (!isSelf) return registryRows;
    const byPrefix = new Map<string, PersonRepoRow>();
    for (const r of registryRows) byPrefix.set(r.prefix, r);
    for (const r of delegateExtraRows) {
      if (!byPrefix.has(r.prefix)) byPrefix.set(r.prefix, r);
    }
    return sortPersonRepoRows([...byPrefix.values()]);
  }, [registryRows, delegateExtraRows, isSelf]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const overviewRepos = repoRows.slice(0, 6);
  const repos = repoRows;

  // Prefer HubProfile pins; empty until the owner customizes pins.
  const pinnedRows = useMemo(() => {
    const pins = publicProfile?.pinnedPrefixes ?? [];
    if (pins.length === 0) return [] as PersonRepoRow[];
    const byPrefix = new Map(repoRows.map((r) => [r.prefix, r]));
    const out: PersonRepoRow[] = [];
    for (const p of pins) {
      const row = byPrefix.get(p);
      if (row) out.push(row);
      else {
        out.push({
          prefix: p,
          label: p.slice(0, 12),
          name: null,
          description: null,
          ownerFingerprint: id,
          role: "owner",
          registration: "unregistered",
          language: null,
          languageColor: null,
        });
      }
    }
    return out;
  }, [publicProfile?.pinnedPrefixes, repoRows, id]);

  const pinnedCards = useMemo(() => {
    const stars = peekCachedStars();
    // NEW CODE - TESTING: prefer live HubRegistry cache for lang (person.repos can be stale)
    const reg = peekCachedRegistry();
    return pinnedRows.map((r) => {
      const listing = reg?.find((x) => x.repo_prefix === r.prefix);
      const fromReg = parseRegistryLanguage(listing?.public_meta);
      return {
        prefix: r.prefix,
        label: r.label,
        name: r.name,
        description: r.description,
        ownerFingerprint: r.ownerFingerprint,
        language: fromReg?.name ?? r.language,
        languageColor: fromReg?.color ?? r.languageColor,
        starCount: stars ? starCountForRepo(stars, r.prefix) : 0,
        registration: r.registration,
      };
    });
  }, [pinnedRows, starsReady, starRows, registryTick]);

  const savePinnedOrder = (prefixes: string[]) => {
    if (!isSelf || pinBusy) return;
    setPublicProfile((prev) =>
      prev ? { ...prev, pinnedPrefixes: prefixes } : prev,
    );
    setPinBusy(true);
    setPinError(null);
    void updatePublicProfile({
      vault_id: vaultId || getSessionVaultId() || "",
      pinnedPrefixes: prefixes,
    })
      .catch((e) => {
        setPinError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPinBusy(false));
  };

  const pinCandidates = useMemo(
    () =>
      repoRows.map((r) => ({
        prefix: r.prefix,
        title: r.name?.trim() || r.label,
      })),
    [repoRows],
  );

  const statusEmoji = publicProfile?.statusEmoji ?? "";
  const statusText = publicProfile?.statusText ?? "";

  // Prefer clean word-slug URLs; rewrite bare freenet:id: and strip legacy ?fp=.
  if (shouldCanonicalize && id) {
    return (
      <Navigate
        to={peoplePath(id, tab === "overview" ? undefined : { tab })}
        replace
      />
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (id && !fpHint && !isFingerprintId(rawRef)) {
  //   return <Navigate to={peoplePath(id, …)} replace />;  // injected ?fp=
  // }
  // NEW CODE - TESTING: strip legacy ?fp= once we have a resolved id
  if (shouldStripFp && id) {
    return (
      <Navigate
        to={peoplePath(id, tab === "overview" ? undefined : { tab })}
        replace
      />
    );
  }

  if (resolveError) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return (
    //   <main className="page profile-page">
    //     <div className="error-banner">{resolveError}</div>
    //   </main>
    // );
    // NEW CODE - TESTING
    if (looksLikePersonNotFound(resolveError)) {
      return (
        <NotFoundPage kind="person" detail={rawRef || resolveError} />
      );
    }
    return (
      <main className="page profile-page">
        <div className="error-banner">{resolveError}</div>
      </main>
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (!id || (!person && !error)) {
  //   return (
  //     <main className="page profile-page">
  //       <PageLoadingOverlay skeleton="people" message="" />
  //     </main>
  //   );
  // }
  // NEW CODE - TESTING: only wait for fingerprint resolve — HubRegistry/person is optional
  if (!id) {
    return (
      <main className="page profile-page">
        <PageLoadingOverlay skeleton="people" message="" />
      </main>
    );
  }

  if (error && !person && looksLikePersonNotFound(error)) {
    return <NotFoundPage kind="person" detail={wordSlug || id || rawRef} />;
  }

  const reposLoading = !person && !error;

  return (
    <main className="page profile-page">
      {error ? <div className="error-banner">{error}</div> : null}

      <div className="profile-layout">
        <aside className="profile-sidebar">
          <div className="profile-avatar-wrap">
            <ProfileAvatar
              fingerprint={id}
              vaultId={vaultId}
              avatarUrl={avatarUrl || null}
              size={120}
              className="profile-avatar"
              title={displayName}
            />
            {isSelf ? (
              <button
                type="button"
                className="profile-status-badge profile-status-badge--btn"
                title={statusText || "Set status"}
                aria-label="Edit status"
                onClick={() => setStatusModalOpen(true)}
              >
                {statusEmoji || "☺"}
              </button>
            ) : statusEmoji || statusText ? (
              <span
                className="profile-status-badge"
                title={statusText || undefined}
              >
                {statusEmoji || "☺"}
              </span>
            ) : null}
          </div>
          <h1 className="profile-name">{displayName}</h1>
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <p className="mono muted tiny profile-fp break">{id}</p>
          */}
          {/* NEW CODE - TESTING: Mail-style fingerprint words under username */}
          <p className="mono muted tiny profile-fp break" title={id}>
            {wordSlug}
          </p>
          {statusText ? (
            <p className="profile-status-text muted tiny">{statusText}</p>
          ) : null}
          {isSelf ? (
            <Link className="btn secondary profile-edit" to="/identity">
              Edit profile
            </Link>
          ) : null}
          {bio ? <p className="profile-bio">{bio}</p> : null}
          {profileUrl ? (
            <p className="profile-link">
              <a href={profileUrl} target="_blank" rel="noreferrer">
                {profileUrl.replace(/^https?:\/\//, "")}
              </a>
            </p>
          ) : null}
          {person?.note ? (
            <p className="muted tiny">{person.note}</p>
          ) : null}
          <dl className="profile-stats">
            <div>
              <dt>Repositories</dt>
              <dd>{repos.length}</dd>
            </div>
            <div>
              <dt>Stars</dt>
              <dd>{websiteMode ? starRows.length : "—"}</dd>
            </div>
          </dl>
        </aside>

        <div className="profile-main">
          {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
          <nav className="profile-tabs" aria-label="Profile sections">
            … Overview / Repositories / Stars on page …
          </nav>
          */}
          {/* NEW CODE - TESTING: tabs live in site header (PeopleSiteNav) */}

          {tab === "overview" ? (
            <section className="profile-panel">
              <div className="profile-pinned-head">
                <h2>Pinned</h2>
                {isSelf && websiteMode ? (
                  <button
                    type="button"
                    className="profile-customize-pins"
                    onClick={() => {
                      setPinError(null);
                      setPinModalOpen(true);
                    }}
                  >
                    Customize your pins
                  </button>
                ) : null}
              </div>
              {pinError ? (
                <p className="error tiny">{pinError}</p>
              ) : null}
              {reposLoading ? (
                <p className="muted">Loading…</p>
              ) : pinnedRows.length > 0 ? (
                <PinnedReposGrid
                  cards={pinnedCards}
                  canReorder={isSelf && websiteMode}
                  showLangPending={isSelf && websiteMode}
                  onReorder={savePinnedOrder}
                  empty="No pinned repositories."
                />
              ) : (
                <p className="muted">
                  {isSelf
                    ? "No pinned repositories yet — customize your pins to feature up to six repos here."
                    : "No pinned repositories."}
                </p>
              )}
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              <h3 className="profile-subhead">Repositories</h3>
              <RepoList rows={overviewRepos} ... />
              */}
              {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
              {!reposLoading && repos.length > 0 ? (
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: "1rem" }}
                  onClick={() => selectTab("repos")}
                >
                  View all repositories
                </button>
              ) : null}
              */}
            </section>
          ) : null}

          {tab === "repos" ? (
            <section className="profile-panel">
              <h2>Repositories</h2>
              {isSelf ? (
                <p className="muted">
                  Registered listings from HubRegistry, plus unregistered repos
                  held in your identity on this device (only you see those).
                  Local backups share storage with Stars (starring your own repo
                  does not duplicate tip packs).
                </p>
              ) : null}
              {reposLoading ? (
                <p className="muted">Loading repositories…</p>
              ) : (
                <RepoList
                  rows={repos}
                  showBackup={isSelf && websiteMode}
                  empty={
                    isSelf
                      ? "No repositories in HubRegistry or your local identity yet."
                      : "No HubRegistry listings for this identity yet."
                  }
                />
              )}
              {isSelf && !delegateReposReady ? (
                <p className="muted tiny">Checking local identity repos…</p>
              ) : null}
            </section>
          ) : null}

          {tab === "stars" ? (
            <section className="profile-panel">
              <h2>Stars</h2>
              {!websiteMode ? (
                <p className="muted">
                  Stars are available on the Freenet-hosted website.
                </p>
              ) : !starsReady ? (
                <PageLoadingOverlay skeleton="cards" message="" />
              ) : starRows.length === 0 ? (
                <p className="muted">No public stars for this identity yet.</p>
              ) : (
                <>
                  <ul className="repo-cards">
                    {starRows.map((s) => {
                      const reg = peekCachedRegistry()?.find(
                        (r) => r.repo_prefix === s.repo_prefix,
                      );
                      const label =
                        s.label || labelByPrefix.get(s.repo_prefix) || "repo";
                      const title = reg?.name?.trim() || label;
                      const regOwner = reg?.identity_fingerprint ?? null;
                      const opts = regOwner
                        ? { ownerFingerprint: regOwner }
                        : undefined;
                      return (
                        <li key={s.repo_prefix}>
                          <div className="repo-card">
                            <div className="repo-card-title-row">
                              <Link
                                to={repoHref(s.repo_prefix, label, "", opts)}
                                className="repo-card-title-link"
                              >
                                <strong>
                                  {title} <span className="muted">★</span>
                                </strong>
                              </Link>
                              <span className="repo-card-badges">
                                {isSelf ? (
                                  <RepoProtectChrome
                                    prefix={s.repo_prefix}
                                    reason="star"
                                  />
                                ) : null}
                              </span>
                            </div>
                            <Link
                              to={repoHref(s.repo_prefix, label, "", opts)}
                              className="repo-card-body-link"
                            >
                              <span className="mono">
                                {repoPathDisplay(s.repo_prefix, label, opts)}
                              </span>
                              <span className="muted tiny">{s.starred_at}</span>
                            </Link>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>
          ) : null}
        </div>
      </div>
      {statusModalOpen && isSelf ? (
        <EditStatusModal
          initialEmoji={statusEmoji}
          initialText={statusText}
          onClose={() => setStatusModalOpen(false)}
          onSaved={(emoji, text) => {
            setPublicProfile((prev) =>
              prev
                ? { ...prev, statusEmoji: emoji, statusText: text }
                : {
                    bio: bio || "",
                    url: profileUrl || "",
                    avatar: avatarUrl || "",
                    username: displayName,
                    statusText: text,
                    statusEmoji: emoji,
                    pinnedPrefixes: [],
                  },
            );
          }}
        />
      ) : null}
      {pinModalOpen && isSelf ? (
        <EditPinnedModal
          candidates={pinCandidates}
          initialPinned={publicProfile?.pinnedPrefixes ?? []}
          busy={pinBusy}
          onClose={() => {
            if (!pinBusy) setPinModalOpen(false);
          }}
          onSave={async (prefixes) => {
            setPinBusy(true);
            setPinError(null);
            try {
              await updatePublicProfile({
                vault_id: vaultId || getSessionVaultId() || "",
                pinnedPrefixes: prefixes,
              });
              setPublicProfile((prev) =>
                prev
                  ? { ...prev, pinnedPrefixes: prefixes }
                  : {
                      bio: bio || "",
                      url: profileUrl || "",
                      avatar: avatarUrl || "",
                      username: displayName,
                      statusText,
                      statusEmoji,
                      pinnedPrefixes: prefixes,
                    },
              );
              setPinModalOpen(false);
            } catch (e) {
              setPinError(e instanceof Error ? e.message : String(e));
            } finally {
              setPinBusy(false);
            }
          }}
        />
      ) : null}
    </main>
  );
}
