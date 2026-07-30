/**
 * Repo-level Freenet reachability: tip packs + ForgeRegistry entry + ForgeRepoMeta.
 */
import type { TipBundle } from "../tip-browse/decode-wasm";
import {
  probePackHealth,
  rescueTipPacks,
  type PackHealthProbeResult,
  type RescueNeed,
} from "./pack-health";
import { forgeRegistryKey } from "./forge-registry";
import { forgeRepoKeyForPrefix } from "./forge-repo";
import { tryGetContractState } from "./ws";
import { forgeOwnerContractsReady } from "./owner-constants";

export type ContractReach = "ok" | "missing" | "skipped" | "unavailable";

export interface RepoHealthProbeResult {
  packs: PackHealthProbeResult;
  /** ForgeRegistry contract reachable and this prefix listed (when expectRegistered). */
  registry: ContractReach;
  /** True when prefix was found in registry repos map. */
  listed: boolean;
  /** ForgeRepoMeta soft-GET (settings/channels envelope). */
  repoMeta: ContractReach;
  /** Combined rescue/ops urgency (packs dominate; missing Hub contracts bump high). */
  rescueNeed: RescueNeed;
  message: string;
  checkedAt: number;
}

function bumpNeed(a: RescueNeed, b: RescueNeed): RescueNeed {
  const order: RescueNeed[] = ["unknown", "low", "medium", "high", "urgent"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))] ?? a;
}

async function softReach(
  key: ReturnType<typeof forgeRegistryKey>,
  timeoutMs?: number,
): Promise<"ok" | "missing"> {
  if (!key) return "missing";
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const bytes = await tryGetContractState(key);
  // NEW CODE - TESTING: optional shorter timeout (missing ForgeRepoMeta was ~4s)
  const bytes = await tryGetContractState(key, {
    timeoutMs: timeoutMs ?? undefined,
  });
  return bytes != null && bytes.length > 0 ? "ok" : "missing";
}

/**
 * Soft-probe tip packs plus Hub listing / meta when owner contracts are built.
 * `expectRegistered` — treat missing listing as High need (Discover broken).
 * `packsLocalOnly` — IDB/memory only for packs (no WS); hub soft-GETs still run
 * unless `hubTimeoutMs` races them out.
 */
export async function probeRepoHealth(
  prefix: string,
  tippedBundles: TipBundle[],
  opts?: {
    expectRegistered?: boolean;
    packsLocalOnly?: boolean;
    /** Cap hub soft-GETs so soft-fill cannot starve the sidebar forever. */
    hubTimeoutMs?: number;
  },
): Promise<RepoHealthProbeResult> {
  const expectRegistered = opts?.expectRegistered === true;
  const packsLocalOnly = opts?.packsLocalOnly === true;
  const hubTimeoutMs = opts?.hubTimeoutMs ?? (packsLocalOnly ? 2_500 : 6_000);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const packs = await probePackHealth(tippedBundles);
  // then serial registry + ForgeRepoMeta soft-GETs (missing meta ≈ full soft timeout)
  // NEW CODE - TESTING: packs ‖ hub soft-checks; skip meta GET when unregistered

  const hubProbe = async (): Promise<{
    registry: ContractReach;
    listed: boolean;
    repoMeta: ContractReach;
  }> => {
    if (!forgeOwnerContractsReady()) {
      return {
        registry: expectRegistered ? "unavailable" : "skipped",
        listed: false,
        repoMeta: expectRegistered ? "unavailable" : "missing",
      };
    }

    let registry: ContractReach = "skipped";
    let listed = false;
    let repoMeta: ContractReach = "skipped";

    const regKey = forgeRegistryKey();
    if (!regKey) {
      registry = expectRegistered ? "unavailable" : "skipped";
    } else if (expectRegistered) {
      const raw = await tryGetContractState(regKey, { timeoutMs: 2_500 });
      if (!raw || raw.length === 0) {
        registry = "missing";
      } else {
        registry = "ok";
        try {
          const text = new TextDecoder().decode(raw);
          const data = JSON.parse(text) as {
            repos?: Record<string, unknown>;
          };
          listed = Boolean(data.repos?.[prefix]);
        } catch {
          listed = false;
        }
      }
    } else {
      // Unregistered: don't block on ForgeRegistry soft-GET for health chrome.
      registry = "skipped";
      listed = false;
    }

    if (!expectRegistered) {
      // ForgeRepoMeta is created on first settings write — no network for "Not created".
      return { registry, listed, repoMeta: "missing" };
    }

    const metaKey = forgeRepoKeyForPrefix(prefix);
    // Short miss timeout: absent ForgeRepoMeta used to wait the full soft-GET (~4s).
    repoMeta = await softReach(metaKey, 1_200);
    return { registry, listed, repoMeta };
  };

  const hubFallback = (): {
    registry: ContractReach;
    listed: boolean;
    repoMeta: ContractReach;
  } => ({
    registry: expectRegistered ? "missing" : "skipped",
    listed: false,
    repoMeta: expectRegistered ? "missing" : "skipped",
  });

  const [packs, hub] = await Promise.all([
    probePackHealth(tippedBundles, { localOnly: packsLocalOnly }),
    Promise.race([
      hubProbe(),
      new Promise<ReturnType<typeof hubFallback>>((resolve) =>
        setTimeout(() => resolve(hubFallback()), hubTimeoutMs),
      ),
    ]),
  ]);
  const { registry, listed, repoMeta } = hub;

  let rescueNeed = packs.rescueNeed;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Auto-rescue from local-only "critical" while soft-fill still running →
  // false urgency. Keep pack grade for display; don't bump hub until known.
  if (!packsLocalOnly) {
    if (expectRegistered && (registry === "missing" || !listed)) {
      rescueNeed = bumpNeed(rescueNeed, "high");
    }
    if (repoMeta === "missing") {
      if (listed || expectRegistered) {
        rescueNeed = bumpNeed(rescueNeed, "medium");
      }
    }
  }

  const bits: string[] = [packs.message];
  if (expectRegistered) {
    if (registry === "missing") {
      bits.push("ForgeRegistry unreachable from this node.");
    } else if (registry === "ok" && !listed) {
      bits.push("Repo not listed on ForgeRegistry (Discover).");
    } else if (registry === "ok" && listed) {
      bits.push("Listed on ForgeRegistry.");
    }
  }
  if (repoMeta === "ok") bits.push("ForgeRepoMeta reachable.");
  else if (repoMeta === "missing" && (listed || expectRegistered)) {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // bits.push("ForgeRepoMeta missing — settings/channels may be unavailable.");
    // NEW CODE - TESTING: worker auto-provisions; copy shouldn't imply manual settings write
    bits.push(
      "ForgeRepoMeta missing — background provision will create it for owners.",
    );
  }

  return {
    packs,
    registry,
    listed,
    repoMeta,
    rescueNeed,
    message: bits.join(" "),
    checkedAt: Date.now(),
  };
}

export { rescueTipPacks };

export interface RepoRescueResult {
  packs: Awaited<ReturnType<typeof rescueTipPacks>>;
  registryRestored: boolean;
  metaRestored: boolean;
  message: string;
  probe: RepoHealthProbeResult;
}

/**
 * Rescue tip packs (backup → IDB → network) and re-seed ForgeRegistry /
 * ForgeRepoMeta from the local backup snapshot when soft-GET shows them missing.
 */
export async function rescueRepo(
  prefix: string,
  tippedBundles: TipBundle[],
  opts?: {
    onlyMissing?: boolean;
    priorProbe?: RepoHealthProbeResult;
    expectRegistered?: boolean;
    onProgress?: (msg: string) => void;
  },
): Promise<RepoRescueResult> {
  const expectRegistered = opts?.expectRegistered === true;
  const packs = await rescueTipPacks(prefix, tippedBundles, {
    onlyMissing: opts?.onlyMissing,
    priorProbe: opts?.priorProbe?.packs,
    onProgress: opts?.onProgress,
  });

  let registryRestored = false;
  let metaRestored = false;
  const bits: string[] = [packs.message];

  try {
    const { backupGetPin } = await import("./repo-backup-store");
    const pin = await backupGetPin(prefix);
    if (pin?.registry) {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // const afterPacks = await probeRepoHealth(...) // re-probes all tip packs
      // NEW CODE - TESTING: soft ForgeRegistry check only
      const regKey = forgeRegistryKey();
      let needRegistry = false;
      if (regKey && expectRegistered) {
        const raw = await tryGetContractState(regKey, { timeoutMs: 2_500 });
        if (!raw || raw.length === 0) {
          needRegistry = true;
        } else {
          try {
            const data = JSON.parse(new TextDecoder().decode(raw)) as {
              repos?: Record<string, unknown>;
            };
            needRegistry = !Boolean(data.repos?.[prefix]);
          } catch {
            needRegistry = true;
          }
        }
      } else if (expectRegistered) {
        needRegistry = true;
      }
      if (needRegistry) {
        opts?.onProgress?.("Restoring ForgeRegistry listing from backup…");
        const { upsertForgeRegistryEntry } = await import("./forge-registry");
        await upsertForgeRegistryEntry(pin.registry);
        registryRestored = true;
        bits.push("Restored ForgeRegistry listing from backup.");
      }
    }
    if (pin?.repoMeta && expectRegistered) {
      const metaKey = forgeRepoKeyForPrefix(prefix);
      const metaReach = await softReach(metaKey, 1_200);
      if (metaReach === "missing") {
        opts?.onProgress?.("Restoring ForgeRepoMeta from backup…");
        const { restoreForgeRepoMetaSnapshot } = await import("./forge-repo");
        await restoreForgeRepoMetaSnapshot(pin.repoMeta);
        metaRestored = true;
        bits.push("Restored ForgeRepoMeta from backup.");
      }
    }
  } catch (err) {
    bits.push(
      `Hub snapshot restore skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const probe = await probeRepoHealth(...) // always — hung after empty rescue
  // stub probe when putCount===0 wiped sidebar (reachable 0 / skipped listing)
  // NEW CODE - TESTING: keep prior probe when nothing was re-PUT; else re-probe
  let probe: RepoHealthProbeResult;
  if (packs.putCount > 0 || registryRestored || metaRestored) {
    probe = await probeRepoHealth(prefix, tippedBundles, { expectRegistered });
  } else if (opts?.priorProbe) {
    probe = {
      ...opts.priorProbe,
      message: bits.join(" "),
      checkedAt: Date.now(),
    };
  } else {
    probe = await probeRepoHealth(prefix, tippedBundles, {
      expectRegistered,
    }).catch(() => ({
      packs: packs.probe,
      registry: "skipped" as const,
      listed: false,
      repoMeta: "skipped" as const,
      rescueNeed: packs.probe.rescueNeed,
      message: bits.join(" "),
      checkedAt: Date.now(),
    }));
  }
  return {
    packs,
    registryRestored,
    metaRestored,
    message: bits.join(" "),
    probe,
  };
}
