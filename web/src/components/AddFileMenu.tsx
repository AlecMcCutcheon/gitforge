/**
 * GitHub-style “Add file ▾” next to the Code button.
 * Create/upload routes show CantEditRepoPanel when the viewer is not the owner.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "../spa-link";
import { repoHref, type RepoHrefOpts } from "../lib/repo-path";

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

function PlusIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"
      />
      <path
        fill="currentColor"
        d="M11.78 4.72a.749.749 0 1 1-1.06 1.06L8.75 3.81V9.5a.75.75 0 0 1-1.5 0V3.81L5.28 5.78a.749.749 0 1 1-1.06-1.06l3.25-3.25a.75.75 0 0 1 1.06 0l3.25 3.25Z"
      />
    </svg>
  );
}

export function AddFileMenu({
  prefix,
  label,
  branch,
  ownerOpts,
  isOwner: _isOwner = false,
}: {
  prefix: string;
  label: string;
  branch: string;
  ownerOpts?: RepoHrefOpts;
  /** Reserved — create/upload views gate the fork placeholder. */
  isOwner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const b = encodeURIComponent(branch || "main");
  const newHref = repoHref(prefix, label, `new/${b}`, ownerOpts);
  const uploadHref = repoHref(prefix, label, `upload/${b}`, ownerOpts);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className={`gh-add-file-menu ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="btn secondary gh-add-file-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span>Add file</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="gh-add-file-dropdown" role="menu">
          <Link
            role="menuitem"
            className="gh-add-file-item"
            to={newHref}
            onClick={() => setOpen(false)}
          >
            <PlusIcon />
            <span>Create new file</span>
          </Link>
          <Link
            role="menuitem"
            className="gh-add-file-item"
            to={uploadHref}
            onClick={() => setOpen(false)}
          >
            <UploadIcon />
            <span>Upload files</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
