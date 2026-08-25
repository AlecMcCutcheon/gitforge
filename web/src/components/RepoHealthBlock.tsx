/**
 * Repo sidebar: tip packs + Hub listing/meta reachability, auto-rescue when missing.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TipBundle } from "../tip-browse/decode-wasm";
import { fetchRepoState } from "../freenet/tip-fetch";
import { summarizeRepoState } from "../tip-browse/decode-wasm";
import {
  passiveFromSummary,
  type PackHealthPassive,
  type PackHealthProbeResult,
  type RescueNeed,
} from "../freenet/pack-health";
import {
  probeRepoHealth,
  rescueRepo,
  type ContractReach,
  type RepoHealthProbeResult,
} from "../freenet/repo-health";

// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { rescueTipPacks } from "../freenet/repo-health";
// Rescue now restores packs + ForgeRegistry/ForgeRepoMeta from local backup when needed.

export interface RepoHealthBlockProps {
  prefix: string;
  tipPackSize: number | null;
  tipLoadDone: boolean;
  /** Soft-check ForgeRegistry listing when true. */
  registered: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function tipPacksLabel(p: PackHealthPassive): string {
  const n = p.tippedBundles.length;
  if (n === 0) return "—";
  if (p.chunkedCount === 0) return `${p.singleCount} single`;
  if (p.singleCount === 0) return `${p.chunkedCount} chunked`;
  return `${p.singleCount} single · ${p.chunkedCount} chunked`;
}

function rescueNeedLabel(need: RescueNeed): string {
  switch (need) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "urgent":
      return "Urgent";
    default:
      return "—";
  }
}

function reachLabel(
  r: ContractReach,
  listed?: boolean,
  kind?: "registry",
): string {
  if (r === "skipped") return "—";
  if (r === "unavailable") return "N/A";
  if (r === "missing") return "Missing";
  if (kind === "registry" && listed === false) return "OK · not listed";
  if (kind === "registry" && listed) return "OK · listed";
  return "OK";
}

function Bone({ width }: { width: string }) {
  return (
    <span className="skel-bone skel-bone--line" style={{ width }} aria-hidden />
  );
}

function HealthRowSkeleton({ labelWidth }: { labelWidth: string }) {
  return (
    <li className="gh-health-skel-row" aria-hidden>
      <Bone width={labelWidth} />
      <Bone width="42%" />
    </li>
  );
}

function RepoHealthSkeleton({
  registered,
  message,
}: {
  registered: boolean;
  message?: string;
}) {
  return (
    <section
      className="gh-side-block skel-side-block"
      aria-busy="true"
      aria-label={message ?? "Loading repo health"}
    >
      <span className="skel-bone skel-bone--md" style={{ width: "6.5rem" }} />
      <ul className="gh-side-list gh-health-skel-list">
        <HealthRowSkeleton labelWidth="4.5rem" />
        <HealthRowSkeleton labelWidth="3.8rem" />
        <HealthRowSkeleton labelWidth="6.5rem" />
        {registered ? <HealthRowSkeleton labelWidth="6rem" /> : null}
        <HealthRowSkeleton labelWidth="5.5rem" />
        <HealthRowSkeleton labelWidth="5.2rem" />
      </ul>
      <div className="skel-side-block__body" style={{ marginTop: "0.75rem" }}>
        <span
          className="skel-bone skel-bone--btn skel-bone--btn-secondary"
          style={{ width: "5.5rem" }}
        />
      </div>
    </section>
  );
}

function ValueOrSkel({
  ready,
  children,
  skelWidth = "3.5rem",
}: {
  ready: boolean;
  children: ReactNode;
  skelWidth?: string;
}) {
  if (ready) return <>{children}</>;
  return <Bone width={skelWidth} />;
}

export function RepoHealthBlock({
  prefix,
  tipPackSize,
  tipLoadDone,
  registered,
}: RepoHealthBlockProps) {
  const [passive, setPassive] = useState<PackHealthPassive | null>(null);
  const [probe, setProbe] = useState<RepoHealthProbeResult | null>(null);
  const [busy, setBusy] = useState<"probe" | "rescue" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRescueDone = useRef(false);

  const loadPassive = useCallback(async () => {
    try {
      const state = await fetchRepoState(prefix);
      const summary = (await summarizeRepoState(state)) as {
        tipped_bundles?: TipBundle[];
      };
      setPassive(passiveFromSummary(summary.tipped_bundles ?? [], tipPackSize));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [prefix, tipPackSize]);

  useEffect(() => {
    void loadPassive();
  }, [loadPassive]);

  useEffect(() => {
    autoRescueDone.current = false;
  }, [prefix]);

  const tippedKey = passive
    ? `${passive.tippedBundles.length}:${passive.chunkedCount}:${passive.singleCount}`
    : "";

  useEffect(() => {
    if (!passive || !tipLoadDone || passive.tippedBundles.length === 0) return;
    let cancelled = false;
    const bundles = passive.tippedBundles;
    setBusy("probe");
    setError(null);
    void (async () => {
      try {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // await softFill + network soft-GETs + nativeEnsureTip("HEAD") —
        // duplicated tip load (HEAD vs main), starved low-priority hub GETs
        // behind soft-fill high GETs → Packs reachable hung forever / ws 1006.
        // Then always slept 3s before refine — even when IDB already 20/20 —
        // so health lagged languages/license after tip soft-fill finished.
        // NEW CODE - TESTING: paint packs via onPacksReady (don't wait hub);
        // skip the 3s settle when local packs are already complete.
        const paintPacksEarly = (packs: PackHealthProbeResult) => {
          if (cancelled) return;
          const complete = packs.total > 0 && packs.reachable >= packs.total;
          setProbe({
            packs,
            registry: "skipped",
            listed: false,
            repoMeta: "skipped",
            rescueNeed: packs.rescueNeed,
            message: packs.message,
            checkedAt: packs.checkedAt,
          });
          if (complete) setBusy(null);
        };

        const local = await probeRepoHealth(prefix, bundles, {
          expectRegistered: registered,
          packsLocalOnly: true,
          hubTimeoutMs: 1_200,
          onPacksReady: paintPacksEarly,
        });
        if (cancelled) return;
        setProbe(local);
        const localPacksComplete =
          local.packs.total > 0 &&
          local.packs.reachable >= local.packs.total;
        if (localPacksComplete) {
          setBusy(null);
        }

        void (async () => {
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING
          // await new Promise<void>((r) => setTimeout(r, 3_000));
          // NEW CODE - TESTING: only brief settle when local cache still incomplete
          if (!localPacksComplete) {
            await new Promise<void>((r) => setTimeout(r, 400));
          }
          if (cancelled) return;
          try {
            if (!localPacksComplete) {
              const againLocal = await probeRepoHealth(prefix, bundles, {
                expectRegistered: registered,
                packsLocalOnly: true,
                hubTimeoutMs: 1_200,
                onPacksReady: paintPacksEarly,
              });
              if (cancelled) return;
              if (
                againLocal.packs.total > 0 &&
                againLocal.packs.reachable >= againLocal.packs.total
              ) {
                setProbe(againLocal);
                setBusy(null);
              }
            }

            // Skip network pack re-probe when local already complete — only
            // refresh hub listing/meta (still useful, cheap when registry warm).
            const full = await probeRepoHealth(prefix, bundles, {
              expectRegistered: registered,
              packsLocalOnly: localPacksComplete,
              hubTimeoutMs: localPacksComplete ? 2_500 : 6_000,
              onPacksReady: localPacksComplete ? undefined : paintPacksEarly,
            });
            if (cancelled) return;
            setProbe(full);

            const needAuto =
              !autoRescueDone.current &&
              (full.packs.rescueNeed === "high" ||
                full.packs.rescueNeed === "urgent");
            if (!needAuto) return;

            autoRescueDone.current = true;
            setBusy("rescue");
            setStatus(
              "Missing packs — trying auto-rescue from backup / this node…",
            );
            const rescued = await rescueRepo(prefix, bundles, {
              onlyMissing: true,
              priorProbe: full,
              expectRegistered: registered,
              onProgress: (msg) => {
                if (!cancelled) setStatus(msg);
              },
            });
            if (cancelled) return;
            const after = await probeRepoHealth(prefix, bundles, {
              expectRegistered: registered,
              packsLocalOnly: false,
              hubTimeoutMs: 6_000,
            });
            if (cancelled) return;
            setProbe(after);
            setStatus(
              rescued.packs.putCount > 0 ||
                rescued.registryRestored ||
                rescued.metaRestored
                ? rescued.message
                : "Auto-rescue found nothing recoverable here. Use Rescue or freenet-git rescue.",
            );
          } catch (err) {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : String(err));
            }
          } finally {
            if (!cancelled) setBusy(null);
          }
        })();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tippedKey identity
  }, [prefix, tipLoadDone, tippedKey, registered]);

  // NEW CODE - TESTING: refresh ForgeRepoMeta row after background provision succeeds
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("../freenet/forge-repo").then(({ onOwnerRepoProvisioned }) => {
      if (cancelled) return;
      unsub = onOwnerRepoProvisioned((detail) => {
        if (detail.prefix !== prefix || !detail.createdMeta) return;
        if (!passive?.tippedBundles.length) return;
        void probeRepoHealth(prefix, passive.tippedBundles, {
          expectRegistered: registered,
          packsLocalOnly: true,
          hubTimeoutMs: 2_500,
        })
          .then(setProbe)
          .catch(() => undefined);
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [prefix, registered, passive]);

  const onRescue = async () => {
    if (!passive) return;
    setBusy("rescue");
    setError(null);
    const prior = probe;
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // onlyMissing: true + priorProbe healthy → skipped all → wiped health UI
      // NEW CODE - TESTING: manual Rescue force-republishes from backup/IDB/network
      const rescued = await rescueRepo(prefix, passive.tippedBundles, {
        onlyMissing: false,
        priorProbe: prior ?? undefined,
        expectRegistered: registered,
        onProgress: (msg) => setStatus(msg),
      });
      const again = await probeRepoHealth(prefix, passive.tippedBundles, {
        expectRegistered: registered,
        packsLocalOnly: false,
        hubTimeoutMs: 6_000,
      }).catch(() => rescued.probe);
      setProbe(again);
      setStatus(rescued.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (prior) setProbe(prior);
    } finally {
      setBusy(null);
    }
  };

  if (!passive && !error) {
    return <RepoHealthSkeleton registered={registered} />;
  }

  if (!passive) {
    return (
      <section className="gh-side-block">
        <h3>Repo health</h3>
        <p className="error" style={{ fontSize: "0.85em" }}>
          {error}
        </p>
      </section>
    );
  }

  const packs = probe?.packs;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const probeSettled = busy !== "probe";
  // — before useEffect set busy="probe", busy was null → probeSettled true → "—"
  // Single probeSettled gated Packs reachable behind hub soft-GETs (up to 2.5s)
  // even when local pack probe already returned median 0ms.
  // NEW CODE - TESTING: packs vs hub settle independently
  const hasBundles = passive.tippedBundles.length > 0;
  const probePending =
    busy === "probe" ||
    (!tipLoadDone && !probe) ||
    (tipLoadDone &&
      hasBundles &&
      probe == null &&
      !error &&
      busy !== "rescue");
  const packsReady =
    probe != null &&
    packs != null &&
    packs.total > 0 &&
    (packs.reachable >= packs.total || !probePending);
  const hubReady =
    probe != null &&
    !probePending &&
    (!registered || probe.registry !== "skipped");

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const rescueText = !probeSettled ? null : busy === "rescue" ? …
  //   : probe ? rescueNeedLabel(probe.rescueNeed) : "—";
  // — local-only "unknown"/incomplete grades still flashed High via early setProbe.
  // NEW CODE - TESTING: unknown = still checking (skeleton), not a real urgency.
  const rescueText = !packsReady
    ? null
    : busy === "rescue"
      ? "Rescuing…"
      : probe == null
        ? "—"
        : probe.rescueNeed === "unknown"
          ? null
          : rescueNeedLabel(probe.rescueNeed);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Show reachable counts as soon as probe exists (even while busy=probe).
  // NEW CODE - TESTING: show packs as soon as pack probe paints (hub may lag).
  const reachableText = !packsReady
    ? null
    : packs && packs.total > 0
      ? `${packs.reachable}/${packs.total}${
          packs.medianMs != null
            ? ` · median ${Math.round(packs.medianMs)}ms`
            : ""
        }`
      : "—";

  return (
    <section
      className="gh-side-block"
      aria-busy={busy === "probe" || busy === "rescue"}
    >
      <h3>Repo health</h3>
      <ul className="gh-side-list">
        <li>
          <span className="muted">Tip packs</span>
          <span>{tipPacksLabel(passive)}</span>
        </li>
        <li>
          <span className="muted">Tip size</span>
          <span>
            <ValueOrSkel
              ready={tipLoadDone || passive.totalBytes > 0}
              skelWidth="3.8rem"
            >
              {passive.totalBytes > 0 ? formatBytes(passive.totalBytes) : "—"}
            </ValueOrSkel>
          </span>
        </li>
        <li>
          <span className="muted">Packs reachable</span>
          <span>
            <ValueOrSkel ready={reachableText != null} skelWidth="4.5rem">
              {reachableText}
            </ValueOrSkel>
          </span>
        </li>
        {registered ? (
          <li>
            <span className="muted">Discover listing</span>
            <span>
              <ValueOrSkel ready={hubReady} skelWidth="5rem">
                {probe
                  ? reachLabel(probe.registry, probe.listed, "registry")
                  : "—"}
              </ValueOrSkel>
            </span>
          </li>
        ) : null}
        <li>
          <span className="muted">Repo settings</span>
          <span>
            <ValueOrSkel ready={hubReady} skelWidth="4rem">
              {probe
                ? probe.repoMeta === "missing" && !registered && !probe.listed
                  ? "Not created"
                  : reachLabel(probe.repoMeta)
                : "—"}
            </ValueOrSkel>
          </span>
        </li>
        <li>
          <span className="muted">Rescue need</span>
          <span>
            <ValueOrSkel ready={rescueText != null} skelWidth="3.5rem">
              {rescueText}
            </ValueOrSkel>
          </span>
        </li>
      </ul>
      <p className="muted" style={{ fontSize: "0.85em", marginTop: "0.5rem" }}>
        Missing tip packs auto-rescue from local backup, this node’s cache, or
        the network. Rescue also re-seeds Hub listing/meta when a backup
        snapshot exists.
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginTop: "0.75rem",
        }}
      >
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null || passive.tippedBundles.length === 0}
          onClick={() => void onRescue()}
        >
          {busy === "rescue" ? "Rescuing…" : "Rescue"}
        </button>
      </div>
      {status ? (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: "0.5rem" }}>
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="error" style={{ fontSize: "0.85em", marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** @deprecated use RepoHealthBlock */
export { RepoHealthBlock as PackHealthBlock };
