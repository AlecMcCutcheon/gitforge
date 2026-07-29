import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { nativeEnsureTip } from "../freenet/native-api";
import { repoBlobHref, type RepoHrefOpts } from "../lib/repo-path";
import { browserListPaths, isBrowserNativeMode } from "../tip-browse";

interface GoToFileProps {
  prefix: string;
  label: string;
  refName: string;
  ownerOpts?: RepoHrefOpts;
}

export function GoToFileSearch({
  prefix,
  label,
  refName,
  ownerOpts,
}: GoToFileProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pathsLoadedRef = useRef(false);
  const pathsLoadingRef = useRef(false);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // useEffect(() => {
  //   let cancelled = false;
  //   const load = async () => {
  //     if (isBrowserNativeMode()) {
  //       try {
  //         const tip = await nativeEnsureTip(prefix, refName);
  //         const r = await browserListPaths(tip);
  //         if (!cancelled) setPaths(r.paths);
  //       } catch {
  //         if (!cancelled) setPaths([]);
  //       }
  //       return;
  //     }
  //     ...
  //   };
  //   void load();
  //   return () => { cancelled = true; };
  // }, [prefix, label, refName]);

  // NEW CODE - TESTING: load path index on first focus (not on Code mount)
  useEffect(() => {
    pathsLoadedRef.current = false;
    pathsLoadingRef.current = false;
    setPaths([]);
  }, [prefix, label, refName]);

  const ensurePaths = async (): Promise<void> => {
    if (pathsLoadedRef.current || pathsLoadingRef.current) return;
    pathsLoadingRef.current = true;
    try {
      if (isBrowserNativeMode()) {
        const tip = await nativeEnsureTip(prefix, refName);
        if (tip.softFill) await tip.softFill;
        const r = await browserListPaths(tip);
        setPaths(r.paths);
      } else {
        const r = await api.paths(prefix, label, refName);
        setPaths(r.paths ?? []);
      }
      pathsLoadedRef.current = true;
    } catch {
      setPaths([]);
    } finally {
      pathsLoadingRef.current = false;
    }
  };

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return paths
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 40);
  }, [paths, query]);

  const go = (filePath: string) => {
    setOpen(false);
    setQuery("");
    void navigate(repoBlobHref(prefix, label, refName, filePath, ownerOpts));
  };

  return (
    <div className="gh-goto" ref={wrapRef}>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
          void ensurePaths();
        }}
        onFocus={() => {
          void ensurePaths();
          if (query.trim()) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
            return;
          }
          if (e.key === "Enter" && matches[active]) {
            e.preventDefault();
            go(matches[active]);
          }
        }}
        placeholder="Go to file"
        aria-label="Go to file"
        aria-expanded={open && matches.length > 0}
        aria-autocomplete="list"
      />
      {open && query.trim() ? (
        <ul className="gh-goto-dropdown" role="listbox">
          {matches.length === 0 ? (
            <li className="muted tiny">No matching paths</li>
          ) : (
            matches.map((p, i) => (
              <li key={p}>
                <button
                  type="button"
                  className={i === active ? "active" : ""}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(p)}
                >
                  {p}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
