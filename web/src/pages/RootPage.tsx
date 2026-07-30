import { useEffect, useState } from "react";
import {
  currentIdentity,
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING (only used by gated skeleton path)
// import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { DiscoverPage } from "./HomePage";
import { LandingPage } from "./LandingPage";

/**
 * `/` — marketing landing when signed out; Discover dashboard when signed in.
 */
export function RootPage() {
  const cachedAtStart = getCachedIdentity() != null;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Held landing/discover skeletons until GetIdentity finished (~12–24s after
  // wipe when the identity delegate is cold/missing). Site assets were fine;
  // the SPA gate made `/` feel broken.
  // const [ready, setReady] = useState(true);
  // const [signedIn, setSignedIn] = useState(cachedAtStart);
  // const [probing, setProbing] = useState(!cachedAtStart);
  // …probe then:
  // if (!ready || (probing && !signedIn && !cachedAtStart)) {
  //   return <PageLoadingOverlay skeleton={…} message="" />;
  // }
  // NEW CODE - TESTING: paint Landing/Discover immediately from session hint;
  // identity probe upgrades/downgrades in the background.
  const [signedIn, setSignedIn] = useState(cachedAtStart);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await currentIdentity();
        if (!cancelled) {
          setSignedIn(Boolean(id ?? getCachedIdentity()));
        }
      } catch {
        if (!cancelled) {
          setSignedIn(Boolean(getCachedIdentity()));
        }
      }
    })();
    const unsub = onAuthSessionChange(() => {
      setSignedIn(Boolean(getCachedIdentity()));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return signedIn ? <DiscoverPage /> : <LandingPage />;
}
