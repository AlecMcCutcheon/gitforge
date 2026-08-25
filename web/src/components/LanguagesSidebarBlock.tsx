/**
 * GitHub-style language bar — freenet-linguist over tip pack blobs.
 * Colors come from Linguist languages.yml (via freenet-linguist catalog).
 * Starts after idle so repo skeletons/paint stay responsive.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { isBrowserNativeMode } from "../tip-browse";
import type { LanguageBreakdown, LanguageSlice } from "@gitforge/linguist";

const FALLBACK_COLOR = "#858585";
/** GitHub sidebar “Other” chip. */
const OTHER_COLOR = "#ededed";
const MAX_NAMED = 7;

function withOtherBucket(langs: LanguageSlice[]): LanguageSlice[] {
  if (langs.length <= MAX_NAMED) return langs;
  const head = langs.slice(0, MAX_NAMED);
  const rest = langs.slice(MAX_NAMED);
  const bytes = rest.reduce((s, l) => s + l.bytes, 0);
  const percent = rest.reduce((s, l) => s + l.percent, 0);
  if (percent <= 0) return head;
  return [
    ...head,
    { name: "Other", color: OTHER_COLOR, bytes, percent },
  ];
}

function whenIdle(cb: () => void, timeoutMs = 400): () => void {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // timeoutMs = 1800 — languages waited up to ~1.8s after tip before starting
  // NEW CODE - TESTING: shorter idle cap; path-pass is cheap now
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout: timeoutMs });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 0);
  return () => clearTimeout(id);
}

export function LanguagesSidebarBlock({
  prefix,
  label,
  gitRef,
  /** When false (empty repo / nested tree), skip. */
  enabled = true,
}: {
  prefix: string;
  label: string;
  gitRef: string;
  enabled?: boolean;
}) {
  const [stats, setStats] = useState<LanguageBreakdown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !isBrowserNativeMode()) {
      setStats(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const ac = new AbortController();
    setStats(null);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // setLoading(false);
    // Skeleton only after idle — first paint showed nothing until path-pass,
    // and a soft-fill `missing tree` throw left the block permanently null.
    // NEW CODE - TESTING: show loading skeleton immediately while tip soft-fills
    setLoading(true);

    const cancelIdle = whenIdle(() => {
      if (cancelled) return;
      void api
        .languages(prefix, label, gitRef, {
          signal: ac.signal,
          onPartial: (row) => {
            if (!cancelled && row.languages.length > 0) {
              setStats(row);
              setLoading(false);
            }
          },
        })
        .then((row) => {
          if (cancelled) return;
          setStats(row);
          setLoading(false);
          // NEW CODE - TESTING: owner caches primary lang on ForgeRegistry
          const primary = row.languages[0];
          if (!primary?.name) return;
          void (async () => {
            try {
              const { nativeEnsureTip } = await import(
                "../freenet/native-api"
              );
              const { maybePublishOwnerPrimaryLanguage } = await import(
                "../freenet/publish-owner-language"
              );
              const tip = await nativeEnsureTip(prefix, gitRef || "HEAD");
              if (cancelled) return;
              await maybePublishOwnerPrimaryLanguage({
                prefix,
                tipCommit: tip.commit,
                primary: {
                  name: primary.name,
                  color: primary.color,
                },
              });
            } catch (e) {
              console.warn(
                "[freenet-forge] language publish hook:",
                e instanceof Error ? e.message : e,
              );
            }
          })();
        })
        .catch((e) => {
          if (cancelled) return;
          // Abort from effect cleanup is expected; keep quiet.
          if (e instanceof DOMException && e.name === "AbortError") return;
          console.warn(
            "[freenet-forge] language stats:",
            e instanceof Error ? e.message : e,
          );
          setStats(null);
          setLoading(false);
        });
    });

    return () => {
      cancelled = true;
      ac.abort();
      cancelIdle();
    };
  }, [prefix, label, gitRef, enabled]);

  if (!isBrowserNativeMode() || !enabled) return null;

  if (loading && !stats) {
    return (
      <section
        className="gh-side-block skel-side-block"
        aria-busy="true"
        aria-label="Loading languages"
      >
        <span className="skel-bone skel-bone--md" style={{ width: "5rem" }} />
        <div className="skel-side-block__body">
          <span className="skel-bone skel-bone--line" style={{ width: "100%" }} />
          <span className="skel-bone skel-bone--line" style={{ width: "70%" }} />
        </div>
      </section>
    );
  }

  if (!stats || stats.languages.length === 0) return null;

  const top = withOtherBucket(stats.languages);

  return (
    <section className="gh-side-block gh-languages-block">
      <h3>Languages</h3>
      <div
        className="gh-lang-bar"
        role="img"
        aria-label={top
          .map((l) => `${l.name} ${l.percent.toFixed(1)}%`)
          .join(", ")}
      >
        {top.map((l) => (
          <span
            key={l.name}
            className="gh-lang-bar-seg"
            style={{
              width: `${Math.max(l.percent, 0)}%`,
              background: l.color || FALLBACK_COLOR,
            }}
            title={`${l.name}: ${l.percent.toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="gh-lang-legend">
        {top.map((l) => (
          <li key={l.name}>
            <span
              className="gh-lang-dot"
              style={{ background: l.color || FALLBACK_COLOR }}
              aria-hidden
            />
            <span className="gh-lang-name">{l.name}</span>
            <span className="muted tiny">{l.percent.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
