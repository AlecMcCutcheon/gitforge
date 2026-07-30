/**
 * Always-mounted background worker: account heal, quiet vault sync,
 * owner repo contract provision, backup queue.
 * Work lives in module-level freenet helpers so SPA navigation does not abort it.
 */
import { useEffect, useRef } from "react";
import {
  getCachedIdentity,
  onAuthSessionChange,
} from "../freenet/auth-api";
import { runAccountHealthPass } from "../freenet/account-heal";
import { runOwnerReposProvisionPass, ensureOwnerProvisionTipListener } from "../freenet/forge-repo";
import {
  ensureBackupTipPushListener,
  getBackupPrefs,
  hydrateBackupPrefsFromIdentity,
  onBackupPrefsChange,
  runGlobalBackupPass,
} from "../freenet/repo-backup";
import { isBrowserNativeMode } from "../tip-browse";

/** First pass shortly after sign-in / restore; then periodic. */
const START_DELAY_MS = 4_000;
const PASS_INTERVAL_MS = 10 * 60 * 1000;

export function RepoBackupWorker() {
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isBrowserNativeMode()) return;

    // NEW CODE - TESTING: tip push → backup refresh + ForgeRepoMeta ensure
    // without waiting for 10m pass or for a specific page to be open.
    ensureBackupTipPushListener();
    ensureOwnerProvisionTipListener();

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let startTimer: ReturnType<typeof setTimeout> | null = null;

    const stopPass = () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };

    const kick = (delayMs: number) => {
      if (startTimer) clearTimeout(startTimer);
      startTimer = setTimeout(() => {
        void runOnce();
      }, delayMs);
    };

    const runOnce = async () => {
      if (cancelled || runningRef.current) return;
      if (!getCachedIdentity()) return;
      runningRef.current = true;
      stopPass();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        // Account health (+ quiet vault sync) first — independent of backup prefs.
        await runAccountHealthPass({
          signal: ac.signal,
          syncVault: true,
        });
        if (ac.signal.aborted) return;

        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // Missing ForgeRegistry / ForgeRepoMeta only got fixed when opening a repo page.
        // NEW CODE - TESTING: provision all owned repos after login/restore here
        await runOwnerReposProvisionPass({ signal: ac.signal });
        if (ac.signal.aborted) return;

        const prefs = getBackupPrefs();
        if (
          prefs.autoUpdateExisting ||
          prefs.autoBackupOwnRepos ||
          prefs.autoBackupStars
        ) {
          await runGlobalBackupPass({ signal: ac.signal });
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === "aborted")) {
          console.warn("[freenet-forge] RepoBackupWorker pass failed", err);
        }
      } finally {
        runningRef.current = false;
      }
    };

    void hydrateBackupPrefsFromIdentity().then(() => {
      if (cancelled) return;
      if (getCachedIdentity()) kick(START_DELAY_MS);
    });

    const unsubAuth = onAuthSessionChange(() => {
      if (cancelled) return;
      if (getCachedIdentity()) {
        void hydrateBackupPrefsFromIdentity();
        kick(START_DELAY_MS);
      } else {
        stopPass();
      }
    });

    const unsubPrefs = onBackupPrefsChange(() => {
      if (cancelled) return;
      kick(1_500);
    });

    intervalId = setInterval(() => {
      if (cancelled) return;
      void runOnce();
    }, PASS_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopPass();
      unsubAuth();
      unsubPrefs();
      if (intervalId) clearInterval(intervalId);
      if (startTimer) clearTimeout(startTimer);
    };
  }, []);

  return null;
}
