/**
 * Account Freenet reachability: ForgeProfile + ForgeVault soft-GETs.
 */
import { fetchForgeProfile } from "./forge-profile";
import { forgeVaultKeyForId } from "./forge-vault";
import { tryGetContractState } from "./ws";
import { forgeOwnerContractsReady } from "./owner-constants";

export type AccountContractReach = "ok" | "missing" | "unavailable" | "n/a";

export interface AccountHealthResult {
  profile: AccountContractReach;
  vault: AccountContractReach;
  message: string;
  checkedAt: number;
}

async function softVault(
  key: ReturnType<typeof forgeVaultKeyForId>,
): Promise<"ok" | "missing"> {
  if (!key) return "missing";
  const bytes = await tryGetContractState(key);
  return bytes != null && bytes.length > 0 ? "ok" : "missing";
}

export async function probeAccountHealth(input: {
  fingerprint: string | null | undefined;
  vaultId: string | null | undefined;
}): Promise<AccountHealthResult> {
  if (!forgeOwnerContractsReady()) {
    return {
      profile: "unavailable",
      vault: "unavailable",
      message: "Owner contracts not built on this site yet.",
      checkedAt: Date.now(),
    };
  }

  let profile: AccountContractReach = "n/a";
  let vault: AccountContractReach = "n/a";

  if (input.fingerprint) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // soft(forgeProfileKeyForFingerprint(...)) — only current WASM hash
    // NEW CODE - TESTING: fetchForgeProfile probes current + legacy hashes
    const hit = await fetchForgeProfile(input.fingerprint).catch(() => null);
    profile = hit ? "ok" : "missing";
  }
  if (input.vaultId) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // soft miss → reliable reachability (30s) on every health check
    // NEW CODE - TESTING: soft only; miss → unavailable (heal uses reachability)
    const soft = await softVault(forgeVaultKeyForId(input.vaultId));
    vault = soft === "ok" ? "ok" : "unavailable";
  }

  const bits: string[] = [];
  if (profile === "ok") bits.push("Public profile reachable.");
  else if (profile === "missing") bits.push("Public profile missing on this node.");
  if (vault === "ok") bits.push("Account vault reachable.");
  else if (vault === "unavailable")
    bits.push("Account vault unreachable (not treated as missing).");
  if (bits.length === 0) bits.push("No account contracts to probe.");

  return {
    profile,
    vault,
    message: bits.join(" "),
    checkedAt: Date.now(),
  };
}
