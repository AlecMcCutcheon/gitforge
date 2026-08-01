import type { PublicGoodIdentity, PublicGoodService } from "./public-goods";
import type { PublicGoodAuthorization as VaultPublicGoodAuthorization } from "./vault-crypto";
import {
  brandStorageKey,
  readLocalStorage,
  writeLocalStorage,
} from "../lib/brand-storage";

export type PublicGoodsConsent = Record<PublicGoodService, boolean>;
export type PublicGoodsAuthorization = VaultPublicGoodAuthorization;

const CONSENT_KEY = brandStorageKey("public-goods.consent.v1");
const AUTHORIZATION_KEY = brandStorageKey("public-goods.authorization.v1");
const CONSENT_EVENT = "gitforge-public-goods-consent";
const DEFAULT_CONSENT: PublicGoodsConsent = { kairos: false, tyche: false };
let cached: PublicGoodsConsent | null = null;
let cachedAuthorizations: Partial<Record<PublicGoodService, PublicGoodsAuthorization>> | null = null;
let persistQueue: Promise<boolean> = Promise.resolve(true);
let vaultBackedServices = new Set<PublicGoodService>();
const AUTHORIZATION_EVENT = "gitforge-public-goods-authorization";
const VAULT_RESTORE_EVENT = "gitforge-public-goods-vault-restore";

function normalizeConsent(
  value: Partial<PublicGoodsConsent> | null | undefined,
): PublicGoodsConsent {
  return {
    kairos: value?.kairos === true,
    tyche: value?.tyche === true,
  };
}

function normalizeAuthorization(
  value: PublicGoodsAuthorization | null | undefined,
): PublicGoodsAuthorization | null {
  if (!value || (value.service !== "kairos" && value.service !== "tyche")) return null;
  if (!value.gitforge_identity_fingerprint || !value.service_node_id || !value.service_label) return null;
  if (!Number.isFinite(value.initialized_at)) return null;
  return {
    service: value.service,
    gitforge_identity_fingerprint: value.gitforge_identity_fingerprint,
    service_node_id: value.service_node_id,
    service_label: value.service_label,
    initialized_at: value.initialized_at,
    consented_at: value.consented_at == null ? null : value.consented_at,
    background_enabled: value.background_enabled === true,
  };
}

export function sameAuthorization(
  local: PublicGoodsAuthorization | undefined,
  record: PublicGoodsAuthorization,
): boolean {
  return Boolean(
    local &&
      local.gitforge_identity_fingerprint === record.gitforge_identity_fingerprint &&
      local.service_node_id === record.service_node_id &&
      local.service_label === record.service_label &&
      local.initialized_at === record.initialized_at &&
      local.consented_at === record.consented_at &&
      local.background_enabled === record.background_enabled,
  );
}

function readAuthorizations(): Partial<Record<PublicGoodService, PublicGoodsAuthorization>> {
  if (cachedAuthorizations) return { ...cachedAuthorizations };
  const raw = readLocalStorage(AUTHORIZATION_KEY);
  if (!raw) {
    cachedAuthorizations = {};
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<PublicGoodService, PublicGoodsAuthorization>>;
    const next: Partial<Record<PublicGoodService, PublicGoodsAuthorization>> = {};
    for (const service of ["kairos", "tyche"] as const) {
      const auth = normalizeAuthorization(parsed?.[service]);
      if (auth) next[service] = auth;
    }
    cachedAuthorizations = next;
  } catch {
    cachedAuthorizations = {};
  }
  return { ...cachedAuthorizations };
}

function writeAuthorizations(
  authorizations: Partial<Record<PublicGoodService, PublicGoodsAuthorization>>,
): void {
  cachedAuthorizations = { ...authorizations };
  writeLocalStorage(AUTHORIZATION_KEY, JSON.stringify(cachedAuthorizations));
  try {
    window.dispatchEvent(
      new CustomEvent(AUTHORIZATION_EVENT, {
        detail: { ...cachedAuthorizations },
      }),
    );
  } catch {
    /* non-browser/test environment */
  }
}

function dispatchConsent(): void {
  try {
    window.dispatchEvent(
      new CustomEvent(CONSENT_EVENT, {
        detail: { ...getPublicGoodsConsent() },
      }),
    );
  } catch {
    /* non-browser/test environment */
  }
}

export function getPublicGoodsConsent(): PublicGoodsConsent {
  if (cached) return { ...cached };
  const raw = readLocalStorage(CONSENT_KEY);
  if (!raw) {
    cached = { ...DEFAULT_CONSENT };
    return { ...cached };
  }
  try {
    cached = normalizeConsent(JSON.parse(raw) as Partial<PublicGoodsConsent>);
  } catch {
    cached = { ...DEFAULT_CONSENT };
  }
  return { ...cached };
}

export function getPublicGoodsAuthorizations(): Partial<Record<PublicGoodService, PublicGoodsAuthorization>> {
  return readAuthorizations();
}

/**
 * Record that this GitForge identity explicitly initialized/approved the
 * current service-owned identity. This stores metadata only; no service secret
 * or capability is copied out of the service delegate.
 */
export function recordPublicGoodsAuthorization(
  gitforgeIdentityFingerprint: string,
  identity: PublicGoodIdentity,
): PublicGoodsAuthorization {
  const current = readAuthorizations()[identity.service];
  const sameIdentity = current?.service_node_id === identity.nodeId;
  const next: PublicGoodsAuthorization = {
    service: identity.service,
    gitforge_identity_fingerprint: gitforgeIdentityFingerprint,
    service_node_id: identity.nodeId,
    service_label: identity.label,
    initialized_at: sameIdentity ? current.initialized_at : Date.now(),
    consented_at: sameIdentity ? current.consented_at : null,
    background_enabled: sameIdentity ? current.background_enabled : false,
  };
  const authorizations = { ...readAuthorizations(), [identity.service]: next };
  writeAuthorizations(authorizations);
  return next;
}

/** Update local contribution consent without changing the approved identity. */
export function setPublicGoodConsent(
  service: PublicGoodService,
  enabled: boolean,
): PublicGoodsConsent {
  const next = { ...getPublicGoodsConsent(), [service]: enabled };
  cached = normalizeConsent(next);
  writeLocalStorage(CONSENT_KEY, JSON.stringify(cached));
  const authorizations = readAuthorizations();
  const authorization = authorizations[service];
  if (authorization) {
    authorizations[service] = {
      ...authorization,
      consented_at: enabled ? authorization.consented_at ?? Date.now() : authorization.consented_at,
      background_enabled: enabled,
    };
    writeAuthorizations(authorizations);
  }
  dispatchConsent();
  return { ...cached };
}

/**
 * Restore remembered approvals only when they belong to the current GitForge
 * identity and the live service delegate still reports the same identity.
 * Never calls EnsureIdentity. The vault record is authoritative for active
 * contribution: a missing, mismatched, or stale record clears the local active
 * approval instead of allowing an old browser checkbox to revive duty.
 */
export async function hydratePublicGoodsFromVault(
  records: Partial<Record<PublicGoodService, PublicGoodsAuthorization>> | undefined,
  gitforgeIdentityFingerprint: string,
  options?: {
    services?: readonly PublicGoodService[];
    canCommit?: () => boolean;
  },
): Promise<PublicGoodsConsent> {
  // A restore without a public-goods field is authoritative too: clear any
  // browser-local active approval so an older checkbox cannot revive duty.
  // The user can explicitly initialize/approve the service again afterward.
  const { getPublicGoodIdentity } = await import("./public-goods");
  const nextAuthorizations = readAuthorizations();
  const nextConsent = getPublicGoodsConsent();
  const services = options?.services ?? (["kairos", "tyche"] as const);
  const validatedRecords = new Map<PublicGoodService, PublicGoodsAuthorization>();

  for (const service of services) {
    const record = normalizeAuthorization(records?.[service]);
    if (!record || record.gitforge_identity_fingerprint !== gitforgeIdentityFingerprint) {
      delete nextAuthorizations[service];
      nextConsent[service] = false;
      continue;
    }
    const live = await getPublicGoodIdentity(service).catch(() => null);
    const matches = Boolean(
      live && live.nodeId === record.service_node_id && live.label === record.service_label,
    );
    if (!matches) {
      delete nextAuthorizations[service];
      nextConsent[service] = false;
      continue;
    }
    nextAuthorizations[service] = {
      ...record,
      background_enabled: record.background_enabled,
    };
    validatedRecords.set(service, record);
    nextConsent[service] = record.background_enabled;
  }

  // Commit synchronously from the latest local snapshot. A foreground
  // initialize/toggle may have completed while GetIdentity was awaiting; keep
  // that newer local choice instead of replacing it with this older vault read.
  if (options?.canCommit && !options.canCommit()) return getPublicGoodsConsent();
  const latestAuthorizations = readAuthorizations();
  const latestConsent = getPublicGoodsConsent();
  for (const service of services) {
    if (latestAuthorizations[service]) {
      nextAuthorizations[service] = latestAuthorizations[service];
      nextConsent[service] = latestConsent[service];
    }
  }
  // Preserve known vault-backed status for services outside a partial recovery,
  // but only add a recovered service if the final local record still exactly
  // matches the vault record we validated. A local toggle that happened while
  // validation was in flight is newer and is not yet backed up.
  const finalAuthorizations = readAuthorizations();
  for (const service of services) vaultBackedServices.delete(service);
  for (const [service, record] of validatedRecords) {
    if (sameAuthorization(finalAuthorizations[service], record)) {
      vaultBackedServices.add(service);
    }
  }
  writeAuthorizations(nextAuthorizations);
  cached = normalizeConsent(nextConsent);
  writeLocalStorage(CONSENT_KEY, JSON.stringify(cached));
  try {
    window.dispatchEvent(
      new CustomEvent(VAULT_RESTORE_EVENT, {
        detail: {
          // Report every valid recovered record as vault-backed. The UI must
          // distinguish "saved but off" from "not saved".
          services: [...vaultBackedServices],
        },
      }),
    );
  } catch {
    /* non-browser/test environment */
  }
  dispatchConsent();
  return getPublicGoodsConsent();
}

/**
 * Re-confirm that existing local authorizations are still present in the
 * encrypted vault — the "approval is backed up" status lives only in an
 * in-memory set that resets on every page load. Read-only: never writes local
 * state, never clears a record, never enables contribution, and never calls
 * EnsureIdentity. A service is only re-marked vault-backed when the vault copy
 * exactly matches the current local record and the live service identity still
 * matches, so a newer local choice is never falsely labeled backed up.
 */
export async function verifyPublicGoodsAuthorizationsAgainstVault(
  records: Partial<Record<PublicGoodService, PublicGoodsAuthorization>> | undefined,
  gitforgeIdentityFingerprint: string,
  options?: {
    services?: readonly PublicGoodService[];
  },
): Promise<void> {
  const { getPublicGoodIdentity } = await import("./public-goods");
  const services = options?.services ?? (["kairos", "tyche"] as const);
  const initial = readAuthorizations();
  const candidate = new Map<PublicGoodService, PublicGoodsAuthorization>();

  for (const service of services) {
    const local = initial[service];
    const record = normalizeAuthorization(records?.[service]);
    if (!local || !record) continue;
    if (record.gitforge_identity_fingerprint !== gitforgeIdentityFingerprint) continue;
    if (!sameAuthorization(local, record)) {
      continue; // local is newer than the vault copy; not yet backed up
    }
    const live = await getPublicGoodIdentity(service).catch(() => null);
    if (
      !live ||
      live.nodeId !== record.service_node_id ||
      live.label !== record.service_label
    ) {
      continue;
    }
    candidate.set(service, record);
  }
  if (!candidate.size) return;

  // Re-check against the freshest local snapshot so a toggle that landed while
  // GetIdentity was awaiting cannot be marked backed up by this stale read.
  const confirmed: PublicGoodService[] = [];
  const latest = readAuthorizations();
  for (const [service, record] of candidate) {
    if (sameAuthorization(latest[service], record)) confirmed.push(service);
  }
  if (!confirmed.length) return;

  vaultBackedServices = new Set([...vaultBackedServices, ...confirmed]);
  try {
    window.dispatchEvent(
      new CustomEvent(VAULT_RESTORE_EVENT, {
        detail: { services: [...vaultBackedServices] },
      }),
    );
  } catch {
    /* non-browser/test environment */
  }
}

/**
 * Persist the current authorization records into the encrypted ForgeVault
 * settings envelope. The queue prevents concurrent settings updates from
 * racing when two UI controls change close together.
 */
export function persistPublicGoodsAuthorizations(): Promise<boolean> {
  const records = getPublicGoodsAuthorizations();
  persistQueue = persistQueue.then(async () => {
    const { pushPublicGoodsAuthorizationsToVault } = await import("./auth-api");
    const saved = await pushPublicGoodsAuthorizationsToVault(records);
    if (saved) {
      vaultBackedServices = new Set(
        (["kairos", "tyche"] as const).filter((service) => Boolean(records[service])),
      );
    }
    return saved;
  }).catch((error: unknown) => {
    console.warn(
      "[freenet-forge] public-goods authorization vault persist failed",
      error instanceof Error ? error.message : error,
    );
    return false;
  });
  return persistQueue;
}

export function getVaultBackedPublicGoodServices(): PublicGoodService[] {
  return [...vaultBackedServices];
}

export function onPublicGoodsVaultRestore(
  listener: (services: PublicGoodService[]) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ services?: PublicGoodService[] }>).detail;
    listener(detail?.services ?? []);
  };
  window.addEventListener(VAULT_RESTORE_EVENT, handler);
  return () => window.removeEventListener(VAULT_RESTORE_EVENT, handler);
}

export function onPublicGoodsAuthorizationChange(
  listener: (
    authorizations: Partial<Record<PublicGoodService, PublicGoodsAuthorization>>,
  ) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Partial<Record<PublicGoodService, PublicGoodsAuthorization>>>).detail;
    listener(detail ?? getPublicGoodsAuthorizations());
  };
  window.addEventListener(AUTHORIZATION_EVENT, handler);
  return () => window.removeEventListener(AUTHORIZATION_EVENT, handler);
}

export function onPublicGoodsConsentChange(
  listener: (consent: PublicGoodsConsent) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Partial<PublicGoodsConsent>>).detail;
    listener(normalizeConsent(detail));
  };
  window.addEventListener(CONSENT_EVENT, handler);
  return () => window.removeEventListener(CONSENT_EVENT, handler);
}
