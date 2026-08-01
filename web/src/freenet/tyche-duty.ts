/**
 * GitForge's bounded Tyche public-good duty.
 *
 * Tyche owns the identity and private key. GitForge may contribute to existing
 * rounds when that identity is already initialized, but never creates or
 * derives a Tyche key, opens/closes rounds, or starts recovery.
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
  TYCHE_PARAMS_UTF8,
  TYCHE_WASM_HASH_B58,
  TYCHE_MIN_AGE_MS,
  TYCHE_MAX_COMMITS_PER_DUTY,
  TYCHE_MAX_REVEALS_PER_DUTY,
} from "./tyche-constants";

const EMPTY_STATE = JSON.stringify({
  schema_version: 3,
  roster: {},
  pulse: {},
  excluded_nodes: [],
  rounds: {},
});
// Match Tyche's browser duty namespace so a service-site session can continue
// a round after GitForge committed it on the same permitted origin.
const SECRET_PREFIX = `tyche.auto.secret.v1.${TYCHE_PARAMS_UTF8}.`;
const COMMIT_DOMAIN = "tyche.commitment.v1\0";
const MAX_ROUND_AGE_MS = 7 * 24 * 3_600_000;

type Identity = {
  nodeId: string;
  label: string;
  source: "service-delegate";
};

type Round = {
  round_id: number;
  opened_at_ms?: number;
  closed?: boolean;
  finalized?: boolean;
  commits?: Record<string, unknown>;
  reveals?: Record<string, unknown>;
  recovered?: Record<string, unknown>;
  reveal_order?: string[];
};

export type TycheState = {
  schema_version?: number;
  roster: Record<string, { first_seen_ms: number; last_seen_ms: number }>;
  pulse: Record<string, unknown>;
  excluded_nodes: string[];
  rounds: Record<string, Round>;
};

type DutyAction = { type: "pulse" | "commit" | "reveal"; round_id?: number; reason: string };

type DutyPlan = {
  schema: "tyche.network.duty.v1";
  node_id: string | null;
  randomness_eligible: boolean;
  open_count: number;
  actions: DutyAction[];
  summary: string;
};

export type TycheDutyResult = {
  identity: Identity | null;
  plan: DutyPlan | null;
  pulsed: boolean;
  committed: number[];
  revealed: number[];
  errors: { action?: unknown; error: string }[];
  state: TycheState | null;
  skipped?: string;
};

function paramsBytes(): Uint8Array {
  return new TextEncoder().encode(TYCHE_PARAMS_UTF8);
}

export function tycheContractKey(): ContractKey {
  const code = bs58.decode(TYCHE_WASM_HASH_B58);
  const input = new Uint8Array(code.length + paramsBytes().length);
  input.set(code);
  input.set(paramsBytes(), code.length);
  return new ContractKey(
    blake3(input) as unknown as ConstructorParameters<typeof ContractKey>[0],
    code,
  );
}

function parseState(bytes: Uint8Array | null): TycheState {
  if (!bytes?.length) return JSON.parse(EMPTY_STATE) as TycheState;
  const state = JSON.parse(new TextDecoder().decode(bytes)) as TycheState;
  if (state.schema_version !== 3) throw new Error("Tyche schema mismatch");
  state.roster ||= {};
  state.pulse ||= {};
  state.excluded_nodes ||= [];
  state.rounds ||= {};
  return state;
}

function secretKey(roundId: number, nodeId: string): string {
  return `${SECRET_PREFIX}${nodeId}.${roundId}`;
}

function readSecret(roundId: number, nodeId: string): string | null {
  try {
    const value = localStorage.getItem(secretKey(roundId, nodeId));
    return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function saveSecret(roundId: number, nodeId: string, secret: string): boolean {
  try {
    localStorage.setItem(secretKey(roundId, nodeId), secret);
    return localStorage.getItem(secretKey(roundId, nodeId)) === secret;
  } catch {
    return false;
  }
}

function forgetSecret(roundId: number, nodeId: string): void {
  try {
    localStorage.removeItem(secretKey(roundId, nodeId));
  } catch {
    /* Storage may be unavailable in a sandbox. */
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) || [], (part) => parseInt(part, 16));
}

function commitment(roundId: number, nodeId: string, secret: string): string {
  const fields = new TextEncoder().encode(`${roundId}\0${nodeId}\0`);
  const domain = new TextEncoder().encode(COMMIT_DOMAIN);
  const bytes = new Uint8Array(domain.length + fields.length + 32);
  bytes.set(domain);
  bytes.set(fields, domain.length);
  bytes.set(hexBytes(secret), domain.length + fields.length);
  return [...blake3(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withCommitLock<T>(roundId: number, work: () => Promise<T>): Promise<T> {
  const lockName = `tyche.auto.lock.v1.${TYCHE_PARAMS_UTF8}.${roundId}`;
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    throw new Error("automatic commit skipped: browser lacks Web Locks");
  }
  return navigator.locks.request(lockName, { mode: "exclusive" }, work);
}

async function getWitness(): Promise<Identity> {
  const identity = await getPublicGoodIdentity("tyche");
  if (!identity) throw new Error("Tyche identity is not initialized on this node");
  const forgeIdentity = getCachedIdentity();
  const authorization = getPublicGoodsAuthorizations().tyche;
  if (
    !forgeIdentity ||
    !authorization?.background_enabled ||
    authorization.gitforge_identity_fingerprint !== forgeIdentity.fingerprint ||
    authorization.service_node_id !== identity.nodeId ||
    authorization.service_label !== identity.label
  ) {
    throw new Error("Tyche public-good authorization does not match this service identity");
  }
  return { nodeId: identity.nodeId, label: identity.label, source: "service-delegate" };
}

async function signTyche(
  identity: Identity,
  type: "SignPulse" | "SignCommit" | "SignReveal",
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await signPublicGood("tyche", { type, ...fields });
  if (!response?.node_id || response.node_id !== identity.nodeId) {
    throw new Error("Tyche service delegate returned an unexpected identity");
  }
  if (response.type !== "Signed") {
    throw new Error("Tyche service delegate returned an unexpected signer response");
  }
  return response;
}

export async function softEnsureTyche(): Promise<{
  key: ContractKey;
  state: TycheState | null;
  present: boolean;
}> {
  const key = tycheContractKey();
  const soft = await tryGetContractState(key, { timeoutMs: 5_000 });
  if (!soft) return { key, state: null, present: false };
  try {
    return {
      key,
      state: parseState(await getContractState(key, {
        fetchContract: true,
        subscribe: true,
        priority: "low",
        timeoutMs: 12_000,
      })),
      present: true,
    };
  } catch {
    return { key, state: parseState(soft), present: true };
  }
}

export function planTycheDuty(
  state: TycheState,
  identity: Identity | null,
  nowMs = Date.now(),
): DutyPlan {
  const nodeId = identity?.nodeId || null;
  const entry = nodeId ? state.roster[nodeId] : null;
  // Match the contract's age rule: elapsed time since first sighting.
  const age = entry ? Math.max(0, nowMs - entry.first_seen_ms) : 0;
  const eligible = Boolean(
    entry && age >= TYCHE_MIN_AGE_MS && !state.excluded_nodes.includes(nodeId!),
  );
  const rounds = Object.values(state.rounds).sort((a, b) => a.round_id - b.round_id);
  const actions: DutyAction[] = [{
    type: "pulse",
    reason: entry ? "keep-alive + accrue roster age" : "join roster + keep-alive",
  }];

  if (eligible && nodeId) {
    for (const round of rounds) {
      if (actions.filter((action) => action.type === "commit").length >= TYCHE_MAX_COMMITS_PER_DUTY) break;
      const ageOk = !round.opened_at_ms || nowMs - round.opened_at_ms <= MAX_ROUND_AGE_MS;
      if (!round.closed && !round.finalized && ageOk && !round.commits?.[nodeId]) {
        actions.push({ type: "commit", round_id: round.round_id, reason: "age-eligible — contribute to existing open round" });
      }
    }
    for (const round of rounds) {
      if (
        actions.filter((action) => action.type === "reveal").length >= TYCHE_MAX_REVEALS_PER_DUTY ||
        !round.closed || round.finalized || !round.commits?.[nodeId] ||
        round.reveals?.[nodeId] || round.recovered?.[nodeId]
      ) continue;
      const next = (round.reveal_order || []).find(
        (id) => !round.reveals?.[id] && !round.recovered?.[id],
      );
      if (next === nodeId && readSecret(round.round_id, nodeId)) {
        actions.push({ type: "reveal", round_id: round.round_id, reason: "next in randomized reveal order" });
      }
    }
  }

  const commits = actions.filter((action) => action.type === "commit").length;
  const reveals = actions.filter((action) => action.type === "reveal").length;
  return {
    schema: "tyche.network.duty.v1",
    node_id: nodeId,
    randomness_eligible: eligible,
    open_count: rounds.filter((round) => !round.closed && !round.finalized).length,
    actions,
    summary: !entry
      ? "pulse · join roster"
      : !eligible
        ? `pulse · aging ${age} / ${TYCHE_MIN_AGE_MS} ms`
        : commits || reveals
          ? `pulse + commit ${commits} · reveal ${reveals}`
          : "pulse · eligible · no open-round work",
  };
}

export async function runTycheDuty(opts: { pulse?: boolean } = {}): Promise<TycheDutyResult> {
  const empty: TycheDutyResult = {
    identity: null,
    plan: null,
    pulsed: false,
    committed: [],
    revealed: [],
    errors: [],
    state: null,
  };
  const { key, state: initial, present } = await softEnsureTyche();
  if (!present || !initial) return { ...empty, skipped: "tyche contract not reachable on this node yet" };
  let identity: Identity;
  try {
    identity = await getWitness();
  } catch {
    return { ...empty, state: initial, skipped: "tyche identity is not initialized" };
  }

  let state = initial;
  const plan = planTycheDuty(state, identity);
  const result: TycheDutyResult = { ...empty, identity, state, plan };
  for (const action of plan.actions) {
    try {
      if (action.type === "pulse" && opts.pulse !== false) {
        const now = Date.now();
        const response = await signTyche(identity, "SignPulse", {
          wall_ms: now,
          monotonic_ms: typeof performance === "undefined" ? 0 : Math.floor(performance.now()),
          uncertainty_ms: 40,
        });
        await updateContract(
          wrapDeltaUpdate(key, new TextEncoder().encode(JSON.stringify({
            pulse: {
              node_id: response.node_id,
              wall_ms: response.wall_ms,
              monotonic_ms: response.monotonic_ms,
              uncertainty_ms: response.uncertainty_ms,
              sig: response.sig,
            },
          }))),
          key,
        );
        result.pulsed = true;
      } else if (action.type === "commit" && action.round_id != null) {
        const roundId = action.round_id;
        await withCommitLock(roundId, async () => {
          // Plans can be stale by the time this tab acquires the lock. Re-read
          // under the lock so a second tab does not publish a duplicate commit.
          const latest = parseState(await getContractState(key, {
            fetchContract: true,
            subscribe: true,
            priority: "low",
            timeoutMs: 12_000,
          }));
          const round = latest.rounds[String(roundId)];
          if (!round || round.closed || round.finalized || round.commits?.[identity.nodeId]) return;

          const existing = readSecret(roundId, identity.nodeId);
          const secret = existing || randomSecret();
          const created = !existing;
          if (created && !saveSecret(roundId, identity.nodeId, secret)) {
            throw new Error("automatic commit skipped: local secret storage unavailable");
          }

          // Once signing succeeds, retain the secret regardless of publication
          // result: an update can be accepted even when its acknowledgment is
          // lost, and the secret is then required for a later reveal.
          let signed: Record<string, unknown>;
          try {
            signed = await signTyche(identity, "SignCommit", {
              round_id: roundId,
              node_id: identity.nodeId,
              commitment: commitment(roundId, identity.nodeId, secret),
              wall_ms: Date.now(),
            });
          } catch (error) {
            if (created) forgetSecret(roundId, identity.nodeId);
            throw error;
          }
          await updateContract(
            wrapDeltaUpdate(key, new TextEncoder().encode(JSON.stringify({
              commit: { round_id: roundId, commit: signed },
            }))),
            key,
          );
          result.committed.push(roundId);
        });
      } else if (action.type === "reveal" && action.round_id != null) {
        const roundId = action.round_id;
        await withCommitLock(roundId, async () => {
          const latest = parseState(await getContractState(key, {
            fetchContract: true,
            subscribe: true,
            priority: "low",
            timeoutMs: 12_000,
          }));
          const round = latest.rounds[String(roundId)];
          if (!round || !round.closed || round.finalized || round.reveals?.[identity.nodeId] || round.recovered?.[identity.nodeId]) return;
          const next = (round.reveal_order || []).find(
            (nodeId) => !round.reveals?.[nodeId] && !round.recovered?.[nodeId],
          );
          if (next !== identity.nodeId) return;
          const secret = readSecret(roundId, identity.nodeId);
          if (!secret) return;
          const signed = await signTyche(identity, "SignReveal", {
            round_id: roundId,
            node_id: identity.nodeId,
            secret_hex: secret,
          });
          await updateContract(
            wrapDeltaUpdate(key, new TextEncoder().encode(JSON.stringify({
              reveal: { round_id: roundId, reveal: signed },
            }))),
            key,
          );
          forgetSecret(roundId, identity.nodeId);
          result.revealed.push(roundId);
        });
      }
    } catch (error) {
      result.errors.push({ action, error: errorText(error) });
    }
  }
  try {
    result.state = parseState(await getContractState(key, {
      fetchContract: true,
      subscribe: true,
      priority: "low",
      timeoutMs: 12_000,
    }));
  } catch {
    /* Keep the last state when the post-write refresh is unavailable. */
  }
  return result;
}

export type WatchTycheDutyHandlers = {
  onDuty?: (result: TycheDutyResult, reason: string) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
};

export function watchTycheDuty(handlers: WatchTycheDutyHandlers = {}): () => void {
  const { onDuty, onError, intervalMs = 60_000 } = handlers;
  let stopped = false;
  let busy = false;
  let queued = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe = () => {};
  const key = tycheContractKey();

  const refreshTyche = async (): Promise<TycheDutyResult> => {
    const soft = await softEnsureTyche();
    if (!soft.present || !soft.state) {
      return { identity: null, plan: null, pulsed: false, committed: [], revealed: [], errors: [], state: null, skipped: "tyche contract not present" };
    }
    let identity: Identity | null = null;
    try { identity = await getWitness(); } catch { /* absent */ }
    if (!identity) {
      return { identity: null, plan: null, pulsed: false, committed: [], revealed: [], errors: [], state: soft.state, skipped: "tyche identity is not initialized" };
    }
    const plan = planTycheDuty(soft.state, identity);
    if (plan.actions.some((action) => action.type === "commit" || action.type === "reveal")) {
      return runTycheDuty({ pulse: false });
    }
    return { identity, plan, pulsed: false, committed: [], revealed: [], errors: [], state: soft.state };
  };

  const tick = async (reason: string) => {
    if (stopped) return;
    if (busy) { queued = true; return; }
    busy = true;
    try {
      const result = reason === "update" || reason === "queued-update"
        ? await refreshTyche()
        : await runTycheDuty();
      if (!stopped) onDuty?.(result, reason);
    } catch (error) {
      if (!stopped) onError?.(error);
    } finally {
      busy = false;
      if (queued && !stopped) { queued = false; void tick("queued-update"); }
    }
  };

  void (async () => {
    try {
      await softEnsureTyche();
      if (stopped) return;
      unsubscribe = onContractUpdateNotification((updated) => {
        try {
          if (updated.encode() === key.encode()) void tick("update");
        } catch {
          void tick("update");
        }
      });
      await tick("initial");
      if (!stopped) timer = setInterval(() => void tick("interval"), intervalMs);
    } catch (error) {
      if (!stopped) onError?.(error);
    }
  })();

  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearInterval(timer);
  };
}
