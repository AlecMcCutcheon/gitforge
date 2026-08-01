/**
 * Always-mounted public-goods worker: Kairos network duty (soft-Get /
 * Subscribe / pulse / observe). Must never block SPA load — delayed start,
 * all errors swallowed to console.
 *
 * The worker is retained for compatibility with older imports. New mounts
 * use PublicGoodsDutyWorker, which addresses the existing Kairos delegate
 * directly and never derives a witness from the GitForge identity.
 */
import { useEffect } from "react";
import { onAuthSessionChange, getCachedIdentity } from "../freenet/auth-api";
import { watchKairosNetworkDuty } from "../freenet/kairos-duty";
import { isBrowserNativeMode } from "../tip-browse";

/** Let first paint + identity settle before touching Kairos. */
const START_DELAY_MS = 6_000;

export function KairosDutyWorker() {
  useEffect(() => {
    if (!isBrowserNativeMode()) return;

    let stop: (() => void) | null = null;
    let cancelled = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;

    const startWatch = () => {
      stop?.();
      stop = null;
      if (cancelled) return;
      // NEW CODE - TESTING: fire-and-forget watch; never await in render path
      stop = watchKairosNetworkDuty({
        onDuty: (result, reason) => {
          if (result.skipped) {
            if (reason === "initial" || reason === "interval") {
              console.debug(
                "[gitforge] kairos duty skipped:",
                result.skipped,
                reason,
              );
            }
            return;
          }
          if (result.errors?.length) {
            console.warn(
              "[gitforge] kairos duty errors:",
              result.errors.map((e) => e.error).join("; "),
            );
          } else if (result.pulsed || result.observed.length) {
            console.debug(
              "[gitforge] kairos duty",
              reason,
              result.plan?.summary,
              result.identity?.source,
            );
          }
        },
        onError: (err) => {
          console.warn(
            "[gitforge] kairos duty:",
            err instanceof Error ? err.message : err,
          );
        },
      });
    };

    const scheduleStart = (delayMs: number) => {
      if (startTimer) clearTimeout(startTimer);
      startTimer = setTimeout(() => {
        startTimer = null;
        if (!cancelled) startWatch();
      }, delayMs);
    };

    scheduleStart(START_DELAY_MS);

    // Re-bind when sign-in lands only to refresh the non-creating watcher.
    const unsubAuth = onAuthSessionChange(() => {
      if (cancelled) return;
      if (getCachedIdentity()) scheduleStart(1_500);
    });

    return () => {
      cancelled = true;
      unsubAuth();
      if (startTimer) clearTimeout(startTimer);
      stop?.();
    };
  }, []);

  return null;
}
