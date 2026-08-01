import { useEffect, useState } from "react";
import {
  ensurePublicGoodIdentity,
  getPublicGoodIdentity,
  type PublicGoodIdentity,
  type PublicGoodService,
} from "../freenet/public-goods";
import {
  currentIdentity,
  getCachedIdentity,
  onAuthSessionChange,
  pullPublicGoodsAuthorizationsFromVault,
} from "../freenet/auth-api";
import {
  getPublicGoodsAuthorizations,
  getPublicGoodsConsent,
  getVaultBackedPublicGoodServices,
  onPublicGoodsAuthorizationChange,
  onPublicGoodsConsentChange,
  onPublicGoodsVaultRestore,
  persistPublicGoodsAuthorizations,
  recordPublicGoodsAuthorization,
  setPublicGoodConsent,
  type PublicGoodsAuthorization,
  type PublicGoodsConsent,
} from "../freenet/public-goods-consent";

type ServiceCopy = {
  name: string;
  description: string;
  contribution: string;
};

const SERVICES: Record<PublicGoodService, ServiceCopy> = {
  kairos: {
    name: "Kairos",
    description: "The public time service. Your Kairos delegate owns the witness identity and its age history.",
    contribution: "Pulse and observe eligible Kairos work.",
  },
  tyche: {
    name: "Tyche",
    description: "The auditable randomness service. Your Tyche delegate owns the witness identity and its reputation.",
    contribution: "Pulse and contribute to already-open randomness rounds.",
  },
};

const SERVICE_ORDER: readonly PublicGoodService[] = ["kairos", "tyche"];

export function PublicGoodsSettings() {
  const [identities, setIdentities] = useState<Partial<Record<PublicGoodService, PublicGoodIdentity>>>({});
  const [authorizations, setAuthorizations] = useState<Partial<Record<PublicGoodService, PublicGoodsAuthorization>>>(() => getPublicGoodsAuthorizations());
  const [consent, setConsent] = useState<PublicGoodsConsent>(() => getPublicGoodsConsent());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<PublicGoodService | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [vaultStatus, setVaultStatus] = useState<Partial<Record<PublicGoodService, "local" | "saved" | "error">>>(() => {
    const saved: Partial<Record<PublicGoodService, "local" | "saved" | "error">> = {};
    for (const service of getVaultBackedPublicGoodServices()) saved[service] = "saved";
    return saved;
  });

  useEffect(() => {
    return onPublicGoodsAuthorizationChange(setAuthorizations);
  }, []);

  useEffect(() => {
    return onPublicGoodsVaultRestore((services) => {
      setVaultStatus((previous) => {
        const next: Partial<Record<PublicGoodService, "local" | "saved" | "error">> = {
          ...previous,
        };
        for (const service of services) next[service] = "saved";
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return onPublicGoodsConsentChange(setConsent);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      SERVICE_ORDER.map(async (service) => [service, await getPublicGoodIdentity(service)] as const),
    )
      .then((entries) => {
        if (cancelled) return;
        const next: Partial<Record<PublicGoodService, PublicGoodIdentity>> = {};
        for (const [service, identity] of entries) {
          if (identity) next[service] = identity;
        }
        setIdentities(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Website sandbox storage may reject localStorage writes. When that happens,
  // recover only missing local authorization records from the encrypted vault;
  // never replace an existing local choice (especially an explicit off choice).
  // After a fresh page load the in-memory vault-backed set is empty, so also
  // re-verify existing local records against the vault so "backed up" status
  // survives a reload.
  //
  // The Freenet sandbox often denies sessionStorage, so the GitForge identity
  // can be null at first paint — and the app-shell identity probe may complete
  // before this lazy-mounted page subscribes to onAuthSessionChange, or may
  // fail once while the websocket reconnects. That event is therefore NOT a
  // reliable re-trigger. Recovery instead drives itself: it actively probes
  // currentIdentity() and re-pulls the vault until every recorded approval is
  // confirmed backed-up, within a bounded window. It stops early as soon as
  // there is nothing left to verify.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const RETRY_DELAY_MS = 2_000;
    const MAX_ATTEMPTS = 10; // ~20s of post-reload recovery before giving up

    const hasPendingVerify = () =>
      SERVICE_ORDER.some(
        (service) =>
          getPublicGoodsAuthorizations()[service] &&
          !getVaultBackedPublicGoodServices().includes(service),
      );

    const runRecovery = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS && !cancelled; attempt += 1) {
          // Actively re-probe the session identity each attempt instead of
          // waiting for a session event that may already have fired.
          let forgeIdentity = getCachedIdentity();
          if (!forgeIdentity) {
            forgeIdentity = await currentIdentity().catch(() => null);
          }
          if (!forgeIdentity) {
            if (attempt < MAX_ATTEMPTS - 1) {
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
            continue;
          }
          const localAuthorizations = getPublicGoodsAuthorizations();
          const missing = SERVICE_ORDER.filter((service) => !localAuthorizations[service]);
          const toVerify = SERVICE_ORDER.filter(
            (service) =>
              localAuthorizations[service] &&
              !getVaultBackedPublicGoodServices().includes(service),
          );
          if (!missing.length && !toVerify.length) return; // nothing left to recover
          try {
            const records = await pullPublicGoodsAuthorizationsFromVault();
            if (records) {
              // A foreground Initialize / toggle may have completed while the vault
              // request was in flight. Re-check before applying so an old snapshot
              // cannot overwrite the newer local authorization.
              const stillMissing = missing.filter(
                (service) => !getPublicGoodsAuthorizations()[service],
              );
              if (stillMissing.length) {
                const { hydratePublicGoodsFromVault } = await import("../freenet/public-goods-consent");
                await hydratePublicGoodsFromVault(records, forgeIdentity.fingerprint, {
                  services: stillMissing,
                  canCommit: () =>
                    !cancelled &&
                    stillMissing.every((service) => !getPublicGoodsAuthorizations()[service]),
                });
              }
              if (cancelled) return;
              // Re-verify existing local records against the current vault copy.
              // A delegate GetIdentity can transiently fail right after a reload,
              // leaving a service unconfirmed — that must not stop the loop.
              const stillToVerify = SERVICE_ORDER.filter(
                (service) =>
                  getPublicGoodsAuthorizations()[service] &&
                  !getVaultBackedPublicGoodServices().includes(service),
              );
              if (stillToVerify.length) {
                const { verifyPublicGoodsAuthorizationsAgainstVault } = await import(
                  "../freenet/public-goods-consent",
                );
                await verifyPublicGoodsAuthorizationsAgainstVault(
                  records,
                  forgeIdentity.fingerprint,
                  { services: stillToVerify },
                );
              }
              if (cancelled) return;
              // Only stop when every recorded approval is actually confirmed
              // backed-up; a transient failure must fall through to retry.
              if (!hasPendingVerify()) return;
            } else if (!hasPendingVerify()) {
              // No local approvals to verify and the vault has nothing to
              // restore — there is no recovery work left. Stop instead of
              // burning the retry window.
              return;
            }
          } catch {
            // Node/vault not reachable yet — retry.
          }
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          }
        }
      } finally {
        inFlight = false;
      }
    };

    void runRecovery();
    const unsubscribeSession = onAuthSessionChange(() => {
      if (cancelled) return;
      void runRecovery();
    });
    return () => {
      cancelled = true;
      unsubscribeSession();
    };
  }, [identities]);

  const initialize = async (service: PublicGoodService) => {
    setBusy(service);
    setError(null);
    setMessage(null);
    try {
      const identity = await ensurePublicGoodIdentity(service);
      const forgeIdentity = getCachedIdentity();
      if (!forgeIdentity) throw new Error("GitForge identity is not available");
      const authorization = recordPublicGoodsAuthorization(
        forgeIdentity.fingerprint,
        identity,
      );
      setIdentities((previous) => ({ ...previous, [service]: identity }));
      setAuthorizations((previous) => ({ ...previous, [service]: authorization }));
      const persisted = await persistPublicGoodsAuthorizations();
      setVaultStatus((previous) => ({ ...previous, [service]: persisted ? "saved" : "local" }));
      setMessage(
        persisted
          ? `${SERVICES[service].name} identity is ready and its approval is backed up in the account vault. Review and enable background contribution below when you are ready.`
          : `${SERVICES[service].name} identity is ready. The approval is local for now; account-vault backup is unavailable.`,
      );
    } catch (err: unknown) {
      setError(
        `${SERVICES[service].name} could not initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (service: PublicGoodService, enabled: boolean) => {
    setError(null);
    setMessage(null);
    const nextAuthorization = authorizations[service];
    if (!nextAuthorization) {
      setError("Initialize this service identity first so the approval can be recorded.");
      return;
    }
    setConsent(setPublicGoodConsent(service, enabled));
    const updatedAuthorization = {
      ...nextAuthorization,
      consented_at: enabled
        ? nextAuthorization.consented_at ?? Date.now()
        : nextAuthorization.consented_at,
      background_enabled: enabled,
    };
    setAuthorizations((previous) => ({ ...previous, [service]: updatedAuthorization }));
    const persisted = await persistPublicGoodsAuthorizations();
    setVaultStatus((previous) => ({ ...previous, [service]: persisted ? "saved" : "error" }));
    setMessage(
      persisted
        ? enabled
          ? `${SERVICES[service].name} background contribution enabled and backed up in the account vault.`
          : `${SERVICES[service].name} background contribution paused and backed up. Its identity was not deleted.`
        : `${SERVICES[service].name} changed locally, but account-vault backup is unavailable.`,
    );
  };

  return (
    <>
      <header className="settings-header">
        <h1>Public goods</h1>
        <p className="muted">
          GitForge can contribute to Kairos and Tyche using identities owned by
          those services. Nothing here creates a GitForge key or shares your
          GitForge identity. Background contribution is off until you explicitly
          initialize a service and enable it.
        </p>
      </header>

      {error ? <div className="public-goods-notice error-banner">{error}</div> : null}
      {message ? <div className="public-goods-notice settings-success">{message}</div> : null}
      <div className="public-goods-policy">
        <strong>What consent means here</strong>
        <span>
          This is an explicit app-level permission remembered on this browser.
          The service delegate still keeps the private key; Freenet does not
          currently cryptographically prove that a request came from a click.
          The Kairos or Tyche identity delegate must already be installed on
          this node before initialization can succeed.
        </span>
      </div>

      <div className="public-goods-list">
        {SERVICE_ORDER.map((service) => {
          const copy = SERVICES[service];
          const identity = identities[service];
          const authorization = authorizations[service];
          const serviceBusy = busy === service;
          const forgeIdentity = getCachedIdentity();
          const authorizationMatches = Boolean(
            authorization &&
            forgeIdentity &&
            authorization.gitforge_identity_fingerprint === forgeIdentity.fingerprint &&
            identity &&
            authorization.service_node_id === identity.nodeId,
          );
          return (
            <article className="public-goods-card" key={service}>
              <div className="public-goods-card-heading">
                <div>
                  <h2>{copy.name}</h2>
                  <p className="muted">{copy.description}</p>
                </div>
                <span className={identity ? "public-goods-status ready" : "public-goods-status"}>
                  {loading && !identity ? "Checking" : identity ? "Identity ready" : "Not initialized"}
                </span>
              </div>
              <p className="public-goods-contribution">{copy.contribution}</p>
              {identity ? (
                <div className="public-goods-identity">
                  <span className="muted tiny">Service-owned witness</span>
                  <span className="mono tiny break">{identity.label} · {identity.nodeId}</span>
                  <span className={authorizationMatches && vaultStatus[service] === "saved" ? "public-goods-vault-status saved" : "public-goods-vault-status"}>
                    {authorizationMatches && vaultStatus[service] === "saved"
                      ? "Approval backed up in account vault"
                      : vaultStatus[service] === "error"
                        ? "Approval is local; vault backup failed"
                        : authorizationMatches
                          ? "Approval recorded locally; vault status not confirmed"
                          : "Approval not recorded for this service identity"}
                  </span>
                </div>
              ) : null}
              <div className="public-goods-actions">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={serviceBusy}
                  onClick={() => void initialize(service)}
                >
                  {serviceBusy ? "Contacting service…" : identity ? "Verify / initialize identity" : "Initialize service identity"}
                </button>
                <label className="settings-check public-goods-toggle">
                  <input
                    type="checkbox"
                    checked={consent[service] && authorizationMatches && authorization?.background_enabled === true}
                    disabled={!identity || !authorizationMatches || serviceBusy}
                    onChange={(event) => {
                      void toggle(service, event.target.checked);
                    }}
                  />
                  <span>
                    <strong>Allow background contribution</strong>
                    <span className="muted block tiny">
                      {authorizationMatches
                        ? "Uses this matching service identity only; no new identity is created by the worker."
                        : "Initialize and approve this service identity first."}
                    </span>
                  </span>
                </label>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
