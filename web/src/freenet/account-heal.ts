/**
 * Probe + background heal for ForgeProfile / ForgeVault (Account health).
 */
import {
  ensureAccountContracts,
  ensureSessionVaultId,
  ensureSignedInAccountVault,
  getCachedIdentity,
  getSessionVaultId,
  probeVaultBackupEnabled,
} from "./auth-api";
import { probeAccountHealth, type AccountHealthResult } from "./account-health";
import { fetchForgeProfile } from "./forge-profile";
import {
  notifySelfSystem,
  SYSTEM_KIND_ACCOUNT_HEALED,
} from "./system-notify";

const HEALTH_STATE_KEY = "gitforge.account-health.state";

export interface AccountHealthPersisted {
  lastCheckedAt: number | null;
  lastHealAt: number | null;
  lastMessage: string | null;
  profile: AccountHealthResult["profile"] | null;
  vault: AccountHealthResult["vault"] | null;
}

export function getAccountHealthPersisted(): AccountHealthPersisted {
  try {
    const raw = localStorage.getItem(HEALTH_STATE_KEY);
    if (!raw) {
      return {
        lastCheckedAt: null,
        lastHealAt: null,
        lastMessage: null,
        profile: null,
        vault: null,
      };
    }
    const o = JSON.parse(raw) as Partial<AccountHealthPersisted>;
    return {
      lastCheckedAt:
        typeof o.lastCheckedAt === "number" ? o.lastCheckedAt : null,
      lastHealAt: typeof o.lastHealAt === "number" ? o.lastHealAt : null,
      lastMessage: typeof o.lastMessage === "string" ? o.lastMessage : null,
      profile: (o.profile as AccountHealthPersisted["profile"]) ?? null,
      vault: (o.vault as AccountHealthPersisted["vault"]) ?? null,
    };
  } catch {
    return {
      lastCheckedAt: null,
      lastHealAt: null,
      lastMessage: null,
      profile: null,
      vault: null,
    };
  }
}

function saveAccountHealthPersisted(next: AccountHealthPersisted): void {
  try {
    localStorage.setItem(HEALTH_STATE_KEY, JSON.stringify(next));
  } catch {
    /* sandbox */
  }
  try {
    window.dispatchEvent(
      new CustomEvent("gitforge-account-health", { detail: next }),
    );
  } catch {
    /* ignore */
  }
}

export function onAccountHealthPersisted(
  handler: (s: AccountHealthPersisted) => void,
): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent<AccountHealthPersisted>).detail;
    handler(detail ?? getAccountHealthPersisted());
  };
  window.addEventListener("gitforge-account-health", fn);
  return () => window.removeEventListener("gitforge-account-health", fn);
}

/**
 * Soft-check profile/vault; if missing, re-GET (network rescue) then recreate
 * from the signed-in identity / vault ensure flow.
 */
export async function runAccountHealthPass(opts?: {
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** When true, also quiet-sync vault↔delegate when clearly behind. Default on. */
  syncVault?: boolean;
}): Promise<{
  probe: AccountHealthResult;
  healedProfile: boolean;
  healedVault: boolean;
  vaultSynced: boolean;
}> {
  const id = getCachedIdentity();
  if (!id) {
    const empty = await probeAccountHealth({
      fingerprint: null,
      vaultId: null,
    });
    return {
      probe: empty,
      healedProfile: false,
      healedVault: false,
      vaultSynced: false,
    };
  }
  if (opts?.signal?.aborted) {
    throw new Error("aborted");
  }

  const vaultId =
    getSessionVaultId() || (await ensureSessionVaultId().catch(() => null));

  opts?.onProgress?.("Checking account health…");
  let probe = await probeAccountHealth({
    fingerprint: id.fingerprint,
    vaultId,
  });

  let healedProfile = false;
  let healedVault = false;
  let vaultSynced = false;
  const healNotes: string[] = [];

  if (probe.profile === "missing") {
    opts?.onProgress?.("Rescuing public profile from network…");
    const rescued = await fetchForgeProfile(id.fingerprint, {
      reliable: true,
    }).catch(() => null);
    if (rescued) {
      healedProfile = true;
      healNotes.push("Public profile re-fetched onto this node.");
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // rescue only — left profile on legacy WASM after avatar-limit bumps
      // NEW CODE - TESTING: copy rich state onto current WASM hash
      try {
        const { migrateForgeProfileToCurrentWasm } = await import(
          "./forge-profile"
        );
        await migrateForgeProfileToCurrentWasm(id.fingerprint);
      } catch (e) {
        healNotes.push(
          `Profile WASM migrate skipped: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    } else if (vaultId) {
      opts?.onProgress?.("Recreating public profile from identity…");
      try {
        await ensureAccountContracts({
          identity: id,
          vault_id: vaultId,
          username: id.name,
          email: id.email || "",
          syncFromVault: "none",
          onStatus: opts?.onProgress,
        });
        const again = await fetchForgeProfile(id.fingerprint, {
          reliable: true,
        }).catch(() => null);
        if (again) {
          healedProfile = true;
          healNotes.push("Public profile recreated from identity.");
        }
      } catch (err) {
        healNotes.push(
          `Profile heal failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  if (opts?.signal?.aborted) throw new Error("aborted");

  if (probe.vault !== "ok" && probe.vault !== "n/a" && vaultId) {
    opts?.onProgress?.("Checking account vault on Freenet…");
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // soft fetchForgeVault → recreate on any miss (incl. timeout)
    // NEW CODE - TESTING: only recreate on confirmed absence
    const { probeVaultReachability } = await import("./auth-api");
    const reach = await probeVaultReachability(vaultId);
    if (reach === "present") {
      healedVault = true;
      healNotes.push("Account vault re-fetched onto this node.");
    } else if (reach === "absent") {
      opts?.onProgress?.("Recreating account vault from identity…");
      const r = await ensureSignedInAccountVault({
        onStatus: opts?.onProgress,
        maxAttempts: 2,
      });
      if (r.vaultEnabled) {
        healedVault = true;
        healNotes.push("Account vault recreated from identity.");
      } else if (r.error) {
        healNotes.push(`Vault heal failed: ${r.error}`);
      }
    } else {
      healNotes.push(
        "Account vault unreachable — skipped recreate to avoid wipe.",
      );
    }
  }

  if (healedProfile || healedVault) {
    probe = await probeAccountHealth({
      fingerprint: id.fingerprint,
      vaultId,
    });
    await notifySelfSystem(SYSTEM_KIND_ACCOUNT_HEALED, {
      title: "Account contracts healed",
      detail: healNotes.join(" ") || probe.message,
    });
  }

  // Quiet vault sync: only when clearly one-sided behind (skip diverged).
  if (opts?.syncVault !== false && vaultId) {
    const enabled = await probeVaultBackupEnabled(vaultId).catch(() => false);
    if (enabled) {
      try {
        const {
          compareVaultAndDelegate,
          pushDelegateReposToVault,
          pullVaultReposToDelegate,
        } = await import("./auth-api");
        const status = await compareVaultAndDelegate();
        if (status.kind === "vault_behind") {
          opts?.onProgress?.("Pushing local keys to vault…");
          await pushDelegateReposToVault();
          vaultSynced = true;
        } else if (status.kind === "delegate_behind") {
          opts?.onProgress?.("Pulling vault keys to this node…");
          await pullVaultReposToDelegate({ overwriteMismatched: false });
          vaultSynced = true;
        }
      } catch (err) {
        console.warn(
          "[freenet-forge] quiet vault sync skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const now = Date.now();
  const prior = getAccountHealthPersisted();
  saveAccountHealthPersisted({
    lastCheckedAt: now,
    lastHealAt:
      healedProfile || healedVault ? now : prior.lastHealAt,
    lastMessage:
      healNotes.length > 0 ? healNotes.join(" ") : probe.message,
    profile: probe.profile,
    vault: probe.vault,
  });

  return { probe, healedProfile, healedVault, vaultSynced };
}
