import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { NavLink } from "./spa-link";
import { useEffect, useState } from "react";
import { api, type HealthResponse } from "./api";
import { AccountHeaderLink } from "./components/AccountHeaderLink";
import { BrandLogo } from "./components/BrandLogo";
import { PeopleSiteNav, usePeopleRoute } from "./components/PeopleSiteNav";
import { RepoSiteNav, useRepoRoute } from "./components/RepoSiteNav";
import { ProtectWorker } from "./components/ProtectWorker";
import { PublicGoodsDutyWorker } from "./components/PublicGoodsDutyWorker";
import { AccountPage } from "./pages/AccountPage";
import { DocsPage } from "./pages/DocsPage";
import { InboxPage } from "./pages/InboxPage";
import { ImportRepoPage } from "./pages/ImportRepoPage";
import { NewRepoPage } from "./pages/NewRepoPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PeoplePage } from "./pages/PeoplePage";
import { RawEntryPage } from "./pages/RawEntryPage";
import { RepoPage } from "./pages/RepoPage";
import { RootPage } from "./pages/RootPage";
import { WorkRedirect } from "./pages/WorkRedirect";
import { peekRawQueryPath } from "./freenet/raw-entry";
import { brand } from "./lib/brand";
import { isBrowserNativeMode } from "./tip-browse";

export function App() {
  const location = useLocation();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [identityOk, setIdentityOk] = useState<boolean | null>(null);
  const websiteMode = isBrowserNativeMode();
  const repoRoute = useRepoRoute();
  // NEW CODE - TESTING: Overview/Repos/Stars under GitForge like repo tabs
  const peopleRoute = usePeopleRoute();
  // GitForge-safe raw entry (?raw= on website root) or deep /raw/ (in-session).
  const rawQuery = peekRawQueryPath(location.search);
  const isRawRoute = Boolean(rawQuery) || /(^|\/)raw\//.test(location.pathname);

  useEffect(() => {
    if (websiteMode) {
      setIdentityOk(null);
      setHealth(null);
      return;
    }
    void Promise.all([api.health(), api.identity()])
      .then(([h, id]) => {
        setHealth(h);
        setIdentityOk(id.ok);
      })
      .catch(() => {
        setHealth(null);
        setIdentityOk(null);
      });
  }, [websiteMode]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Redirect ?raw= to freenet-core /v1/git/.../raw (non-stock nodes only)
  // NEW CODE - TESTING: SPA RawEntryPage on GitForge (works on any node)
  if (rawQuery) {
    return (
      <div className="shell shell--raw">
        <RawEntryPage />
      </div>
    );
  }

  return (
    <div className={`shell${isRawRoute ? " shell--raw" : ""}`}>
      {websiteMode ? <ProtectWorker /> : null}
      {/* Delayed, non-blocking contribution through existing service-owned delegates. */}
      {websiteMode ? <PublicGoodsDutyWorker /> : null}
      {!isRawRoute ? (
      <header className="site-header">
        <div className="topnav">
          <NavLink to="/" className="brand-link" end>
            <BrandLogo size={32} className="brand-logo" />
            <span className="brand-mark">{brand.displayName}</span>
          </NavLink>
          {websiteMode ? (
            <AccountHeaderLink />
          ) : (
            <div className="status-cluster">
              <span
                className={`pill ${health?.node.ok ? "ok" : "bad"}`}
              >
                Node {health?.node.ok ? "up" : "down"}
              </span>
              <span
                className={`pill ${health?.tools.freenetGit ? "ok" : "bad"}`}
              >
                freenet-git
              </span>
              <span className={`pill ${identityOk ? "ok" : "bad"}`}>
                Identity {identityOk ? "ready" : "missing"}
              </span>
            </div>
          )}
        </div>
        {repoRoute ? <RepoSiteNav route={repoRoute} /> : null}
        {/* NEW CODE - TESTING: profile tabs in site header under brand */}
        {!repoRoute && peopleRoute ? (
          <PeopleSiteNav route={peopleRoute} />
        ) : null}
      </header>
      ) : null}

      <Routes>
        <Route path="/" element={<RootPage />} />
        <Route path="/work" element={<WorkRedirect />} />
        <Route path="/new" element={<NewRepoPage />} />
        <Route path="/import" element={<ImportRepoPage />} />
        <Route path="/identity" element={<AccountPage />} />
        <Route path="/account" element={<Navigate to="/identity" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:slug" element={<DocsPage />} />
        <Route path="/people/:fingerprint" element={<PeoplePage />} />
        <Route path="/r/:repoId/*" element={<RepoPage />} />
        <Route path="/:ownerSlug/:repoId/*" element={<RepoPage />} />
        <Route path="/:repoId/*" element={<RepoPage />} />
        <Route path="*" element={<NotFoundPage kind="page" />} />
      </Routes>
    </div>
  );
}
