import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "../spa-link";

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

function RepoIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 10h8ZM4.5 1A1.5 1.5 0 0 0 3 2.5V7h1.5a.75.75 0 0 1 0 1.5H3v3.5A1.5 1.5 0 0 0 4.5 13.5h8.75V1.5Z"
      />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg className="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        fill="currentColor"
        d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"
      />
      <path
        fill="currentColor"
        d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"
      />
    </svg>
  );
}

function MenuItem({
  to,
  icon,
  children,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      role="menuitem"
      to={to}
      className="header-create-item"
      onClick={onClick}
    >
      <span className="header-create-item-icon" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </Link>
  );
}

/** Signed-in header control: + → New / Import repository. */
export function HeaderCreateMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="header-create" ref={rootRef}>
      <button
        type="button"
        className="header-create-btn"
        aria-label="Create new…"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon />
        {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
        <svg
          className="octicon header-create-chevron"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden
        >
          <path
            fill="currentColor"
            d="M4.427 7.427 8 10.999l3.573-3.572a.75.75 0 1 1 1.06 1.06l-4.104 4.103a.75.75 0 0 1-1.06 0L3.367 8.487a.75.75 0 1 1 1.06-1.06Z"
          />
        </svg>
        */}
        {/* NEW CODE - TESTING: solid caret like GitHub + ▾ */}
        <svg
          className="octicon header-create-chevron"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden
        >
          <path fill="currentColor" d="M4 6.5h8L8 11.5 4 6.5z" />
        </svg>
      </button>
      {open ? (
        <div className="header-create-menu" role="menu">
          <MenuItem
            to="/new"
            icon={<RepoIcon />}
            onClick={() => setOpen(false)}
          >
            New repository
          </MenuItem>
          <MenuItem
            to="/import"
            icon={<ImportIcon />}
            onClick={() => setOpen(false)}
          >
            Import repository
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}
