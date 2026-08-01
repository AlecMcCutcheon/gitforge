import { useEffect } from "react";
import { isBrowserNativeMode } from "../tip-browse";
import { currentIdentity, getCachedIdentity, onAuthSessionChange } from "../freenet/auth-api";
import { getPublicGoodIdentity } from "../freenet/public-goods";
import { computeDutyReadiness } from "../freenet/public-goods-duty";
import { watchKairosNetworkDuty } from "../freenet/kairos-duty";
import { watchTycheDuty } from "../freenet/tyche-duty";
import {
  getPublicGoodsAuthorizations,
  getPublicGoodsConsent,
  onPublicGoodsConsentChange,
  type PublicGoodsConsent,
} from "../freenet/public-goods-consent";

const START_DELAY_MS = 6_000;

/**
 * GitForge participates only after the user explicitly enables each service in
 * Settings → Public goods. The workers use GetIdentity and service-owned
 * signing delegates; they never call EnsureIdentity and never block the shell.
 */
export function PublicGoodsDutyWorker() {
  useEffect(() => {
    if (!isBrowserNativeMode()) return;

    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    let stopKairos: (() => void) | null = null;
    let stopTyche: (() => void) | null = null;
    let startGeneration = 0;

    const stop = (service?: "kairos" | "tyche") => {
      if (!service || service === "kairos") {
        stopKairos?.();
        stopKairos = null;
      }
      if (!service || service === "tyche") {
        stopTyche?.();
        stopTyche = null;
      }
    };

    const start = async (consent: PublicGoodsConsent, generation: number) => {
      if (cancelled) return;
      const forgeIdentity = getCachedIdentity();
      const authorizations = getPublicGoodsAuthorizations();
      const [kairosIdentity, tycheIdentity] = await Promise.all([
        consent.kairos ? getPublicGoodIdentity("kairos") : Promise.resolve(null),
        consent.tyche ? getPublicGoodIdentity("tyche") : Promise.resolve(null),
      ]);
      if (cancelled || generation !== startGeneration) return;
      const { kairos: kairosReady, tyche: tycheReady } = computeDutyReadiness({
        consent,
        authorizations,
        forgeFingerprint: forgeIdentity?.fingerprint ?? null,
        kairosIdentity,
        tycheIdentity,
      });
      if (!kairosReady) stop("kairos");
      if (!tycheReady) stop("tyche");
      if (kairosReady && !stopKairos) {
        stopKairos = watchKairosNetworkDuty({
          onDuty: (result, reason) => {
            if (result.errors?.length) {
              console.warn("[gitforge] Kairos duty:", result.errors.map((entry) => entry.error).join("; "));
            } else if (result.pulsed || result.observed.length) {
              console.debug("[gitforge] Kairos public-good duty", reason, result.plan?.summary);
            }
          },
          onError: (error) => console.debug("[gitforge] Kairos duty unavailable", error),
        });
      }
      if (tycheReady && !stopTyche) {
        stopTyche = watchTycheDuty({
          onDuty: (result, reason) => {
            if (result.errors?.length) {
              console.warn("[gitforge] Tyche duty:", result.errors.map((entry) => entry.error).join("; "));
            } else if (result.pulsed || result.committed.length || result.revealed.length) {
              console.debug("[gitforge] Tyche public-good duty", reason, result.plan?.summary);
            }
          },
          onError: (error) => console.debug("[gitforge] Tyche duty unavailable", error),
        });
      }
    };

    const applyConsent = (consent: PublicGoodsConsent) => {
      if (cancelled) return;
      const authorizations = getPublicGoodsAuthorizations();
      const forgeIdentity = getCachedIdentity();
      // The app-shell identity probe can complete before this worker mounts (or
      // fail once while the websocket reconnects), so a session event is not a
      // reliable reload re-trigger. Actively probe when the identity is missing
      // and re-apply once it lands.
      if (!forgeIdentity) {
        void currentIdentity()
          .then((id) => {
            if (!cancelled && id) applyConsent(getPublicGoodsConsent());
          })
          .catch(() => undefined);
        return;
      }
      const kairosAllowed = Boolean(
        forgeIdentity &&
        consent.kairos &&
        authorizations.kairos?.background_enabled &&
        authorizations.kairos.gitforge_identity_fingerprint === forgeIdentity.fingerprint,
      );
      const tycheAllowed = Boolean(
        forgeIdentity &&
        consent.tyche &&
        authorizations.tyche?.background_enabled &&
        authorizations.tyche.gitforge_identity_fingerprint === forgeIdentity.fingerprint,
      );
      if (!kairosAllowed) stop("kairos");
      if (!tycheAllowed) stop("tyche");
      startGeneration += 1;
      void start({ kairos: kairosAllowed, tyche: tycheAllowed }, startGeneration);
    };

    const onConsent = onPublicGoodsConsentChange(applyConsent);
    // The Freenet website sandbox often denies sessionStorage, so on a hard
    // reload the session identity is null until currentIdentity() lands. Re-run
    // the readiness gate when it does, otherwise contribution never restarts
    // after a reload even with consent + vault records intact.
    const onSession = onAuthSessionChange(() => {
      if (cancelled) return;
      applyConsent(getPublicGoodsConsent());
    });
    startTimer = setTimeout(() => {
      startTimer = null;
      applyConsent(getPublicGoodsConsent());
    }, START_DELAY_MS);

    return () => {
      cancelled = true;
      if (startTimer) clearTimeout(startTimer);
      onConsent();
      onSession();
      stop();
    };
  }, []);

  return null;
}
