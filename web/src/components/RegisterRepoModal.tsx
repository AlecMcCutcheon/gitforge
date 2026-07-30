/**
 * Quick-register modal for an unregistered repo you already hold in forge-identity.
 * Used from the repo header Import button (not the full /import page).
 */
import { useEffect, useState } from "react";
import { api, type ForgeRegistration } from "../api";
import { FlashNotice } from "./FlashNotice";
import { BusyLabel } from "./OperationStatus";
import { brand, registryLabel } from "../lib/brand";

export interface RegisterRepoModalProps {
  open: boolean;
  onClose: () => void;
  prefix: string;
  label: string;
  displayName: string;
  onRegistered: (registration: ForgeRegistration) => void;
}

export function RegisterRepoModal({
  open,
  onClose,
  prefix,
  label,
  displayName,
  onRegistered,
}: RegisterRepoModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
  }, [open, prefix]);

  if (!open) return null;

  const onRegister = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const registration = await api.registerRepo({ prefix, label });
        onRegistered(registration);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div
      className="gh-collab-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="gh-collab-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gh-register-repo-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gh-collab-modal-head">
          <h2 id="gh-register-repo-title">Register on {brand.displayName}</h2>
          <button
            type="button"
            className="gh-collab-modal-close"
            aria-label="Close"
            disabled={busy}
            onClick={() => onClose()}
          >
            ×
          </button>
        </header>

        <p className="muted">
          List <strong>{displayName}</strong> on {registryLabel()}. The
          contract already exists on Freenet; this only adds the Discover
          listing.
        </p>

        <ul className="import-check-list">
          <li className="ok">
            <span className="import-check-mark" aria-hidden>
              ✓
            </span>
            Repository found on Freenet
          </li>
          <li className="ok">
            <span className="import-check-mark" aria-hidden>
              ✓
            </span>
            Your identity holds this repo key
          </li>
          <li className="ok">
            <span className="import-check-mark" aria-hidden>
              ✓
            </span>
            Not yet on {registryLabel()}
          </li>
        </ul>

        {error ? (
          <FlashNotice variant="error" onDismiss={() => setError(null)}>
            {error}
          </FlashNotice>
        ) : null}

        <div className="gh-collab-modal-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onRegister}
          >
            <BusyLabel
              busy={busy}
              idleText={`Register on ${registryLabel()}`}
              busyText="Registering…"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
