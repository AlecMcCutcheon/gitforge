import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "../spa-link";
import { api, type DemoRepo, type ForgeRegistration } from "../api";
import { StarCountBadge } from "../components/StarButton";
import { PersonName } from "../components/PersonName";
import { EMBEDDED_DEMOS } from "../demos";
import {
  peekCachedRegistry,
  storeCachedRegistry,
} from "../freenet/discover-cache";
import {
  isFingerprintId,
  looksLikeWordSlug,
  peoplePath,
} from "../freenet/fingerprint-words";
import { resolvePersonRef } from "../freenet/people-resolve";
import { prefetchPersonDisplayNames } from "../freenet/person-display";
import {
  parseForgeRepoRef,
  repoHref,
  repoPathDisplay,
} from "../lib/repo-path";
import { brand, registryLabel } from "../lib/brand";
import { isBrowserNativeMode } from "../tip-browse";
import { useDocumentTitle } from "../lib/document-title";

export function HomePage() {
  useDocumentTitle("Discover");
  const navigate = useNavigate();
  const websiteMode = isBrowserNativeMode();
  const [demos, setDemos] = useState<DemoRepo[]>(EMBEDDED_DEMOS as DemoRepo[]);
  const [registered, setRegistered] = useState<ForgeRegistration[]>(
    () => peekCachedRegistry() ?? [],
  );
  const [registryLoading, setRegistryLoading] = useState(
    () => peekCachedRegistry() == null,
  );
  const [registryNote, setRegistryNote] = useState<string | null>(null);
  const [cached, setCached] = useState<
    Array<{ cacheKey: string; path: string; remote?: string }>
  >([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Blocked the whole page until demos + cache + registry all finished.
    // NEW CODE - TESTING: paint embedded demos immediately; registry fills in.

    if (!websiteMode) {
      void api
        .demos()
        .then((d) => {
          if (!cancelled) setDemos(d.demos);
        })
        .catch(() => {
          if (!cancelled) setDemos(EMBEDDED_DEMOS as DemoRepo[]);
        });
      void api
        .cache()
        .then((c) => {
          if (!cancelled) setCached(c.repos);
        })
        .catch(() => {
          if (!cancelled) setCached([]);
        });
    }

    void api
      .registry()
      .then((reg) => {
        if (cancelled) return;
        setRegistered(reg.repos);
        storeCachedRegistry(reg.repos);
        setRegistryNote(reg.note ?? null);
        // NEW CODE - TESTING: warm ForgeProfile usernames for Discover cards
        void prefetchPersonDisplayNames(
          reg.repos.map((r) => r.identity_fingerprint),
        );
      })
      .catch(() => {
        if (cancelled) return;
        if (peekCachedRegistry() == null) {
          setRegistered([]);
          setRegistryNote(null);
        }
      })
      .finally(() => {
        if (!cancelled) setRegistryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteMode]);

  const go = (raw: string) => {
    const trimmed = raw.trim();
    if (isFingerprintId(trimmed) || looksLikeWordSlug(trimmed)) {
      setError(null);
      void resolvePersonRef(trimmed).then((res) => {
        if (!res.ok) {
          setError(res.error);
          return;
        }
        void navigate(peoplePath(res.fingerprint));
      });
      return;
    }
    const parsed = parseForgeRepoRef(trimmed);
    if (!parsed) {
      setError(
        "Use freenet::prefix/label, freenet:id:…, or fingerprint words (apple-banana-…)",
      );
      return;
    }
    setError(null);
    void navigate(repoHref(parsed.prefix, parsed.label));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(query);
  };

  const seedPrefixes = new Set(
    demos
      .map((d) => parseForgeRepoRef(d.url)?.prefix)
      .filter((p): p is string => Boolean(p)),
  );
  const registryOnly = registered.filter(
    (r) =>
      !seedPrefixes.has(r.repo_prefix) &&
      !(r.description ?? "").trim().toLowerCase().startsWith("[deleted]"),
  );

  return (
    <main className="page">
      <section className="hero-panel">
        <h1>{brand.displayName}</h1>
        <p>
          Browse Freenet-hosted git repositories. Open a repo like GitHub —
          files and commits load from Freenet on demand.
        </p>
        <form className="search-row" onSubmit={onSubmit}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="repo path, freenet:id:…, or fingerprint-words"
          />
          <button type="submit" className="btn">
            Open
          </button>
        </form>
        {error ? <div className="error-banner">{error}</div> : null}
      </section>

      <section className="panel">
        <h2>Official repositories</h2>
        <p className="lede">Always-visible Freenet mirrors curated for {brand.displayName}.</p>
        <ul className="repo-cards">
          {demos.map((demo) => {
            const parsed = parseForgeRepoRef(demo.url);
            if (!parsed) return null;
            return (
              <li key={demo.url}>
                <Link to={repoHref(parsed.prefix, parsed.label)} className="repo-card">
                  <strong>
                    {demo.name} <StarCountBadge prefix={parsed.prefix} />
                  </strong>
                  <span className="muted">{demo.description}</span>
                  <span className="mono">
                    {repoPathDisplay(parsed.prefix, parsed.label)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>{registryLabel()}</h2>
        <p className="lede">
          Public listings registered on {brand.registryName} — additive to official
          repositories.
          {registryNote ? ` ${registryNote}` : null}
        </p>
        {registryLoading && registryOnly.length === 0 ? (
          <p className="muted">Loading {brand.registryName}…</p>
        ) : registryOnly.length === 0 ? (
          <p className="muted">
            No {brand.registryAbbrev} registrations yet. Create a repo from{" "}
            <Link to="/new">New repository</Link>
            {" "}or{" "}
            <Link to="/import">Import repository</Link>
            {" "}(header +) to list it here.
          </p>
        ) : (
          <ul className="repo-cards">
            {registryOnly.map((r) => (
              <li key={r.repo_prefix}>
                <div className="repo-card">
                  <Link to={repoHref(r.repo_prefix, r.label, "", { ownerFingerprint: r.identity_fingerprint })}>
                    <strong>
                      {r.name ?? r.label}{" "}
                      <StarCountBadge prefix={r.repo_prefix} />
                    </strong>
                  </Link>
                  <span className="muted">
                    {r.description ?? (
                      <>
                        by{" "}
                        <PersonName
                          fingerprint={r.identity_fingerprint}
                          link
                        />
                      </>
                    )}
                  </span>
                  <span className="mono">
                    {repoPathDisplay(r.repo_prefix, r.label, { ownerFingerprint: r.identity_fingerprint })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {cached.length > 0 ? (
        <section className="panel">
          <h2>Recently opened</h2>
          <ul className="repo-cards">
            {cached.map((repo) => {
              const parsed = repo.remote ? parseForgeRepoRef(repo.remote) : null;
              if (!parsed) return null;
              return (
                <li key={repo.cacheKey}>
                  <Link
                    to={repoHref(parsed.prefix, parsed.label)}
                    className="repo-card"
                  >
                    <strong>{parsed.label}</strong>
                    <span className="mono">
                      {repoPathDisplay(parsed.prefix, parsed.label)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

/** Signed-in dashboard (official + GitForge Registry / GFR listings). */
export { HomePage as DiscoverPage };
