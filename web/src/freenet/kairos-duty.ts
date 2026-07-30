/**
 * Kairos network duty for GitForge (public goods).
 *
 * Soft-Get / Subscribe the time oracle, pulse, and observe open stamps when
 * age-eligible. Never Puts the Kairos WASM (Kairos site / publishers do that).
 * Failures are logged — callers must not let this block SPA load.
 */
import { blake3 } from "@noble/hashes/blake3";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { ContractKey } from "@freenetorg/freenet-stdlib";
import { wrapDeltaUpdate } from "./put";
import {
  getContractState,
  tryGetContractState,
  updateContract,
  onContractUpdateNotification,
} from "./ws";
import { bytesToHex } from "./keys";
import {
  KAIROS_PARAMS_UTF8,
  KAIROS_WASM_HASH_B58,
  KAIROS_MIN_AGE_MS,
  KAIROS_MIN_STAMP_WITNESSES,
  KAIROS_MAX_OBSERVE_PER_DUTY,
  KAIROS_EXAMPLE_STAMP_CONTENT_HASH,
  KAIROS_EXAMPLE_STAMP_NONCE,
  KAIROS_EXAMPLE_STAMP_ID,
} from "./kairos-constants";

const EMPTY_STATE = JSON.stringify({
  schema_version: 2,
  roster: {},
  pulse: {},
  open_stamps: {},
  sealed_stamps: {},
});

/** Same key as Kairos site so soft-nav / shared origin accrues one witness. */
const WITNESS_SK_KEY = "kairos.witness.sk.v2";

export type KairosObservation = {
  node_id: string;
  wall_ms: number;
  monotonic_ms: number;
  uncertainty_ms: number;
  sig: string;
};

export type KairosState = {
  schema_version?: number;
  roster: Record<
    string,
    {
      first_seen_ms: number;
      last_seen_ms: number;
      pulse_count?: number;
      seals_included?: number;
      seals_outlier?: number;
    }
  >;
  pulse: Record<string, KairosObservation>;
  open_stamps: Record<
    string,
    {
      content_hash?: string;
      nonce?: string;
      observations?: Record<string, KairosObservation>;
    }
  >;
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
  identity: { nodeId: string; label: string } | null;
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
  const parameters = paramsBytes();
  const concat = new Uint8Array(codeBytes.length + parameters.length);
  concat.set(codeBytes, 0);
  concat.set(parameters, codeBytes.length);
  const instance = blake3(concat);
  return new ContractKey(
    instance as unknown as ConstructorParameters<typeof ContractKey>[0],
    codeBytes,
  );
}

export function parseKairosState(bytes: Uint8Array | null): KairosState {
  if (!bytes?.length) {
    return JSON.parse(EMPTY_STATE) as KairosState;
  }
  const s = JSON.parse(new TextDecoder().decode(bytes)) as KairosState;
  s.roster = s.roster || {};
  s.pulse = s.pulse || {};
  s.open_stamps = s.open_stamps || {};
  s.sealed_stamps = s.sealed_stamps || {};
  return s;
}

function b64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

function bytesToB64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

let memSk: Uint8Array | null = null;

function loadOrCreateSecret(): Uint8Array {
  if (memSk?.length === 32) return memSk;
  let sk: Uint8Array | null = null;
  try {
    sk = b64ToBytes(localStorage.getItem(WITNESS_SK_KEY) || "");
  } catch {
    sk = null;
  }
  if (!sk) {
    sk = ed25519.utils.randomPrivateKey();
  }
  memSk = sk;
  try {
    localStorage.setItem(WITNESS_SK_KEY, bytesToB64(sk));
  } catch {
    /* sandbox may block storage — mem still works for the session */
  }
  return sk;
}

function pushField(out: number[], field: Uint8Array | string): void {
  const bytes =
    typeof field === "string" ? new TextEncoder().encode(field) : field;
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  out.push(0);
}

function getWitness(): { secretKey: Uint8Array; nodeId: string; label: string } {
  const secretKey = loadOrCreateSecret();
  const publicKey = ed25519.getPublicKey(secretKey);
  const nodeId = bs58.encode(publicKey);
  const short = nodeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();
  return {
    secretKey,
    nodeId,
    label: `kairos-${short || "node"}`,
  };
}

function signObservation(
  domainStr: string,
  extraFields: string[],
  fields: [number, number, number],
): KairosObservation {
  const w = getWitness();
  const parts: number[] = [];
  const domain = new TextEncoder().encode(domainStr);
  for (let i = 0; i < domain.length; i++) parts.push(domain[i]);
  for (const e of extraFields) pushField(parts, e);
  pushField(parts, w.nodeId);
  pushField(parts, String(fields[0]));
  pushField(parts, String(fields[1]));
  pushField(parts, String(fields[2]));
  const payload = new Uint8Array(parts);
  const sig = ed25519.sign(payload, w.secretKey);
  return {
    node_id: w.nodeId,
    wall_ms: fields[0],
    monotonic_ms: fields[1],
    uncertainty_ms: fields[2],
    sig: bytesToHex(sig),
  };
}

function signPulse(): KairosObservation {
  const now = Date.now();
  const perf =
    typeof performance !== "undefined" ? Math.floor(performance.now()) : 0;
  return signObservation("kairos.pulse.v1\0", [], [now, perf, 40]);
}

function signStampObserve(requestId: string): KairosObservation {
  const now = Date.now();
  const perf =
    typeof performance !== "undefined" ? Math.floor(performance.now()) : 0;
  return signObservation("kairos.stamp.observe.v1\0", [requestId], [
    now,
    perf,
    40,
  ]);
}

/**
 * Soft presence: tryGet first. If missing, do not Put WASM from GitForge.
 * If found, Subscribe so this node helps host.
 */
export async function softEnsureKairos(): Promise<{
  key: ContractKey;
  state: KairosState | null;
  present: boolean;
}> {
  const key = kairosContractKey();
  const soft = await tryGetContractState(key, { timeoutMs: 5_000 });
  if (!soft) {
    return { key, state: null, present: false };
  }
  // Subscribe / hold — low priority so tip browse stays snappy.
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

export function planNetworkDuty(
  state: KairosState,
  nodeId: string | null,
): KairosDutyPlan {
  const me = nodeId ? state.roster?.[nodeId] : null;
  const ageMs = me ? me.last_seen_ms - me.first_seen_ms : 0;
  const stamp_eligible = Boolean(me && ageMs >= KAIROS_MIN_AGE_MS);
  const open = Object.entries(state.open_stamps || {});
  const observe_ids = stamp_eligible
    ? open
        .filter(([, req]) => !req.observations?.[nodeId!])
        .map(([id]) => id)
        .slice(0, KAIROS_MAX_OBSERVE_PER_DUTY)
    : [];

  const actions: KairosDutyPlan["actions"] = [
    {
      type: "pulse",
      reason: me
        ? "keep-alive + accrue roster age"
        : "join roster + keep-alive",
    },
  ];
  for (const request_id of observe_ids) {
    actions.push({
      type: "observe_stamp",
      request_id,
      reason: "age-eligible — help seal open request",
    });
  }

  let summary: string;
  if (!me) summary = "pulse · join roster";
  else if (!stamp_eligible)
    summary = `pulse · aging ${ageMs} / ${KAIROS_MIN_AGE_MS} ms`;
  else if (observe_ids.length)
    summary = `pulse + observe ${observe_ids.length} open`;
  else if (open.length) summary = "pulse · eligible · already observed open";
  else summary = "pulse · eligible · no open requests";

  return {
    schema: "kairos.network.duty.v1",
    node_id: nodeId,
    roster_age_ms: ageMs,
    stamp_eligible,
    open_count: open.length,
    sealed_count: Object.keys(state.sealed_stamps || {}).length,
    actions,
    summary,
  };
}

async function ensureExampleStamp(
  key: ContractKey,
  state: KairosState,
): Promise<{ opened: boolean; request_id: string; error?: string }> {
  if (
    state.sealed_stamps?.[KAIROS_EXAMPLE_STAMP_ID] ||
    state.open_stamps?.[KAIROS_EXAMPLE_STAMP_ID]
  ) {
    return { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID };
  }
  try {
    const delta = new TextEncoder().encode(
      JSON.stringify({
        open_stamp: {
          content_hash: KAIROS_EXAMPLE_STAMP_CONTENT_HASH,
          nonce: KAIROS_EXAMPLE_STAMP_NONCE,
        },
      }),
    );
    await updateContract(wrapDeltaUpdate(key, delta), key);
    return { opened: true, request_id: KAIROS_EXAMPLE_STAMP_ID };
  } catch (err) {
    return {
      opened: false,
      request_id: KAIROS_EXAMPLE_STAMP_ID,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * One network-duty cycle (help the oracle). Safe to fire-and-forget.
 */
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
  if (!present || !initial) {
    return { ...empty, skipped: "kairos contract not reachable on this node yet" };
  }

  let state = initial;
  const w = getWitness();
  const identity = { nodeId: w.nodeId, label: w.label };

  const example = await ensureExampleStamp(key, state);
  if (example.opened) {
    try {
      const bytes = await getContractState(key, {
        fetchContract: true,
        subscribe: true,
        priority: "low",
        timeoutMs: 12_000,
      });
      state = parseKairosState(bytes);
    } catch {
      /* keep prior state */
    }
  }

  const plan = planNetworkDuty(state, w.nodeId);
  const result: KairosDutyResult = {
    identity,
    plan,
    pulsed: false,
    observed: [],
    example,
    errors: [],
    state,
  };

  for (const action of plan.actions) {
    try {
      if (action.type === "pulse") {
        const observation = signPulse();
        const delta = new TextEncoder().encode(
          JSON.stringify({ pulse: observation }),
        );
        await updateContract(wrapDeltaUpdate(key, delta), key);
        result.pulsed = true;
      } else if (action.type === "observe_stamp" && action.request_id) {
        const observation = signStampObserve(action.request_id);
        const delta = new TextEncoder().encode(
          JSON.stringify({
            observe_stamp: {
              request_id: action.request_id,
              observation,
            },
          }),
        );
        await updateContract(wrapDeltaUpdate(key, delta), key);
        result.observed.push(action.request_id);
      }
    } catch (err) {
      result.errors.push({
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.pulsed || result.observed.length || example.opened) {
    try {
      const bytes = await getContractState(key, {
        fetchContract: true,
        subscribe: true,
        priority: "low",
        timeoutMs: 12_000,
      });
      result.state = parseKairosState(bytes);
    } catch {
      /* */
    }
  }

  return result;
}

export type WatchKairosDutyHandlers = {
  onDuty?: (result: KairosDutyResult, reason: string) => void;
  onError?: (err: unknown) => void;
  /** Full write duty interval (default 45s — gentler than Kairos lab). */
  intervalMs?: number;
};

/**
 * Background watch: delayed initial duty, interval writes, Subscribe refresh
 * is read-only (no pulse storm). Returns stop().
 */
export function watchKairosNetworkDuty(
  handlers: WatchKairosDutyHandlers = {},
): () => void {
  const {
    onDuty,
    onError,
    intervalMs = 45_000,
  } = handlers;
  let stopped = false;
  let busy = false;
  let queued: string | null = null;
  let unsub = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const key = kairosContractKey();

  async function tick(reason: string): Promise<void> {
    if (stopped) return;
    if (busy) {
      queued = reason;
      return;
    }
    busy = true;
    try {
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // run duty on every UpdateNotification → pulse feedback loops
      // NEW CODE - TESTING: updates = soft ensure only; interval = write duty
      let result: KairosDutyResult;
      if (reason === "update" || reason === "queued-update") {
        const soft = await softEnsureKairos();
        const w = soft.present ? getWitness() : null;
        result = {
          identity: w ? { nodeId: w.nodeId, label: w.label } : null,
          plan: soft.state && w ? planNetworkDuty(soft.state, w.nodeId) : null,
          pulsed: false,
          observed: [],
          example: { opened: false, request_id: KAIROS_EXAMPLE_STAMP_ID },
          errors: soft.present ? [] : [{ error: "kairos not present" }],
          state: soft.state,
          skipped: soft.present ? undefined : "not present",
        };
      } else {
        result = await runKairosNetworkDuty();
      }
      if (!stopped) onDuty?.(result, reason);
    } catch (err) {
      if (!stopped) onError?.(err);
    } finally {
      busy = false;
      if (queued && !stopped) {
        const next = queued;
        queued = null;
        void tick(next === "update" ? "queued-update" : next);
      }
    }
  }

  void (async () => {
    try {
      await softEnsureKairos();
      if (stopped) return;
      unsub = onContractUpdateNotification((updated) => {
        try {
          if (updated.encode() === key.encode()) void tick("update");
        } catch {
          void tick("update");
        }
      });
      await tick("initial");
      timer = setInterval(() => void tick("interval"), intervalMs);
    } catch (err) {
      if (!stopped) onError?.(err);
    }
  })();

  return () => {
    stopped = true;
    unsub();
    if (timer) clearInterval(timer);
  };
}

export { KAIROS_MIN_STAMP_WITNESSES, KAIROS_EXAMPLE_STAMP_ID };
