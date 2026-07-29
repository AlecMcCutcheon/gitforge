/**
 * Compact emoji picker for profile status (no external package).
 * Popover portals to document.body so it is not clipped by modal overflow.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const STATUS_EMOJIS = [
  "😀",
  "😄",
  "🙂",
  "😊",
  "😎",
  "🤓",
  "🧐",
  "🤔",
  "😴",
  "🤒",
  "🥳",
  "🤩",
  "😇",
  "🤗",
  "🤝",
  "👍",
  "👏",
  "🙌",
  "💪",
  "🔥",
  "✨",
  "💫",
  "🌟",
  "💡",
  "🧠",
  "💻",
  "🖥️",
  "⌨️",
  "📱",
  "🚀",
  "🛠️",
  "⚙️",
  "🔧",
  "📦",
  "📝",
  "📚",
  "🎯",
  "☕",
  "🎵",
  "🎮",
  "🏠",
  "🌴",
  "✈️",
  "🏔️",
  "🌙",
  "☀️",
  "🌧️",
  "❤️",
  "💚",
  "💙",
  "🖤",
  "🤍",
];

export interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  disabled?: boolean;
  /** Shown when value is empty */
  emptyLabel?: string;
}

export function EmojiPicker({
  value,
  onChange,
  disabled = false,
  emptyLabel = "☺",
}: EmojiPickerProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // NEW CODE - TESTING: fixed coords so pop floats above Edit status modal
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setCoords(null);
      return;
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const popW = 17 * 16; // ~17rem
      const left = Math.min(
        Math.max(8, rect.left),
        window.innerWidth - popW - 8,
      );
      setCoords({ top: rect.bottom + 6, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Pop was position:absolute inside .emoji-picker — clipped by .status-modal
  // overflow:hidden.
  // NEW CODE - TESTING: portal + position:fixed above the modal

  return (
    <div className="emoji-picker" ref={rootRef}>
      <button
        type="button"
        className="emoji-picker-trigger"
        aria-label="Choose status emoji"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{value.trim() || emptyLabel}</span>
      </button>
      {open && coords
        ? createPortal(
            <div
              id={menuId}
              ref={popRef}
              role="dialog"
              aria-label="Emoji picker"
              className="emoji-picker-pop emoji-picker-pop--portal"
              style={{ top: coords.top, left: coords.left }}
            >
              <div className="emoji-picker-toolbar">
                <span className="muted tiny">Pick an emoji</span>
                <button
                  type="button"
                  className="emoji-picker-clear"
                  onClick={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="emoji-picker-grid">
                {STATUS_EMOJIS.map((em) => (
                  <button
                    key={em}
                    type="button"
                    className={
                      value === em
                        ? "emoji-picker-cell active"
                        : "emoji-picker-cell"
                    }
                    onClick={() => {
                      onChange(em);
                      setOpen(false);
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
