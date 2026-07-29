import type { VaultDelegateSyncStatus } from "../freenet/auth-api";

function statusLabel(kind: VaultDelegateSyncStatus["kind"]): string {
  switch (kind) {
    case "in_sync":
      return "In sync";
    case "vault_behind":
      return "Vault behind";
    case "delegate_behind":
      return "This node behind";
    case "diverged":
      return "Conflict";
    case "no_vault":
      return "No vault";
    default:
      return kind;
  }
}

function statusHint(kind: VaultDelegateSyncStatus["kind"]): string {
  switch (kind) {
    case "in_sync":
      return "Repo keys and Pages website keys match Freenet vault and this node.";
    case "vault_behind":
      return "This node has keys the vault does not. Push to update Freenet.";
    case "delegate_behind":
      return "The vault has keys this node is missing. Pull to update local delegates.";
    case "diverged":
      return "Vault and this node disagree on one or more secrets. Resolve carefully.";
    case "no_vault":
      return "No vault ciphertext for this identity yet.";
    default:
      return "";
  }
}

function DriftList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  if (!items.length) return null;
  return (
    <div className="vault-sync-drift">
      <span className="vault-sync-drift-label">{title}</span>
      <ul className="vault-sync-drift-list">
        {items.map((id) => (
          <li key={id} className="mono">
            {id}
          </li>
        ))}
      </ul>
    </div>
  );
}

function sliceKind(
  onlyDelegate: string[],
  onlyVault: string[],
  mismatch: string[],
): VaultDelegateSyncStatus["kind"] {
  const d = onlyDelegate.length > 0;
  const v = onlyVault.length > 0;
  const m = mismatch.length > 0;
  if (!d && !v && !m) return "in_sync";
  if (m || (d && v)) return "diverged";
  if (d) return "vault_behind";
  return "delegate_behind";
}

export function VaultSyncPanel({
  status,
  syncBusy,
  busy,
  onRefresh,
  onPush,
  onPull,
}: {
  status: VaultDelegateSyncStatus | null;
  syncBusy: boolean;
  busy: boolean;
  onRefresh: () => void;
  onPush: () => void;
  onPull: (overwrite: boolean) => void;
}) {
  const kind = status?.kind ?? null;
  const showPanel = status && kind !== "no_vault";
  const canPush = kind === "vault_behind" || kind === "diverged";
  const canPull = kind === "delegate_behind" || kind === "diverged";
  const repoKind = status
    ? sliceKind(
        status.only_delegate,
        status.only_vault,
        status.secret_mismatch,
      )
    : "in_sync";
  const hasDrift =
    !!status &&
    (status.only_delegate.length > 0 ||
      status.only_vault.length > 0 ||
      status.secret_mismatch.length > 0 ||
      status.pages.only_delegate.length > 0 ||
      status.pages.only_vault.length > 0 ||
      status.pages.secret_mismatch.length > 0);

  return (
    <section className="vault-sync" aria-labelledby="vault-sync-heading">
      <div className="vault-sync-head">
        <div>
          <h2 id="vault-sync-heading" className="vault-sync-title">
            Vault ↔ this node
          </h2>
          <p className="vault-sync-lede">
            Encrypted repo keys and Pages website keys on Freenet. Status uses
            your signed-in identity — no vault password.
          </p>
        </div>
        <button
          type="button"
          className="btn secondary vault-sync-refresh"
          disabled={busy || syncBusy}
          onClick={onRefresh}
        >
          {syncBusy ? "Checking…" : "Refresh"}
        </button>
      </div>

      {syncBusy && !showPanel ? (
        <div className="vault-sync-loading" aria-busy="true">
          <span className="vault-sync-pulse" />
          Comparing vault and this node…
        </div>
      ) : null}

      {showPanel && status ? (
        <div className={`vault-sync-card vault-sync-card--${status.kind}`}>
          <div className="vault-sync-status-row">
            <span
              className={`vault-sync-pill vault-sync-pill--${status.kind}`}
            >
              {statusLabel(status.kind)}
            </span>
            <p className="vault-sync-hint">{statusHint(status.kind)}</p>
          </div>

          <div className="vault-sync-metrics">
            <div className="vault-sync-metric">
              <div className="vault-sync-metric-top">
                <span className="vault-sync-metric-label">Repo keys</span>
                <span
                  className={`vault-sync-mini vault-sync-mini--${repoKind}`}
                >
                  {statusLabel(repoKind)}
                </span>
              </div>
              <div className="vault-sync-metric-nums">
                <div className="vault-sync-metric-cell">
                  <span className="vault-sync-metric-n">
                    {status.delegate_count}
                  </span>
                  <span className="vault-sync-metric-cap">this node</span>
                </div>
                <span className="vault-sync-metric-sep" aria-hidden>
                  ·
                </span>
                <div className="vault-sync-metric-cell">
                  <span className="vault-sync-metric-n">
                    {status.vault_count}
                  </span>
                  <span className="vault-sync-metric-cap">vault</span>
                </div>
              </div>
            </div>
            <div className="vault-sync-metric">
              <div className="vault-sync-metric-top">
                <span className="vault-sync-metric-label">Pages keys</span>
                <span
                  className={`vault-sync-mini vault-sync-mini--${status.pages.kind}`}
                >
                  {statusLabel(status.pages.kind)}
                </span>
              </div>
              <div className="vault-sync-metric-nums">
                <div className="vault-sync-metric-cell">
                  <span className="vault-sync-metric-n">
                    {status.pages.delegate_count}
                  </span>
                  <span className="vault-sync-metric-cap">this node</span>
                </div>
                <span className="vault-sync-metric-sep" aria-hidden>
                  ·
                </span>
                <div className="vault-sync-metric-cell">
                  <span className="vault-sync-metric-n">
                    {status.pages.vault_count}
                  </span>
                  <span className="vault-sync-metric-cap">vault</span>
                </div>
              </div>
            </div>
          </div>

          {hasDrift ? (
            <div className="vault-sync-details">
              <DriftList
                title="Repos only on this node"
                items={status.only_delegate}
              />
              <DriftList title="Repos only in vault" items={status.only_vault} />
              <DriftList
                title="Repo secret mismatch"
                items={status.secret_mismatch}
              />
              <DriftList
                title="Pages only on this node"
                items={status.pages.only_delegate}
              />
              <DriftList
                title="Pages only in vault"
                items={status.pages.only_vault}
              />
              <DriftList
                title="Pages secret mismatch"
                items={status.pages.secret_mismatch}
              />
            </div>
          ) : null}

          {(canPush || canPull) && (
            <div className="vault-sync-actions">
              {canPush ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={onPush}
                >
                  Push to vault
                </button>
              ) : null}
              {canPull ? (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => onPull(status.kind === "diverged")}
                >
                  {status.kind === "diverged"
                    ? "Pull from vault (overwrite)"
                    : "Pull from vault"}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {!syncBusy && !showPanel && kind === "no_vault" ? (
        <div className="vault-sync-empty">
          <p>No vault found for this identity on Freenet yet.</p>
        </div>
      ) : null}
    </section>
  );
}
