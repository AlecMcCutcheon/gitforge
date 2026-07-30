/**
 * Account Freenet reachability: ForgeProfile + ForgeVault soft-GETs.
 */
import { forgeProfileKeyForFingerprint } from "./forge-profile";
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

async function soft(
  key: ReturnType<typeof forgeProfileKeyForFingerprint>,
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
    profile = await soft(forgeProfileKeyForFingerprint(input.fingerprint));
  }
  if (input.vaultId) {
    vault = await soft(forgeVaultKeyForId(input.vaultId));
  }

  const bits: string[] = [];
  if (profile === "ok") bits.push("Public profile reachable.");
  else if (profile === "missing") bits.push("Public profile missing on this node.");
  if (vault === "ok") bits.push("Account vault reachable.");
  else if (vault === "missing") bits.push("Account vault missing on this node.");
  if (bits.length === 0) bits.push("No account contracts to probe.");

  return {
    profile,
    vault,
    message: bits.join(" "),
    checkedAt: Date.now(),
  };
}
