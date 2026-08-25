/**
 * Keep repo Protect scopes aligned with live tip packs.
 * Used after in-app tip push AND when browsing a pinned repo (CLI push catch-up).
 */

import { packContractKey, repoContractKey } from "./keys";
import {
  findScope,
  fetchProtectStatus,
  hasLocalProtectCapability,
  repoGrantId,
  syncScope,
  tipPackKeysFromBundles,
  type TipRetention,
} from "./local-protect";
import { clearRepoStateCache, fetchRepoState } from "./tip-fetch";
import { summarizeRepoState, type TipBundle } from "../tip-browse/decode-wasm";

function encodeKey(key: { encode(): string } | string): string {
  if (typeof key === "string") return key;
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}

/**
 * If a repo Protect scope exists, re-sync tip pack membership from live
 * RepoState. Does not create scopes — only syncs under an already-approved grant.
 */
export async function syncRepoProtectMembership(prefix: string): Promise<void> {
  if (!(await hasLocalProtectCapability())) return;
  const status = await fetchProtectStatus();
  if (!status) return;
  const grantId = repoGrantId(prefix);
  const scope = findScope(status, grantId);
  if (!scope) return;

  const hint = scope.policy?.member_hint as
    | {
        retention?: { mode?: TipRetention; last_n?: number };
        tip_retention?: TipRetention;
        last_n?: number;
      }
    | undefined;
  const retention: TipRetention =
    hint?.retention?.mode ?? hint?.tip_retention ?? "current";
  const lastN = hint?.retention?.last_n ?? hint?.last_n ?? 3;

  let tipKeys: string[] = [];
  try {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const state = await fetchRepoState(prefix);
    // NEW CODE - TESTING: drop cached RepoState so CLI tip pushes are visible
    clearRepoStateCache(prefix);
    const state = await fetchRepoState(prefix);
    const summary = (await summarizeRepoState(state)) as {
      tipped_bundles?: TipBundle[];
      refs?: Array<{ name: string; target: string }>;
      mirror_mode?: string | null;
    };
    tipKeys = tipPackKeysFromBundles(
      summary.tipped_bundles ?? [],
      (hash) => encodeKey(packContractKey(hash)),
      retention,
      lastN,
      {
        refTargets: (summary.refs ?? []).map((r) => r.target),
        mirrorMode: summary.mirror_mode,
      },
    );
  } catch (e) {
    console.warn(
      "[local-protect] tip membership expand failed:",
      e instanceof Error ? e.message : e,
    );
    return;
  }

  // Ensure anchor still matches live repo key.
  const liveAnchor = encodeKey(repoContractKey(prefix));
  const desired = tipKeys.includes(liveAnchor)
    ? tipKeys
    : [liveAnchor, ...tipKeys];

  // Skip no-op sync when ledger already matches live tip closure.
  if (sameKeySet(scope.ledger ?? [], desired)) return;

  const r = await syncScope(grantId, desired);
  if (!r.ok) {
    console.warn("[local-protect] sync-scope membership:", r.error);
  }
}

/** @deprecated Prefer syncRepoProtectMembership — same behavior. */
export async function syncRepoProtectAfterTipPush(
  prefix: string,
): Promise<void> {
  return syncRepoProtectMembership(prefix);
}
