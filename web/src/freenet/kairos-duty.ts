/**
 * GitForge's bounded Kairos public-good duty.
 *
 * Kairos owns the identity and private key. GitForge only calls the pinned
 * Kairos identity delegate; it never derives, stores, imports, or creates a
 * Kairos key. If the service identity is not already initialized, duty skips.
 */
import { blake3 } from "@noble/hashes/blake3";
import bs58 from "bs58";
import { ContractKey } from "@freenetorg/freenet-stdlib";
import { wrapDeltaUpdate } from "./put";
import {
  getContractState,
  tryGetContractState,
  updateContract,
  onContractUpdateNotification,
} from "./ws";
import { getPublicGoodIdentity, signPublicGood } from "./public-goods";
import { getCachedIdentity } from "./auth-api";
import { getPublicGoodsAuthorizations } from "./public-goods-consent";
import {
  KAIROS_PARAMS_UTF8,
  KAIROS_WASM_HASH_B58,
  KAIROS_MIN_AGE_MS,
  KAIROS_MAX_OBSERVE_PER_DUTY,
  KAIROS_EXAMPLE_STAMP_ID,
} from "./kairos-constants";

const EMPTY_STATE = JSON.stringify({
  schema_version: 2,
  roster: {},
  pulse: {},
  open_stamps: {},
  sealed_stamps: {},
});

type Identity = { nodeId: string; label: string; source: "service-delegate" };

export type KairosObservation = {
  node_id: string;
  wall_ms: number;
  monotonic_ms: number;
  uncertainty_ms: number;
  sig: string;
};

export type KairosState = {
  schema_version?: number;
  roster: Record<string, { first_seen_ms: number; last_seen_ms: number }>;
  pulse: Record<string, KairosObservation>;
  open_stamps: Record<string, { observations?: Record<string, KairosObservation> }>;
  sealed_stamps: Record<string, unknown>;
};

export type KairosDutyPlan = {
  schema: "kairos.network.duty.v1";
  node_id: string | null;
  roster_age_ms: number;
  stamp_eligible: boolean;
  open_count: number;
  sealed_count: number;
  actions: { type: string; request_id?: string; reason: string }[];
  summary: string;
};

export type KairosDutyResult = {
  identity: Identity | null;
  plan: KairosDutyPlan | null;
  pulsed: boolean;
  observed: string[];
  example: { opened: boolean; request_id: string; error?: string };
  errors: { action?: unknown; error: string }[];
  state: KairosState | null;
  skipped?: string;
};

function paramsBytes(): Uint8Array {
  return new TextEncoder().encode(KAIROS_PARAMS_UTF8);
}

export function kairosContractKey(): ContractKey {
  const codeBytes = bs58.decode(KAIROS_WASM_HASH_B58);
  const input = new Uint8Array(codeBytes.length + paramsBytes().length);
  input.set(codeBytes);
  input.set(paramsBytes(), codeBytes.length);
  return new ContractKey(
    blake3(input) as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

export function parseKairosState(bytes: Uint8Array | null): KairosState {
  if (!bytes?.length) return JSON.parse(EMPTY_STATE) as KairosState;
  const state = JSON.parse(new TextDecoder().decode(bytes)) as KairosState;
  state.roster ||= {};
  state.pulse ||= {};
  state.open_stamps ||= {};
  state.sealed_stamps ||= {};
  return state;
}

async function getWitness(): Promise<Identity> {
  const identity = await getPublicGoodIdentity("kairos");
  if (!identity) throw new Error("Kairos identity is not initialized on this node");
  const forgeIdentity = getCachedIdentity();
  const authorization = getPublicGoodsAuthorizations().kairos;
  if (
    !forgeIdentity ||
    !authorization?.background_enabled ||
    authorization.gitforge_identity_fingerprint !== forgeIdentity.fingerprint ||
    authorization.service_node_id !== identity.nodeId ||
    authorization.service_label !== identity.label
  ) {
    throw new Error("Kairos public-good authorization does not match this service identity");
  }
  return { nodeId: identity.nodeId, label: identity.label, source: "service-delegate" };
}

async function signObservation(
  identity: Identity,
  type: "SignPulse" | "SignStampObserve",
  requestId?: string,
): Promise<KairosObservation> {
  const now = Date.now();
  const fields: Record<string, unknown> = {
    type,
    wall_ms: now,
    monotonic_ms: typeof performance === "undefined" ? 0 : Math.floor(performance.now()),
    uncertainty_ms: 40,
  };
  if (requestId) fields.request_id = requestId;
  const response = await signPublicGood("kairos", fields);
  if (response?.type !== "SignedObservation" || response.node_id !== identity.nodeId) {
    throw new Error("Kairos service delegate returned an unexpected signer response");
  }
  return {
    node_id: String(response.node_id),
    wall_ms: Number(response.wall_ms),
    monotonic_ms: Number(response.monotonic_ms),
    uncertainty_ms: Number(response.uncertainty_ms),
    sig: String(response.sig),
  };
}

export async function softEnsureKairos(): Promise<{
  key: ContractKey;
  state: KairosState | null;
  present: boolean;
}> {
  const key = kairosContractKey();
  const soft = await tryGetContractState(key, { timeoutMs: 5_000 });
  if (!soft) return { key, state: null, present: false };
  try {
    const bytes = await getContractState(key, {
      fetchContract: true,
      subscribe: true,
      priority: "low",
      timeoutMs: 12_000,
    });
    return { key, state: parseKairosState(bytes), present: true };
  } catch {
    return { key, state: parseKairosState(soft), present: true };
  }
}

export function planNetworkDuty(state: KairosState, nodeId: string | null): KairosDutyPlan {
  const entry = nodeId ? state.roster[nodeId] : null;
  // Eligibility is elapsed time since first sighting, not the span between
  // pulse records. A witness must not lose age merely because its latest pulse
  // has not arrived yet.
  const age = entry ? Math.max(0, Date.now() - entry.first_seen_ms) : 0;
  const eligible = Boolean(entry && age >= KAIROS_MIN_AGE_MS);
  const open = Object.entries(state.open_stamps || {});
  const observations = eligible
    ? open
        .filter(([, request]) => !request.observations?.[nodeId!])
        .map(([requestId]) => requestId)
        .slice(0, KAIROS_MAX_OBSERVE_PER_DUTY)
    : [];
  const actions = [{
    type: "pulse",
    reason: entry ? "keep-alive + accrue roster age" : "join roster + keep-alive",
  }];
  actions.push(...observations.map((request_id) => ({
    type: "observe_stamp",
    request_id,
    reason: "age-eligible — help seal open request",
  })));
  const summary = !entry
    ? "pulse · join roster"
    : !eligible
      ? `pulse · aging ${age} / ${KAIROS_MIN_AGE_MS} ms`
      : observations.length
        ? `pulse + observe ${observations.length} open`
        : open.length
          ? "pulse · eligible · already observed open"
          : "pulse · eligible · no open requests";
  return {
    schema: "kairos.network.duty.v1",
    node_id: nodeId,
    roster_age_ms: age,
    stamp_eligible: eligible,
    open_count: open.length,
    sealed_count: Object.keys(state.sealed_stamps || {}).length,
    actions,
    summary,
  };
}

export async function runKairosNetworkDuty(): Promise<KairosDutyResult> {
  const empty: KairosDutyResult = {
    identity: null,
    plan: null,
    pulsed: false,
    observed: [],
    example: { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID },
    errors: [],
    state: null,
  };
  const { key, state: initial, present } = await softEnsureKairos();
  if (!present || !initial) return { ...empty, skipped: "kairos contract not reachable on this node yet" };
  const identity = await getWitness();
  const state = initial;
  const plan = planNetworkDuty(state, identity.nodeId);
  // GitForge contributes to existing Kairos work only. It never opens a stamp.
  const example = { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID };
  const result: KairosDutyResult = { identity, plan, pulsed: false, observed: [], example, errors: [], state };
  for (const action of plan.actions) {
    try {
      if (action.type === "pulse") {
        await updateContract(wrapDeltaUpdate(key, new TextEncoder().encode(JSON.stringify({ pulse: await signObservation(identity, "SignPulse") }))), key);
        result.pulsed = true;
      } else if (action.type === "observe_stamp" && action.request_id) {
        await updateContract(wrapDeltaUpdate(key, new TextEncoder().encode(JSON.stringify({ observe_stamp: { request_id: action.request_id, observation: await signObservation(identity, "SignStampObserve", action.request_id) } }))), key);
        result.observed.push(action.request_id);
      }
    } catch (error) {
      result.errors.push({ action, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (result.pulsed || result.observed.length) {
    try { result.state = parseKairosState(await getContractState(key, { fetchContract: true, subscribe: true, priority: "low", timeoutMs: 12_000 })); } catch { /* retain state */ }
  }
  return result;
}

export type WatchKairosDutyHandlers = {
  onDuty?: (result: KairosDutyResult, reason: string) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
};

export function watchKairosNetworkDuty(handlers: WatchKairosDutyHandlers = {}): () => void {
  const { onDuty, onError, intervalMs = 45_000 } = handlers;
  let stopped = false;
  let busy = false;
  let queued = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe = () => {};
  const key = kairosContractKey();

  const tick = async (reason: string) => {
    if (stopped) return;
    if (busy) { queued = true; return; }
    busy = true;
    try {
      const result = reason === "update" || reason === "queued-update"
        ? await softRefresh()
        : await runKairosNetworkDuty();
      if (!stopped) onDuty?.(result, reason);
    } catch (error) {
      if (!stopped) onError?.(error);
    } finally {
      busy = false;
      if (queued && !stopped) { queued = false; void tick("queued-update"); }
    }
  };

  const softRefresh = async (): Promise<KairosDutyResult> => {
    const soft = await softEnsureKairos();
    if (!soft.present || !soft.state) return { identity: null, plan: null, pulsed: false, observed: [], example: { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID }, errors: [], state: null, skipped: "kairos contract not present" };
    let identity: Identity | null = null;
    try { identity = await getWitness(); } catch { /* absent service identity */ }
    return { identity, plan: identity ? planNetworkDuty(soft.state, identity.nodeId) : null, pulsed: false, observed: [], example: { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID }, errors: [], state: soft.state, skipped: identity ? undefined : "kairos identity is not initialized" };
  };

  void (async () => {
    try {
      await softEnsureKairos();
      if (stopped) return;
      unsubscribe = onContractUpdateNotification((updated) => {
        try { if (updated.encode() === key.encode()) void tick("update"); } catch { void tick("update"); }
      });
      await tick("initial");
      if (!stopped) timer = setInterval(() => void tick("interval"), intervalMs);
    } catch (error) { if (!stopped) onError?.(error); }
  })();

  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearInterval(timer);
  };
}

export { KAIROS_EXAMPLE_STAMP_ID };
