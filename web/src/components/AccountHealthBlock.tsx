/**
 * Settings: soft-GET HubProfile + HubVault reachability (+ last checked).
 */
import { useEffect, useState } from "react";
import {
  probeAccountHealth,
  type AccountHealthResult,
} from "../freenet/account-health";
import {
  getAccountHealthPersisted,
  onAccountHealthPersisted,
  type AccountHealthPersisted,
} from "../freenet/account-heal";

export interface AccountHealthBlockProps {
  fingerprint: string | null | undefined;
  vaultId: string | null | undefined;
  /** Slim card for the settings sidebar above the nav. */
  compact?: boolean;
}

function label(r: AccountHealthResult["profile"]): string {
  switch (r) {
    case "ok":
      return "Reachable";
    case "missing":
      return "Missing";
    case "unavailable":
      return "N/A";
    default:
      return "—";
  }
}

function formatChecked(ts: number | null): string {
  if (ts == null) return "Never";
  try {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

export function AccountHealthBlock({
  fingerprint,
  vaultId,
  compact = false,
}: AccountHealthBlockProps) {
  const [result, setResult] = useState<AccountHealthResult | null>(null);
  const [persisted, setPersisted] = useState<AccountHealthPersisted>(() =>
    getAccountHealthPersisted(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAccountHealthPersisted(setPersisted);
  }, []);

  useEffect(() => {
    if (!fingerprint && !vaultId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    void probeAccountHealth({ fingerprint, vaultId })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, vaultId]);

  const profile =
    result?.profile ?? persisted.profile ?? ("n/a" as const);
  const vault = result?.vault ?? persisted.vault ?? ("n/a" as const);
  const checkedAt = result?.checkedAt ?? persisted.lastCheckedAt;

  return (
    <section
      className={
        compact
          ? "settings-card account-health-card account-health-card--nav"
          : "settings-card account-health-card"
      }
    >
      <h2 className="account-health-title">Account health</h2>
      {!compact ? (
        <p className="muted" style={{ fontSize: "0.9em" }}>
          Soft-check that your public profile and encrypted vault contracts are
          reachable from this Freenet node. A background worker re-checks
          periodically and can heal missing contracts.
        </p>
      ) : null}
      <ul className="gh-side-list account-health-list">
        <li>
          <span className="muted">Profile</span>
          <span>{busy ? "…" : label(profile)}</span>
        </li>
        <li>
          <span className="muted">Vault</span>
          <span>{busy ? "…" : label(vault)}</span>
        </li>
        <li>
          <span className="muted">Checked</span>
          <span className="tiny">{formatChecked(checkedAt)}</span>
        </li>
      </ul>
      {/* OLD CODE - KEEP UNTIL CONFIRMED WORKING
      {persisted.lastMessage && compact ? (
        <p className="muted tiny account-health-note" title={persisted.lastMessage}>
          {persisted.lastMessage}
        </p>
      ) : null}
      */}
      {/* NEW CODE - TESTING: drop verbose "Public profile reachable…" spam under the card */}
      {error ? (
        <p className="error tiny" style={{ marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
