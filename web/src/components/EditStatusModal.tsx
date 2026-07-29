/**
 * GitHub-style Edit status modal (emoji + text + presets; no busy/expiry/visibility).
 */
import { useEffect, useState } from "react";
import { EmojiPicker } from "./EmojiPicker";
import { updatePublicProfile } from "../freenet/auth-api";

const STATUS_MAX = 80;

const PRESETS: Array<{ emoji: string; text: string }> = [
  { emoji: "🌴", text: "On vacation" },
  { emoji: "🤒", text: "Out sick" },
  { emoji: "🏠", text: "Working from home" },
  { emoji: "🎯", text: "Focusing" },
];

export interface EditStatusModalProps {
  initialEmoji: string;
  initialText: string;
  onClose: () => void;
  onSaved: (emoji: string, text: string) => void;
}

export function EditStatusModal({
  initialEmoji,
  initialText,
  onClose,
  onSaved,
}: EditStatusModalProps) {
  const [emoji, setEmoji] = useState(initialEmoji || "☺");
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const remaining = STATUS_MAX - text.length;

  const save = async (nextEmoji: string, nextText: string) => {
    setBusy(true);
    setError(null);
    try {
      await updatePublicProfile({
        statusEmoji: nextEmoji.trim(),
        statusText: nextText.trim(),
      });
      onSaved(nextEmoji.trim(), nextText.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="status-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="status-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-modal-title"
      >
        <header className="status-modal-head">
          <h2 id="status-modal-title">Edit status</h2>
          <button
            type="button"
            className="status-modal-close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="status-modal-body">
          <p className="status-modal-label">What&apos;s happening?</p>
          <div className="status-modal-input-row">
            <EmojiPicker
              value={emoji}
              onChange={setEmoji}
              disabled={busy}
              emptyLabel="☺"
            />
            <input
              className="status-modal-text"
              value={text}
              maxLength={STATUS_MAX}
              disabled={busy}
              placeholder="What's happening?"
              onChange={(e) => setText(e.target.value.slice(0, STATUS_MAX))}
            />
          </div>
          <p className="muted tiny status-modal-remaining">
            {remaining} characters remaining
          </p>
          <div className="status-modal-presets">
            {PRESETS.map((p) => (
              <button
                key={p.text}
                type="button"
                className="status-modal-preset"
                disabled={busy}
                onClick={() => {
                  setEmoji(p.emoji);
                  setText(p.text);
                }}
              >
                <span aria-hidden>{p.emoji}</span> {p.text}
              </button>
            ))}
          </div>
          {error ? <p className="error tiny">{error}</p> : null}
        </div>

        <footer className="status-modal-foot">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void save("", "")}
          >
            Clear status
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void save(emoji, text)}
          >
            {busy ? "Saving…" : "Set status"}
          </button>
        </footer>
      </div>
    </div>
  );
}
