/**
 * Protect prefs + vault-remembered grant intent.
 *
 * Freenet `__sandbox=1` denies localStorage (null origin) — keep a tab-lifetime
 * memory mirror so checkboxes and restore lists still work.
 *
 * Vault stores intent (Layer A + scopes). Live pins live on the node; Layer A
 * on the node is required to validate / re-mint remembered scopes.
 */

import type { ScopePolicy } from "./local-protect";
import {
  brandStorageKey,
  readLocalStorage,
  writeLocalStorage,
} from "../lib/brand-storage";

export interface ProtectPrefs {
  autoProtectOwnRepos: boolean;
  autoProtectStars: boolean;
}

export interface RememberedProtectScope {
  grant_id: string;
  anchor_key: string;
  policy?: ScopePolicy;
  label?: string;
}

/** Full local_protect bag sealed in ForgeVault settings. */
export interface ProtectVaultIntent {
  autoProtectOwnRepos?: boolean;
  autoProtectStars?: boolean;
  /** Intent: website may use Protect (Layer A). Restoring requires shell Authorize. */
  app_granted?: boolean;
  scopes?: RememberedProtectScope[];
}

export const DEFAULT_PROTECT_PREFS: ProtectPrefs = {
  autoProtectOwnRepos: false,
  autoProtectStars: false,
};

const PREFS_KEY = brandStorageKey("protect.prefs");
const INTENT_KEY = brandStorageKey("protect.intent");
const PREFS_EVENT = "gitforge-protect-prefs";
const INTENT_EVENT = "gitforge-protect-intent";

/** Tab-lifetime mirror when localStorage is unavailable. */
let memoryPrefs: ProtectPrefs | null = null;
let memoryIntent: ProtectVaultIntent | null = null;

function normalizePrefs(j: Partial<ProtectPrefs> | null | undefined): ProtectPrefs {
  return {
    autoProtectOwnRepos: Boolean(j?.autoProtectOwnRepos),
    autoProtectStars: Boolean(j?.autoProtectStars),
  };
}

function normalizeScope(s: RememberedProtectScope): RememberedProtectScope | null {
  const grant_id = (s.grant_id ?? "").trim();
  const anchor_key = (s.anchor_key ?? "").trim();
  if (!grant_id || !anchor_key) return null;
  let policy: ScopePolicy | undefined;
  if (s.policy && typeof s.policy === "object") {
    const kind =
      s.policy.kind === "anchor_plus_members" ? "anchor_plus_members" : "single";
    policy = {
      kind,
      member_hint: s.policy.member_hint,
    };
  }
  return {
    grant_id,
    anchor_key,
    policy,
    label: s.label?.trim() || undefined,
  };
}

export function normalizeProtectVaultIntent(
  j: ProtectVaultIntent | null | undefined | Record<string, unknown>,
): ProtectVaultIntent {
  const raw = (j ?? {}) as ProtectVaultIntent;
  const scopes: RememberedProtectScope[] = [];
  const seen = new Set<string>();
  for (const item of raw.scopes ?? []) {
    const s = normalizeScope(item as RememberedProtectScope);
    if (!s || seen.has(s.grant_id)) continue;
    seen.add(s.grant_id);
    scopes.push(s);
  }
  return {
    autoProtectOwnRepos: Boolean(raw.autoProtectOwnRepos),
    autoProtectStars: Boolean(raw.autoProtectStars),
    app_granted: Boolean(raw.app_granted),
    scopes,
  };
}

export function getProtectPrefs(): ProtectPrefs {
  if (memoryPrefs) return { ...memoryPrefs };
  try {
    const raw = readLocalStorage(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PROTECT_PREFS };
    const parsed = normalizePrefs(JSON.parse(raw) as Partial<ProtectPrefs>);
    memoryPrefs = parsed;
    return { ...parsed };
  } catch {
    return { ...(memoryPrefs ?? DEFAULT_PROTECT_PREFS) };
  }
}

export function setProtectPrefs(prefs: ProtectPrefs): ProtectPrefs {
  const next = normalizePrefs(prefs);
  memoryPrefs = next;
  writeLocalStorage(PREFS_KEY, JSON.stringify(next));
  // Keep intent prefs in sync for vault seals.
  const intent = getProtectVaultIntent();
  intent.autoProtectOwnRepos = next.autoProtectOwnRepos;
  intent.autoProtectStars = next.autoProtectStars;
  writeIntentLocal(intent);
  try {
    window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next }));
  } catch {
    /* ignore */
  }
  void pushProtectIntentToVaultBestEffort();
  return next;
}

export function onProtectPrefsChanged(cb: (prefs: ProtectPrefs) => void): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<ProtectPrefs>).detail;
    cb(detail ?? getProtectPrefs());
  };
  window.addEventListener(PREFS_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(PREFS_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

function writeIntentLocal(intent: ProtectVaultIntent): void {
  memoryIntent = normalizeProtectVaultIntent(intent);
  writeLocalStorage(INTENT_KEY, JSON.stringify(memoryIntent));
  try {
    window.dispatchEvent(
      new CustomEvent(INTENT_EVENT, { detail: memoryIntent }),
    );
  } catch {
    /* ignore */
  }
}

export function getProtectVaultIntent(): ProtectVaultIntent {
  if (memoryIntent) return normalizeProtectVaultIntent(memoryIntent);
  try {
    const raw = readLocalStorage(INTENT_KEY);
    if (raw) {
      memoryIntent = normalizeProtectVaultIntent(
        JSON.parse(raw) as ProtectVaultIntent,
      );
      return normalizeProtectVaultIntent(memoryIntent);
    }
  } catch {
    /* sandbox */
  }
  const prefs = getProtectPrefs();
  return {
    autoProtectOwnRepos: prefs.autoProtectOwnRepos,
    autoProtectStars: prefs.autoProtectStars,
    app_granted: false,
    scopes: [],
  };
}

/** Apply vault/remote intent without pushing back. */
export function applyProtectIntentFromRemote(
  remote: ProtectVaultIntent | null | undefined | Record<string, unknown>,
): ProtectVaultIntent {
  const next = normalizeProtectVaultIntent(remote);
  writeIntentLocal(next);
  memoryPrefs = {
    autoProtectOwnRepos: Boolean(next.autoProtectOwnRepos),
    autoProtectStars: Boolean(next.autoProtectStars),
  };
  writeLocalStorage(PREFS_KEY, JSON.stringify(memoryPrefs));
  try {
    window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: memoryPrefs }));
  } catch {
    /* ignore */
  }
  return next;
}

export function rememberProtectScope(scope: RememberedProtectScope): ProtectVaultIntent {
  const intent = getProtectVaultIntent();
  const normalized = normalizeScope(scope);
  if (!normalized) return intent;
  const scopes = (intent.scopes ?? []).filter(
    (s) => s.grant_id !== normalized.grant_id,
  );
  scopes.push(normalized);
  intent.scopes = scopes;
  intent.app_granted = true;
  writeIntentLocal(intent);
  void pushProtectIntentToVaultBestEffort();
  return intent;
}

export function forgetProtectScope(grantId: string): ProtectVaultIntent {
  const intent = getProtectVaultIntent();
  intent.scopes = (intent.scopes ?? []).filter((s) => s.grant_id !== grantId);
  writeIntentLocal(intent);
  void pushProtectIntentToVaultBestEffort();
  return intent;
}

export function setProtectAppGrantedIntent(granted: boolean): ProtectVaultIntent {
  const intent = getProtectVaultIntent();
  intent.app_granted = granted;
  // Keep remembered scopes when Layer A is revoked on the node — vault intent
  // is the recovery list; node cascade clears live pins only.
  writeIntentLocal(intent);
  void pushProtectIntentToVaultBestEffort();
  return intent;
}

export function onProtectIntentChanged(
  cb: (intent: ProtectVaultIntent) => void,
): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<ProtectVaultIntent>).detail;
    cb(detail ?? getProtectVaultIntent());
  };
  window.addEventListener(INTENT_EVENT, handler);
  return () => window.removeEventListener(INTENT_EVENT, handler);
}

async function pushProtectIntentToVaultBestEffort(): Promise<void> {
  try {
    const { pushProtectIntentToVault } = await import("./auth-api");
    await pushProtectIntentToVault(getProtectVaultIntent());
  } catch (err) {
    console.warn(
      "[freenet-forge] protect intent vault persist failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Stable fingerprint for equality (order-independent scopes). */
export function fingerprintProtectIntent(intent: ProtectVaultIntent): string {
  const n = normalizeProtectVaultIntent(intent);
  const scopeKeys = (n.scopes ?? [])
    .map((s) => `${s.grant_id}|${s.anchor_key}`)
    .sort();
  return JSON.stringify({
    a: Boolean(n.app_granted),
    o: Boolean(n.autoProtectOwnRepos),
    s: Boolean(n.autoProtectStars),
    g: scopeKeys,
  });
}

export function summarizeProtectIntent(intent: ProtectVaultIntent): {
  appGranted: boolean;
  scopeCount: number;
  autoOwn: boolean;
  autoStars: boolean;
} {
  const n = normalizeProtectVaultIntent(intent);
  return {
    appGranted: Boolean(n.app_granted),
    scopeCount: n.scopes?.length ?? 0,
    autoOwn: Boolean(n.autoProtectOwnRepos),
    autoStars: Boolean(n.autoProtectStars),
  };
}

export type ProtectIntentSyncKind =
  | "in_sync"
  | "vault_behind"
  | "local_behind"
  | "diverged"
  | "no_vault"
  | "both_empty";

export interface ProtectIntentCompare {
  kind: ProtectIntentSyncKind;
  local: ProtectVaultIntent;
  vault: ProtectVaultIntent | null;
  localSummary: ReturnType<typeof summarizeProtectIntent>;
  vaultSummary: ReturnType<typeof summarizeProtectIntent> | null;
  /** Scope grant_ids only on local */
  onlyLocal: string[];
  /** Scope grant_ids only in vault */
  onlyVault: string[];
  prefsDiffer: boolean;
  appGrantedDiffer: boolean;
}

function intentIsEmpty(intent: ProtectVaultIntent): boolean {
  const n = normalizeProtectVaultIntent(intent);
  return (
    !n.app_granted &&
    !(n.scopes?.length) &&
    !n.autoProtectOwnRepos &&
    !n.autoProtectStars
  );
}

export async function compareProtectIntent(): Promise<ProtectIntentCompare> {
  const local = getProtectVaultIntent();
  const localSummary = summarizeProtectIntent(local);
  let vault: ProtectVaultIntent | null = null;
  try {
    const { pullProtectIntentFromVault } = await import("./auth-api");
    const raw = await pullProtectIntentFromVault();
    vault = raw ? normalizeProtectVaultIntent(raw) : null;
  } catch {
    vault = null;
  }

  if (!vault) {
    return {
      kind: intentIsEmpty(local) ? "both_empty" : "no_vault",
      local,
      vault: null,
      localSummary,
      vaultSummary: null,
      onlyLocal: (local.scopes ?? []).map((s) => s.grant_id),
      onlyVault: [],
      prefsDiffer: false,
      appGrantedDiffer: false,
    };
  }

  const vaultSummary = summarizeProtectIntent(vault);
  const localIds = new Set((local.scopes ?? []).map((s) => s.grant_id));
  const vaultIds = new Set((vault.scopes ?? []).map((s) => s.grant_id));
  const onlyLocal = [...localIds].filter((id) => !vaultIds.has(id)).sort();
  const onlyVault = [...vaultIds].filter((id) => !localIds.has(id)).sort();
  const prefsDiffer =
    Boolean(local.autoProtectOwnRepos) !== Boolean(vault.autoProtectOwnRepos) ||
    Boolean(local.autoProtectStars) !== Boolean(vault.autoProtectStars);
  const appGrantedDiffer =
    Boolean(local.app_granted) !== Boolean(vault.app_granted);

  if (fingerprintProtectIntent(local) === fingerprintProtectIntent(vault)) {
    return {
      kind: "in_sync",
      local,
      vault,
      localSummary,
      vaultSummary,
      onlyLocal: [],
      onlyVault: [],
      prefsDiffer: false,
      appGrantedDiffer: false,
    };
  }

  if (intentIsEmpty(local) && !intentIsEmpty(vault)) {
    return {
      kind: "local_behind",
      local,
      vault,
      localSummary,
      vaultSummary,
      onlyLocal,
      onlyVault,
      prefsDiffer,
      appGrantedDiffer,
    };
  }
  if (!intentIsEmpty(local) && intentIsEmpty(vault)) {
    return {
      kind: "vault_behind",
      local,
      vault,
      localSummary,
      vaultSummary,
      onlyLocal,
      onlyVault,
      prefsDiffer,
      appGrantedDiffer,
    };
  }

  // One-sided scope drift without prefs/app conflict → behind; else diverged.
  if (
    !prefsDiffer &&
    !appGrantedDiffer &&
    onlyLocal.length > 0 &&
    onlyVault.length === 0
  ) {
    return {
      kind: "vault_behind",
      local,
      vault,
      localSummary,
      vaultSummary,
      onlyLocal,
      onlyVault,
      prefsDiffer,
      appGrantedDiffer,
    };
  }
  if (
    !prefsDiffer &&
    !appGrantedDiffer &&
    onlyVault.length > 0 &&
    onlyLocal.length === 0
  ) {
    return {
      kind: "local_behind",
      local,
      vault,
      localSummary,
      vaultSummary,
      onlyLocal,
      onlyVault,
      prefsDiffer,
      appGrantedDiffer,
    };
  }

  return {
    kind: "diverged",
    local,
    vault,
    localSummary,
    vaultSummary,
    onlyLocal,
    onlyVault,
    prefsDiffer,
    appGrantedDiffer,
  };
}

/** Push this device’s Protect intent to the vault (source of truth = local). */
export async function pushProtectIntentFromLocal(): Promise<ProtectVaultIntent> {
  const local = getProtectVaultIntent();
  writeIntentLocal(local);
  const { pushProtectIntentToVault } = await import("./auth-api");
  await pushProtectIntentToVault(local);
  return local;
}

/** Pull vault Protect intent onto this device (source of truth = vault). */
export async function pullProtectIntentFromVaultAsTruth(): Promise<ProtectVaultIntent> {
  const { pullProtectIntentFromVault } = await import("./auth-api");
  const raw = await pullProtectIntentFromVault();
  if (!raw) return getProtectVaultIntent();
  return applyProtectIntentFromRemote(raw);
}

/**
 * Hydrate from vault without stomping on conflicts.
 * - in_sync / both empty: no change
 * - local empty, vault has data: auto-apply vault (intent only — no node mint)
 * - vault empty, local has data: push local (best-effort)
 * - one-sided behind: auto-apply the non-empty / richer side for intent storage
 * - diverged: leave local as-is; UI must ask the user
 */
export async function hydrateProtectIntentFromVault(): Promise<{
  intent: ProtectVaultIntent;
  compare: ProtectIntentCompare;
  autoApplied: "none" | "vault" | "local_pushed";
}> {
  const compare = await compareProtectIntent();
  if (compare.kind === "in_sync" || compare.kind === "both_empty") {
    return {
      intent: getProtectVaultIntent(),
      compare,
      autoApplied: "none",
    };
  }
  if (compare.kind === "local_behind" && compare.vault) {
    const intent = applyProtectIntentFromRemote(compare.vault);
    return { intent, compare: await compareProtectIntent(), autoApplied: "vault" };
  }
  if (compare.kind === "vault_behind" || compare.kind === "no_vault") {
    try {
      await pushProtectIntentFromLocal();
      return {
        intent: getProtectVaultIntent(),
        compare: await compareProtectIntent(),
        autoApplied: "local_pushed",
      };
    } catch {
      return {
        intent: getProtectVaultIntent(),
        compare,
        autoApplied: "none",
      };
    }
  }
  // diverged — do not auto-merge
  return {
    intent: getProtectVaultIntent(),
    compare,
    autoApplied: "none",
  };
}

