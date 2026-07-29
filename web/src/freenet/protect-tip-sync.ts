/**
 * After tip push: if a repo Protect scope exists, re-sync tip pack membership.
 * Does not create scopes — only syncs under an already-approved repo grant.
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
import { fetchRepoState } from "./tip-fetch";
import { summarizeRepoState, type TipBundle } from "../tip-browse/decode-wasm";

function encodeKey(key: { encode(): string } | string): string {
  if (typeof key === "string") return key;
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

export async function syncRepoProtectAfterTipPush(prefix: string): Promise<void> {
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
    const state = await fetchRepoState(prefix);
    const summary = (await summarizeRepoState(state)) as {
      tipped_bundles?: TipBundle[];
    };
    tipKeys = tipPackKeysFromBundles(
      summary.tipped_bundles ?? [],
      (hash) => encodeKey(packContractKey(hash)),
      retention,
      lastN,
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

  const r = await syncScope(grantId, desired);
  if (!r.ok) {
    console.warn("[local-protect] sync-scope after tip push:", r.error);
  }
}
