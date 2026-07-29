/**
 * GitHub-style community-file tabs under the Code file list (root only).
 * Soft-support: show a tab when the file exists on this tip.
 * Tabs live in the markdown panel header (where the path used to be).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  detectLicense,
  discoverCommunityFiles,
  licenseTabLabel,
  type CommunityFiles,
  type DetectResult,
} from "@freenet-hub/licensee";
import { api } from "../api";
import { nativeEnsureTip } from "../freenet/native-api";
import { ReadmePanel } from "./MarkdownPanel";
import { PageLoadingOverlay } from "./PageLoadingOverlay";
import { repoBlobHref, type RepoHrefOpts } from "../lib/repo-path";
import { browserListCommunityPaths, isBrowserNativeMode } from "../tip-browse";

type TabKind =
  | "readme"
  | "codeOfConduct"
  | "contributing"
  | "license"
  | "security";

const TAB_ORDER: TabKind[] = [
  "readme",
  "codeOfConduct",
  "contributing",
  "license",
  "security",
];

const STATIC_LABELS: Record<Exclude<TabKind, "license">, string> = {
  readme: "README",
  codeOfConduct: "Code of conduct",
  contributing: "Contributing",
  security: "Security",
};

function whenIdle(cb: () => void, timeoutMs = 400): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout: timeoutMs });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 0);
  return () => clearTimeout(id);
}

function pathForKind(files: CommunityFiles, kind: TabKind): string | null {
  return files[kind] ?? null;
}

function applyLicenseHit(
  hit: DetectResult,
  onLicenseDetected?: (line: string | null) => void,
): void {
  if (hit.spdxId) onLicenseDetected?.(hit.spdxId);
  else if (hit.title) onLicenseDetected?.(hit.title);
  else onLicenseDetected?.(null);
}

export function CommunityFilesPanel({
  prefix,
  label,
  gitRef,
  ownerOpts,
  /** Root tree file names (fallback when paths API unavailable). */
  rootNames = [],
  onLicenseDetected,
  /** Repo owner + registered → pencil/edit; else eye/view. */
  canEdit = false,
}: {
  prefix: string;
  label: string;
  gitRef: string;
  ownerOpts: RepoHrefOpts;
  rootNames?: string[];
  /** Optional About sidebar: SPDX / title when detection finishes. */
  onLicenseDetected?: (line: string | null) => void;
  canEdit?: boolean;
}) {
  const rootNamesRef = useRef(rootNames);
  rootNamesRef.current = rootNames;

  const [community, setCommunity] = useState<CommunityFiles | null>(null);
  const [discoverBusy, setDiscoverBusy] = useState(true);
  const [active, setActive] = useState<TabKind | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [bodyBusy, setBodyBusy] = useState(false);
  const [licenseHit, setLicenseHit] = useState<DetectResult | null>(null);
  const loadedRef = useRef(new Set<string>());
  const onLicenseDetectedRef = useRef(onLicenseDetected);
  onLicenseDetectedRef.current = onLicenseDetected;

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Discover deps included rootKey (tree entry names). When the tree finished
  // loading, rootKey changed → rediscover cancelled in-flight license detect
  // while community.license stayed the same → detect effect did not re-run
  // (detectStarted gate) and the tab stuck on "License".
  // NEW CODE - TESTING: discover only on tip identity; rootNames is catch fallback
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = new Set();
    setDiscoverBusy(true);
    setCommunity(null);
    setActive(null);
    setBodies({});
    setLicenseHit(null);
    onLicenseDetectedRef.current?.(null);

    void (async () => {
      let paths: string[] = [];
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // Full tip path walk competed with pack soft-load / languages on big repos.
      // try {
      //   const listed = await api.paths(prefix, label, gitRef);
      //   paths = listed.paths ?? [];
      // } catch {
      //   paths = rootNamesRef.current.filter((n) => n && !n.includes("/"));
      // }

      // NEW CODE - TESTING: shallow root/.github/docs only (native) or rootNames
      if (isBrowserNativeMode()) {
        try {
          const tip = await nativeEnsureTip(prefix, gitRef);
          paths = await browserListCommunityPaths(tip);
        } catch {
          paths = rootNamesRef.current.filter((n) => n && !n.includes("/"));
        }
      } else {
        try {
          const listed = await api.paths(prefix, label, gitRef);
          paths = listed.paths ?? [];
        } catch {
          paths = rootNamesRef.current.filter((n) => n && !n.includes("/"));
        }
      }
      if (paths.length === 0) {
        paths = rootNamesRef.current.filter((n) => n && !n.includes("/"));
      }
      if (cancelled) return;
      const found = discoverCommunityFiles(paths);
      setCommunity(found);
      const first = TAB_ORDER.find((k) => pathForKind(found, k)) ?? null;
      setActive(first);
      setDiscoverBusy(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [prefix, label, gitRef]);

  // Progressive body load for active tab
  useEffect(() => {
    if (!community || !active) return;
    const path = pathForKind(community, active);
    if (!path || loadedRef.current.has(path)) return;
    let cancelled = false;
    setBodyBusy(true);
    void api
      .blob(prefix, label, gitRef, path)
      .then((blob) => {
        if (cancelled) return;
        loadedRef.current.add(path);
        setBodies((prev) => ({
          ...prev,
          [path]: blob.binary ? "" : blob.content ?? "",
        }));
      })
      .catch(() => {
        if (!cancelled) {
          loadedRef.current.add(path);
          setBodies((prev) => ({ ...prev, [path]: "" }));
        }
      })
      .finally(() => {
        if (!cancelled) setBodyBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [community, active, prefix, label, gitRef]);

  // License detect: re-run whenever community (re)discovers a license path.
  // No detectStarted gate — that skipped retries after StrictMode/tree churn.
  useEffect(() => {
    const licPath = community?.license ?? null;
    if (!licPath || !isBrowserNativeMode()) {
      setLicenseHit(null);
      if (!licPath) onLicenseDetectedRef.current?.(null);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const runDetect = (content: string) => {
      const hit = detectLicense([{ path: licPath, content }]);
      if (cancelled) return;
      setLicenseHit(hit);
      applyLicenseHit(hit, onLicenseDetectedRef.current);
    };

    const fetchAndDetect = () => {
      void api
        .blob(prefix, label, gitRef, licPath)
        .then((blob) => {
          if (cancelled) return;
          const content = blob.binary ? "" : blob.content ?? "";
          loadedRef.current.add(licPath);
          setBodies((prev) =>
            prev[licPath] != null ? prev : { ...prev, [licPath]: content },
          );
          runDetect(content);
        })
        .catch(() => {
          if (cancelled) return;
          // Tip may still be warming — one short retry
          retryTimer = window.setTimeout(() => {
            if (cancelled) return;
            void api
              .blob(prefix, label, gitRef, licPath)
              .then((blob) => {
                if (cancelled) return;
                const content = blob.binary ? "" : blob.content ?? "";
                loadedRef.current.add(licPath);
                setBodies((prev) =>
                  prev[licPath] != null
                    ? prev
                    : { ...prev, [licPath]: content },
                );
                runDetect(content);
              })
              .catch(() => {
                if (!cancelled) {
                  setLicenseHit(null);
                  onLicenseDetectedRef.current?.(null);
                }
              });
          }, 600);
        });
    };

    // Prefer content already loaded (opened License tab); else idle-fetch
    const existing = loadedRef.current.has(licPath);
    if (existing) {
      // body may be in state — fetch again is cheap from tip cache; keeps label correct
      fetchAndDetect();
    } else {
      const cancelIdle = whenIdle(() => {
        if (!cancelled) fetchAndDetect();
      });
      return () => {
        cancelled = true;
        cancelIdle();
        if (retryTimer != null) window.clearTimeout(retryTimer);
      };
    }

    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [community, prefix, label, gitRef]);

  // If LICENSE body arrives via the tab loader first, detect immediately
  useEffect(() => {
    const licPath = community?.license;
    if (!licPath || licenseHit?.key || licenseHit?.spdxId) return;
    const content = bodies[licPath];
    if (content == null || !content.trim()) return;
    const hit = detectLicense([{ path: licPath, content }]);
    setLicenseHit(hit);
    applyLicenseHit(hit, onLicenseDetectedRef.current);
  }, [bodies, community?.license, licenseHit?.key, licenseHit?.spdxId]);

  const tabs = useMemo(() => {
    if (!community) return [];
    return TAB_ORDER.filter((k) => pathForKind(community, k)).map((kind) => {
      const path = pathForKind(community, kind)!;
      const labelText: string =
        kind === "license"
          ? licenseHit && (licenseHit.spdxId || licenseHit.key || licenseHit.title)
            ? licenseTabLabel(licenseHit)
            : "License"
          : STATIC_LABELS[kind];
      return { kind, path, labelText };
    });
  }, [community, licenseHit]);

  if (discoverBusy) {
    return <PageLoadingOverlay skeleton="readme" message="" />;
  }

  if (!community || tabs.length === 0 || !active) {
    return null;
  }

  const activePath = pathForKind(community, active);
  if (!activePath) return null;
  const content = bodies[activePath];

  const headerTabs =
    tabs.length > 1 ? (
      <div className="gh-community-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            aria-selected={t.kind === active}
            onClick={() => setActive(t.kind)}
          >
            {t.labelText}
          </button>
        ))}
      </div>
    ) : undefined;

  const singleTitle =
    tabs.length === 1 ? tabs[0]!.labelText : undefined;

  return (
    <div className="gh-community-wrap">
      {bodyBusy && content == null ? (
        <PageLoadingOverlay skeleton="readme" message="" />
      ) : content != null ? (
        <ReadmePanel
          className="readme gh-readme gh-community-panel"
          path={activePath}
          content={content}
          title={singleTitle}
          headerTabs={headerTabs}
          blobHref={repoBlobHref(prefix, label, gitRef, activePath, ownerOpts)}
          canEdit={canEdit}
          prefix={prefix}
          label={label}
          branch={gitRef}
          ownerOpts={ownerOpts}
        />
      ) : null}
    </div>
  );
}
