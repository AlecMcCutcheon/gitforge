/**
 * Modal to pick up to six pinned repos for the profile Overview.
 */
import { useMemo, useState } from "react";
import { PROFILE_PINNED_MAX } from "../freenet/hub-profile";

export const OVERVIEW_PINNED_MAX = Math.min(6, PROFILE_PINNED_MAX);

export interface PinCandidate {
  prefix: string;
  title: string;
}

export interface EditPinnedModalProps {
  candidates: PinCandidate[];
  initialPinned: string[];
  busy?: boolean;
  onClose: () => void;
  onSave: (prefixes: string[]) => void | Promise<void>;
}

export function EditPinnedModal({
  candidates,
  initialPinned,
  busy = false,
  onClose,
  onSave,
}: EditPinnedModalProps) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>(() =>
    initialPinned.slice(0, OVERVIEW_PINNED_MAX),
  );
  const remaining = OVERVIEW_PINNED_MAX - selected.length;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.prefix.toLowerCase().includes(q),
    );
  }, [candidates, filter]);

  const toggle = (prefix: string) => {
    setSelected((prev) => {
      if (prev.includes(prefix)) return prev.filter((p) => p !== prefix);
      if (prev.length >= OVERVIEW_PINNED_MAX) return prev;
      return [...prev, prefix];
    });
  };

  return (
    <div
      className="pin-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="pin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-modal-title"
      >
        <header className="pin-modal-head">
          <h2 id="pin-modal-title">Edit pinned items</h2>
          <button
            type="button"
            className="pin-modal-close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="muted tiny pin-modal-hint">
          Select up to {OVERVIEW_PINNED_MAX} repositories to show on your
          Overview.
        </p>
        <input
          className="pin-modal-filter"
          type="search"
          placeholder="Filter repositories"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={busy}
        />
        <p
          className={
            remaining === 0
              ? "pin-modal-remaining pin-modal-remaining--full"
              : "pin-modal-remaining"
          }
        >
          {remaining} remaining
        </p>
        <ul className="pin-modal-list">
          {filtered.map((c) => {
            const checked = selected.includes(c.prefix);
            const locked = !checked && remaining === 0;
            return (
              <li key={c.prefix}>
                <label
                  className={
                    locked ? "pin-modal-row pin-modal-row--locked" : "pin-modal-row"
                  }
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || locked}
                    onChange={() => toggle(c.prefix)}
                  />
                  <span className="pin-modal-row-title">{c.title}</span>
                  <span className="mono tiny muted">{c.prefix.slice(0, 16)}…</span>
                </label>
              </li>
            );
          })}
          {filtered.length === 0 ? (
            <li className="muted tiny">No matching repositories.</li>
          ) : null}
        </ul>
        <footer className="pin-modal-foot">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void onSave(selected)}
          >
            {busy ? "Saving…" : "Save pins"}
          </button>
        </footer>
      </div>
    </div>
  );
}
