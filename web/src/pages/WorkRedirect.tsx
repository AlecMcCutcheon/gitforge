import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  currentIdentity,
  getCachedIdentity,
} from "../freenet/auth-api";
import { peoplePath } from "../freenet/fingerprint-words";
import { PageLoadingOverlay } from "../components/PageLoadingOverlay";
import { isBrowserNativeMode } from "../tip-browse";
import { useDocumentTitle } from "../lib/document-title";

/**
 * /work is retired (profile Overview / Repositories replace it).
 * Redirect signed-in users to their profile; others to home.
 */
export function WorkRedirect() {
  useDocumentTitle("Your repositories");
  const websiteMode = isBrowserNativeMode();
  const cached = getCachedIdentity();
  const [fp, setFp] = useState(cached?.fingerprint ?? null);
  const [ready, setReady] = useState(!websiteMode || cached != null);

  useEffect(() => {
    if (!websiteMode) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void currentIdentity()
      .then((id) => {
        if (!cancelled) setFp(id?.fingerprint ?? null);
      })
      .catch(() => {
        if (!cancelled) setFp(getCachedIdentity()?.fingerprint ?? null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [websiteMode]);

  if (!ready) {
    return <PageLoadingOverlay skeleton="auth" message="" />;
  }
  if (fp) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return <Navigate to={`/people/${encodeURIComponent(fp)}`} replace />;
    // NEW CODE - TESTING
    return <Navigate to={peoplePath(fp)} replace />;
  }
  return <Navigate to="/" replace />;
}
