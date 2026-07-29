import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { api } from "../api";
import { downloadSourceZip, isBrowserNativeMode } from "../tip-browse";

type CloneTab = "https" | "cli";

function freenetHttpsUrl(prefix: string, label: string): string {
  const base = label.replace(/\.git$/i, "") || "repo";
  return `freenet::${prefix}/${base}.git`;
}

function freenetCloneUrl(prefix: string, label: string): string {
  const base = label.replace(/\.git$/i, "") || "repo";
  return `freenet::${prefix}/${base}`;
}

function CodeIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.72 6.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"
      />
      <path
        fill="currentColor"
        d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"
      />
    </svg>
  );
}

function FileZipIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M3.5 1.75v11.5c0 .09.048.173.126.217a.75.75 0 0 1-.752 1.298A1.748 1.748 0 0 1 2 13.25V1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.185 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 12.25 15h-.5a.75.75 0 0 1 0-1.5h.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177L9.513 1.573a.25.25 0 0 0-.177-.073H7.25a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5h-3a.25.25 0 0 0-.25.25Zm3.75 8.75h.5c.966 0 1.75.784 1.75 1.75v3a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1-.75-.75v-3c0-.966.784-1.75 1.75-1.75ZM6 5.25a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 6 5.25Zm.75 2.25h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM8 6.75A.75.75 0 0 1 8.75 6h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 8 6.75ZM8.75 3h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM8 9.75A.75.75 0 0 1 8.75 9h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 8 9.75Zm-1 2.5v2.25h1v-2.25a.25.25 0 0 0-.25-.25h-.5a.25.25 0 0 0-.25.25Z"
      />
    </svg>
  );
}

export function CodeCloneMenu({
  prefix,
  label,
  refName,
}: {
  prefix: string;
  label: string;
  refName: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CloneTab>("https");
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const httpsUrl = freenetHttpsUrl(prefix, label);
  const fieldValue =
    tab === "https" ? httpsUrl : `git clone ${freenetCloneUrl(prefix, label)}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fieldValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const zipUrl = api.archiveZipUrl(prefix, label, refName);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  const onDownloadZip = async () => {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // window.location.href = zipUrl;

    // NEW CODE - TESTING
    setZipError(null);
    if (!isBrowserNativeMode()) {
      window.location.href = zipUrl;
      return;
    }
    setZipBusy(true);
    try {
      await downloadSourceZip(prefix, label, refName);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : String(err));
    } finally {
      setZipBusy(false);
    }
  };

  return (
    <div className={`gh-code-menu ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="btn gh-code-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <CodeIcon />
        <span>Code</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="gh-code-dropdown">
          <div className="gh-code-local-tab">Local</div>

          <div className="gh-code-clone-block">
            <div className="gh-code-clone-head">
              <TerminalIcon />
              <span>Clone</span>
            </div>

            <div className="gh-clone-tabs" role="tablist">
              {(
                [
                  ["https", "HTTPS"],
                  ["cli", "Git CLI"],
                ] as const
              ).map(([id, title], i) => (
                <span key={id} className="gh-clone-tab-wrap">
                  {i > 0 ? <span className="gh-clone-tab-sep" aria-hidden>|</span> : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    className={tab === id ? "active" : ""}
                    onClick={() => setTab(id)}
                  >
                    {title}
                  </button>
                </span>
              ))}
            </div>

            <div className="gh-clone-row">
              <input readOnly value={fieldValue} className="gh-clone-input" />
              <button
                type="button"
                className="gh-clone-copy"
                title={copied ? "Copied!" : "Copy"}
                aria-label={copied ? "Copied" : "Copy to clipboard"}
                onClick={() => void copy()}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </div>
            <p className="muted tiny gh-clone-hint">
              {tab === "cli"
                ? "Clone using git-remote-freenet."
                : "Clone using the Freenet URL."}
            </p>
          </div>

          <div className="gh-code-actions">
            <button
              type="button"
              className="gh-code-action"
              disabled={zipBusy}
              onClick={() => void onDownloadZip()}
            >
              <FileZipIcon />
              <span>{zipBusy ? "Preparing ZIP…" : "Download ZIP"}</span>
            </button>
            {zipError ? (
              <p className="muted tiny" role="alert">
                {zipError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Release / assets ZIP control (bridge href or in-browser tip-tree zip). */
export function SourceZipLink({
  prefix,
  label,
  refName,
  children = "Source code (zip)",
}: {
  prefix: string;
  label: string;
  refName: string;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zipUrl = api.archiveZipUrl(prefix, label, refName);

  const onClick = async (e: ReactMouseEvent) => {
    if (!isBrowserNativeMode()) return; // let <a href> navigate
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await downloadSourceZip(prefix, label, refName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span>
      <a href={zipUrl} onClick={(e) => void onClick(e)}>
        {busy ? "Preparing ZIP…" : children}
      </a>
      {error ? (
        <span className="muted tiny" role="alert">
          {" "}
          {error}
        </span>
      ) : null}
    </span>
  );
}
