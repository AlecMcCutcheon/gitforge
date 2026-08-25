/**
 * Background Protect: keep pinned tip packs aligned with live RepoState.
 * - After in-app tip push (`notifyRepoTipPushed`)
 * - When browsing a repo (`notifyRepoObserved`) so bare CLI pushes catch up
 */

import { useEffect } from "react";
import {
  onRepoObserved,
  onRepoTipPushed,
} from "../freenet/tip-cache-lifecycle";
import { syncRepoProtectMembership } from "../freenet/protect-tip-sync";
import { hasLocalProtectCapability } from "../freenet/local-protect";
import { parseRepoPath } from "../lib/repo-path";

const DEBOUNCE_MS = 750;
const pending = new Map<string, number>();

function scheduleProtectSync(prefix: string): void {
  const p = prefix.trim();
  if (!p) return;
  const prev = pending.get(p);
  if (prev != null) window.clearTimeout(prev);
  const id = window.setTimeout(() => {
    pending.delete(p);
    void (async () => {
      // Capability check inside the job so listeners can register immediately
      // (avoids missing notifyRepoObserved that fires before async setup).
      if (!(await hasLocalProtectCapability())) return;
      try {
        await syncRepoProtectMembership(p);
      } catch (e) {
        console.warn(
          "[protect-worker] tip sync:",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }, DEBOUNCE_MS);
  pending.set(p, id);
}

function prefixFromLocation(): string | null {
  try {
    const path = `${window.location.pathname}${window.location.search || ""}`;
    const parsed = parseRepoPath(path);
    return parsed.ok ? parsed.prefix : null;
  } catch {
    return null;
  }
}

export function ProtectWorker() {
  useEffect(() => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // void (async () => {
    //   if (!(await hasLocalProtectCapability())) return;
    //   unsubPush = onRepoTipPushed(...); // too late — RepoPage already notified
    // })();
    // NEW CODE - TESTING: subscribe sync so browse notify is not dropped
    const unsubPush = onRepoTipPushed(scheduleProtectSync);
    const unsubObs = onRepoObserved(scheduleProtectSync);
    // Catch the current page if observe already fired before mount.
    const here = prefixFromLocation();
    if (here) scheduleProtectSync(here);

    return () => {
      unsubPush();
      unsubObs();
      for (const id of pending.values()) window.clearTimeout(id);
      pending.clear();
    };
  }, []);

  return null;
}

/** @deprecated */
export const RepoBackupWorker = ProtectWorker;
