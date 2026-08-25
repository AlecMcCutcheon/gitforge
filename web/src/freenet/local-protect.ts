/**
 * Optional local-contract-protect client.
 * Hidden when the node does not advertise `local_contract_protect` on /v1/features.
 *
 * Layer A: app grant (request-grant / revoke-app).
 * Layer B: scoped grants (create-scope / revoke-scope / sync-scope).
 * Apps must not bare-Protect; membership expansion is app-side.
 */

import { FORGE_WEBSITE_CONTRACT_KEY } from "./website-constants";
import {
  protectIdentityGrantId,
  protectLegacyGrantId,
  protectRepoGrantId,
} from "../lib/brand";

export interface LocalProtectFeature {
  api_version: number;
  protect_pct: number;
  http_prefix: string;
}

export interface FeaturesResponse {
  version: number;
  capabilities: string[];
  local_contract_protect?: LocalProtectFeature;
}

export interface ProtectScopeItem {
  id: string;
  label: string;
  detail?: string;
  access?: string;
}

export interface ProtectPresentation {
  title?: string;
  subtitle?: string;
  app_name?: string;
  app_logo_b64?: string;
  user_avatar_b64?: string;
  contract_id: string;
  scopes?: ProtectScopeItem[];
  custom_css?: string;
  redirect_hint?: string;
}

export type ScopePolicyKind = "single" | "anchor_plus_members";

export type TipRetention = "current" | "last_n" | "all";

/**
 * Generic membership recipe stored in scope policy (opaque to freenet-core).
 * Field paths / state_label are app-defined — not required to be "RepoState".
 */
export interface MembershipSpec {
  /** App recipe id, e.g. "freenet-git.tip-packs" or "myapp.blob-children". */
  recipe_id: string;
  /** Short sentence shown in the scope request UI. */
  summary: string;
  from_anchor: {
    /** App-chosen name for the parent state document. */
    state_label: string;
    /** Field paths on that state that yield child content ids. */
    child_id_fields: string[];
    /** How those ids become Freenet contract keys (app-defined). */
    keying: string;
  };
  retention?: {
    mode: TipRetention;
    last_n?: number;
  };
}

export interface ScopePolicy {
  kind: ScopePolicyKind;
  member_hint?: MembershipSpec | Record<string, unknown>;
}

export interface ProtectScope {
  grant_id: string;
  app_contract: string;
  anchor_key: string;
  policy: ScopePolicy;
  ledger: string[];
}

export interface ProtectStatus {
  protected_count: number;
  protected_keys: string[];
  app_grants: string[];
  protect_pct: number;
  scopes?: ProtectScope[];
}

function nodeHttpOrigin(): string {
  const fromImportMeta = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.VITE_FREENET_HTTP_URL?.trim();
  if (fromImportMeta) return fromImportMeta.replace(/\/$/, "");
  const loc = (
    globalThis as { location?: { protocol?: string; host?: string } }
  ).location;
  if (loc?.host) {
    const proto = loc.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${loc.host}`;
  }
  return "http://127.0.0.1:7509";
}

function appContractKey(): string {
  return FORGE_WEBSITE_CONTRACT_KEY;
}

let featuresCache: FeaturesResponse | null | undefined;
let featuresInflight: Promise<FeaturesResponse | null> | null = null;

/** Probe once; null = capability missing / node old / unreachable. */
export async function fetchNodeFeatures(
  force = false,
): Promise<FeaturesResponse | null> {
  if (!force && featuresCache !== undefined) return featuresCache;
  if (!force && featuresInflight) return featuresInflight;
  featuresInflight = (async () => {
    try {
      const res = await fetch(`${nodeHttpOrigin()}/v1/features`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        featuresCache = null;
        return null;
      }
      const json = (await res.json()) as FeaturesResponse;
      featuresCache = json;
      return json;
    } catch {
      featuresCache = null;
      return null;
    } finally {
      featuresInflight = null;
    }
  })();
  return featuresInflight;
}

export async function hasLocalProtectCapability(): Promise<boolean> {
  const f = await fetchNodeFeatures();
  return Boolean(
    f?.local_contract_protect ||
      f?.capabilities?.includes("local_contract_protect"),
  );
}

async function protectFetch(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Freenet-App-Contract", appContractKey());
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${nodeHttpOrigin()}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

export async function fetchProtectStatus(): Promise<ProtectStatus | null> {
  if (!(await hasLocalProtectCapability())) return null;
  const res = await protectFetch("/v1/local-protect/status");
  if (res.status === 401 || res.status === 403) {
    return null;
  }
  if (!res.ok) return null;
  return (await res.json()) as ProtectStatus;
}

export async function isAppGranted(): Promise<boolean> {
  const status = await fetchProtectStatus();
  if (!status) return false;
  return status.app_grants.includes(appContractKey());
}

/**
 * Ask the Freenet shell overlay to Allow this website to use Protect.
 * Blocks until Authorize / Cancel / timeout. Optional OAuth presentation.
 */
export async function requestAppGrantViaOverlay(
  presentation?: ProtectPresentation,
): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  if (await isAppGranted()) {
    return { ok: true };
  }
  const res = await protectFetch("/v1/local-protect/request-grant", {
    method: "POST",
    json: presentation ? { presentation } : {},
  });
  if (res.status === 403) {
    return {
      ok: false,
      code: "denied_or_timeout",
      error: "Permission denied or timed out",
      needsGrant: true,
    };
  }
  if (!res.ok) return readProtectError(res);
  const j = (await res.json().catch(() => null)) as {
    granted?: boolean;
  } | null;
  if (j?.granted) return { ok: true };
  return {
    ok: false,
    code: "denied_or_timeout",
    error: "Permission denied or timed out",
    needsGrant: true,
  };
}

/**
 * Layer B: Freenet shell Authorize for a scope, then create-scope (+ optional sync).
 */
export async function requestScopeViaOverlay(opts: {
  grantId: string;
  anchorKey: string;
  policy?: ScopePolicy;
  protectAnchor?: boolean;
  desiredKeys?: string[];
  presentation?: ProtectPresentation;
}): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  const res = await protectFetch("/v1/local-protect/request-scope", {
    method: "POST",
    json: {
      grant_id: opts.grantId,
      anchor_key: opts.anchorKey,
      policy: opts.policy ?? { kind: "single" },
      protect_anchor: opts.protectAnchor ?? true,
      desired_keys: opts.desiredKeys ?? [],
      presentation: opts.presentation,
    },
  });
  if (res.status === 403) {
    return {
      ok: false,
      code: "denied_or_timeout",
      error: "Permission denied or timed out",
      needsGrant: true,
    };
  }
  if (!res.ok) return readProtectError(res);
  const j = (await res.json().catch(() => null)) as {
    granted?: boolean;
    scope?: ProtectScope;
  } | null;
  if (j?.granted) {
    return { ok: true, scope: j.scope, grantId: opts.grantId };
  }
  return {
    ok: false,
    code: "denied_or_timeout",
    error: "Permission denied or timed out",
  };
}

export type ProtectOpResult =
  | { ok: true; scope?: ProtectScope; grantId?: string }
  | { ok: false; code: string; error: string; needsGrant?: boolean };

async function readProtectError(res: Response): Promise<ProtectOpResult> {
  let code = "http_error";
  let error = res.statusText || `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { code?: string; error?: string };
    if (j.code) code = j.code;
    if (j.error) error = j.error;
  } catch {
    /* keep defaults */
  }
  return {
    ok: false,
    code,
    error,
    needsGrant: code === "app_not_granted" || res.status === 401,
  };
}

export function identityGrantId(
  area: "profile" | "vault" | "website",
): string {
  return protectIdentityGrantId(area);
}

export function repoGrantId(prefix: string): string {
  return protectRepoGrantId(prefix);
}

export function findScope(
  status: ProtectStatus | null,
  grantId: string,
): ProtectScope | undefined {
  return status?.scopes?.find((s) => s.grant_id === grantId);
}

/** Layer A must be granted for any scope to count as live on this node. */
export function isAppGrantedFromStatus(status: ProtectStatus | null): boolean {
  return Boolean(status?.app_grants?.includes(appContractKey()));
}

/** Scope is active only under a live Layer A grant (post-cascade). */
export function isScopeActive(
  status: ProtectStatus | null,
  grantId: string,
): boolean {
  if (!isAppGrantedFromStatus(status)) return false;
  return Boolean(findScope(status, grantId));
}

export async function createScope(opts: {
  grantId: string;
  anchorKey: string;
  policy?: ScopePolicy;
  protectAnchor?: boolean;
}): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  const res = await protectFetch("/v1/local-protect/create-scope", {
    method: "POST",
    json: {
      grant_id: opts.grantId,
      anchor_key: opts.anchorKey,
      policy: opts.policy ?? { kind: "single" },
      protect_anchor: opts.protectAnchor ?? true,
    },
  });
  if (!res.ok) return readProtectError(res);
  const j = (await res.json()) as { scope?: ProtectScope };
  return { ok: true, scope: j.scope, grantId: opts.grantId };
}

export async function revokeScope(grantId: string): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  const res = await protectFetch("/v1/local-protect/revoke-scope", {
    method: "POST",
    json: { grant_id: grantId },
  });
  if (!res.ok) return readProtectError(res);
  try {
    const { forgetProtectScope } = await import("./protect-prefs");
    forgetProtectScope(grantId);
  } catch {
    /* ignore */
  }
  return { ok: true, grantId };
}

export async function syncScope(
  grantId: string,
  desiredKeys: string[],
): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  const res = await protectFetch("/v1/local-protect/sync-scope", {
    method: "POST",
    json: { grant_id: grantId, desired_keys: desiredKeys },
  });
  if (!res.ok) return readProtectError(res);
  return { ok: true, grantId };
}

/** @deprecated Apps must use createScope / syncScope — bare protect is admin-only. */
export async function protectContract(key: string): Promise<ProtectOpResult> {
  return createScope({
    grantId: protectLegacyGrantId(key),
    anchorKey: key,
    policy: { kind: "single" },
  });
}

/** @deprecated Prefer revokeScope. */
export async function unprotectContract(key: string): Promise<ProtectOpResult> {
  const status = await fetchProtectStatus();
  const match = status?.scopes?.find(
    (s) => s.anchor_key === key || s.ledger.includes(key),
  );
  if (match) return revokeScope(match.grant_id);
  return {
    ok: false,
    code: "scope_not_found",
    error: "No scope found for that key; use revoke-scope",
  };
}

export async function revokeAppGrant(): Promise<ProtectOpResult> {
  if (!(await hasLocalProtectCapability())) {
    return {
      ok: false,
      code: "unavailable",
      error: "This node does not advertise local_contract_protect",
    };
  }
  const res = await protectFetch("/v1/local-protect/revoke-app", {
    method: "POST",
    json: { app_contract: appContractKey() },
  });
  if (!res.ok) return readProtectError(res);
  return { ok: true };
}

export function grantAppCliHint(): string {
  return `freenet local-protect grant-app ${appContractKey()}`;
}

/** Optional live-repo context for tip-pack membership expansion. */
export interface TipPackMembershipContext {
  /** Commit hex targets from current `state.refs` (any tip still live). */
  refTargets?: Iterable<string>;
  /** Publisher `mirror-mode`: `snapshot` | `history` | absent. */
  mirrorMode?: string | null;
}

/**
 * Expand child contract keys from parent tipped-bundle summaries (GitForge recipe).
 * Parent field paths are declared in gitforgeTipPackMembership(); core never sees RepoState.
 *
 * Retention semantics (packs, not age):
 * - `current` — packs that still make up the live tip graph. Snapshot: only
 *   packs whose tip_commit is a current ref. History / unknown: all tipped
 *   packs (soft-fill still needs chronologically older packs that tip ancestors).
 * - `last_n` — always keep current-ref tip packs, plus additional tipped packs
 *   up to `lastN` total (unordered extras; prefer live tips first).
 * - `all` — every tipped pack on parent state.
 */
export function tipPackKeysFromBundles(
  bundles: Array<{
    pack_hash?: string | null;
    manifest_hash?: string | null;
    tip_commit?: string | null;
  }>,
  packKeyForHash: (hashHex: string) => string,
  retention: TipRetention = "current",
  lastN = 3,
  ctx: TipPackMembershipContext = {},
): string[] {
  const tipped = bundles.slice();
  const refSet = new Set(
    [...(ctx.refTargets ?? [])]
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean),
  );
  const isLiveTip = (b: { tip_commit?: string | null }) => {
    const tip = (b.tip_commit || "").trim().toLowerCase();
    return tip.length > 0 && refSet.has(tip);
  };

  let list = tipped;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // if (retention === "current") {
  //   list = list.slice(0, 1); // wrong: unordered tipped list ≠ newest; drops
  //   // soft-fill packs still required for the live tip closure
  // } else if (retention === "last_n") {
  //   list = list.slice(0, Math.max(1, lastN));
  // }
  // NEW CODE - TESTING: current = live tip closure; last_n keeps live tips first
  if (retention === "current") {
    const mode = (ctx.mirrorMode || "").trim().toLowerCase();
    if (mode === "snapshot" && refSet.size > 0) {
      const live = tipped.filter(isLiveTip);
      // Fall back if tip extensions lag refs (legacy / mid-push).
      list = live.length > 0 ? live : tipped;
    } else {
      // History (or unknown): every tipped pack may still be part of soft-fill
      // for the current tip — age does not mean unused.
      list = tipped;
    }
  } else if (retention === "last_n") {
    const n = Math.max(1, lastN);
    const live = refSet.size > 0 ? tipped.filter(isLiveTip) : [];
    const rest = tipped.filter((b) => !live.includes(b));
    list = [...live];
    for (const b of rest) {
      if (list.length >= Math.max(n, live.length)) break;
      list.push(b);
    }
  }

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const b of list) {
    const hash = (b.pack_hash || b.manifest_hash || "").trim();
    if (!hash) continue;
    const key = packKeyForHash(hash);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** Read tip retention from a live ProtectScope (or vault-remembered) member_hint. */
export function retentionFromScope(
  scope: ProtectScope | undefined | null,
): TipRetention | null {
  if (!scope?.policy?.member_hint) return null;
  const hint = scope.policy.member_hint as {
    retention?: { mode?: string };
    tip_retention?: string;
  };
  const mode = (hint.retention?.mode ?? hint.tip_retention ?? "").trim();
  if (mode === "current" || mode === "last_n" || mode === "all") return mode;
  return null;
}

/** GitForge instance of MembershipSpec — freenet-git parent state field paths. */
export function gitforgeTipPackMembership(
  retention: TipRetention = "current",
  lastN = 3,
): MembershipSpec {
  return {
    recipe_id: "freenet-git.tip-packs",
    summary:
      "Pin this repository contract and tip-pack contracts that make up the live tip graph on parent state (current ≠ chronologically newest)",
    from_anchor: {
      state_label: "freenet-git parent state",
      child_id_fields: [
        "object_index.*.pack_hash",
        "object_index.*.manifest_hash",
        "extensions.bundle-tip:*",
      ],
      keying: "pack_contract_from_blake3_hash",
    },
    retention: { mode: retention, last_n: lastN },
  };
}

/**
 * Create/update a repo scope via Freenet shell Authorize, then sync tip keys.
 */
export async function ensureRepoScopeAndSync(opts: {
  prefix: string;
  repoContractKey: string;
  tipPackKeys: string[];
  tipRetention?: TipRetention;
  lastN?: number;
  presentation?: ProtectPresentation;
}): Promise<ProtectOpResult> {
  const grantId = repoGrantId(opts.prefix);
  const retention = opts.tipRetention ?? "current";
  const lastN = opts.lastN ?? 3;
  const policy: ScopePolicy = {
    kind: "anchor_plus_members",
    member_hint: gitforgeTipPackMembership(retention, lastN),
  };
  const viaShell = await requestScopeViaOverlay({
    grantId,
    anchorKey: opts.repoContractKey,
    policy,
    protectAnchor: true,
    desiredKeys: opts.tipPackKeys,
    presentation: opts.presentation,
  });
  if (!viaShell.ok) return viaShell;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // // Already synced in request-scope when desired_keys provided; sync again if empty.
  // if (opts.tipPackKeys.length === 0) {
  //   return syncScope(grantId, opts.tipPackKeys);
  // }
  // return viaShell;
  // NEW CODE - TESTING: request-scope short-circuits when the scope already exists
  // and skips policy + desired_keys — so retention looked applied then reset on reload.
  const updated = await createScope({
    grantId,
    anchorKey: opts.repoContractKey,
    policy,
    protectAnchor: true,
  });
  if (!updated.ok) return updated;
  try {
    const { rememberProtectScope, setProtectAppGrantedIntent } = await import(
      "./protect-prefs"
    );
    setProtectAppGrantedIntent(true);
    rememberProtectScope({
      grant_id: grantId,
      anchor_key: opts.repoContractKey,
      policy,
      label: opts.prefix,
    });
  } catch {
    /* ignore vault/prefs */
  }
  return syncScope(grantId, opts.tipPackKeys);
}
