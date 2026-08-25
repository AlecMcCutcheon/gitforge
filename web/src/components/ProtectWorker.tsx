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

const DEBOUNCE_MS = 750;
const pending = new Map<string, number>();

function scheduleProtectSync(prefix: string): void {
  const p = prefix.trim();
  if (!p) return;
  const prev = pending.get(p);
  if (prev != null) window.clearTimeout(prev);
  const id = window.setTimeout(() => {
    pending.delete(p);
    void syncRepoProtectMembership(p).catch((e) =>
      console.warn(
        "[protect-worker] tip sync:",
        e instanceof Error ? e.message : e,
      ),
    );
  }, DEBOUNCE_MS);
  pending.set(p, id);
}

export function ProtectWorker() {
  useEffect(() => {
    let unsubPush: (() => void) | undefined;
    let unsubObs: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      if (!(await hasLocalProtectCapability())) return;
      if (cancelled) return;
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // unsub = onRepoTipPushed((prefix) => { void syncRepoProtectAfterTipPush(...) });
      // NEW CODE - TESTING: also sync when browsing (CLI push catch-up)
      unsubPush = onRepoTipPushed(scheduleProtectSync);
      unsubObs = onRepoObserved(scheduleProtectSync);
    })();
    return () => {
      cancelled = true;
      unsubPush?.();
      unsubObs?.();
      for (const id of pending.values()) window.clearTimeout(id);
      pending.clear();
    };
  }, []);

  return null;
}

/** @deprecated */
export const RepoBackupWorker = ProtectWorker;
