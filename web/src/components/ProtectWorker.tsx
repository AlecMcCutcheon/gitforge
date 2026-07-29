/**
 * Background Protect: tip-push sync under existing scopes.
 * Replaces tip-pack RepoBackupWorker auto-pin passes.
 */

import { useEffect } from "react";
import { onRepoTipPushed } from "../freenet/tip-cache-lifecycle";
import { syncRepoProtectAfterTipPush } from "../freenet/protect-tip-sync";
import { hasLocalProtectCapability } from "../freenet/local-protect";

export function ProtectWorker() {
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      if (!(await hasLocalProtectCapability())) return;
      if (cancelled) return;
      unsub = onRepoTipPushed((prefix) => {
        void syncRepoProtectAfterTipPush(prefix).catch((e) =>
          console.warn(
            "[protect-worker] tip sync:",
            e instanceof Error ? e.message : e,
          ),
        );
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return null;
}

/** @deprecated */
export const RepoBackupWorker = ProtectWorker;
