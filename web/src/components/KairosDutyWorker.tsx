/**
 * Always-mounted public-goods worker: Kairos network duty (soft-Get /
 * Subscribe / pulse / observe). Must never block SPA load — delayed start,
 * all errors swallowed to console.
 */
import { useEffect } from "react";
import { watchKairosNetworkDuty } from "../freenet/kairos-duty";
import { isBrowserNativeMode } from "../tip-browse";

/** Let first paint + identity settle before touching Kairos. */
const START_DELAY_MS = 6_000;

export function KairosDutyWorker() {
  useEffect(() => {
    if (!isBrowserNativeMode()) return;

    let stop: (() => void) | null = null;
    let cancelled = false;
    const startTimer = setTimeout(() => {
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
    }, START_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      stop?.();
    };
  }, []);

  return null;
}
