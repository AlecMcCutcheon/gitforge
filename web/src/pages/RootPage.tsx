import { useEffect, useState } from "react";
import {
  currentIdentity,
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { DiscoverPage } from "./HomePage";
import { LandingPage } from "./LandingPage";

/**
 * `/` — marketing landing when signed out; Discover dashboard when signed in.
 */
export function RootPage() {
  const cachedAtStart = getCachedIdentity() != null;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Blocked the whole route on currentIdentity() even when sessionStorage had
  // an identity — felt fine on SPA nav (warm memory) but slow on hard refresh.
  // NEW CODE - TESTING: paint from session cache immediately; reconcile after.
  const [ready, setReady] = useState(true);
  const [signedIn, setSignedIn] = useState(cachedAtStart);
  const [probing, setProbing] = useState(!cachedAtStart);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await currentIdentity();
        if (!cancelled) {
          setSignedIn(Boolean(id ?? getCachedIdentity()));
        }
      } finally {
        if (!cancelled) {
          setProbing(false);
          setReady(true);
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

  // No session hint yet — briefly wait for the first identity probe so we don’t
  // flash Discover for signed-out visitors.
  if (!ready || (probing && !signedIn && !cachedAtStart)) {
    return (
      <PageLoadingOverlay
        skeleton={signedIn || cachedAtStart ? "discover" : "landing"}
        message=""
      />
    );
  }

  return signedIn ? <DiscoverPage /> : <LandingPage />;
}
