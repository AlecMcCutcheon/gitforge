import {
  ContractKey,
  FreenetWsApi,
  GetRequest,
  GetResponse,
  PutRequest,
  UpdateRequest,
  type HostError,
  type ResponseHandler,
  type UpdateNotification,
  type UpdateResponse,
  type PutResponse,
  type DelegateResponse,
} from "@freenetorg/freenet-stdlib";
import { parseDelegateResponse } from "./delegate-api";

function commandWsUrl(): URL {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // const fromEnv = import.meta.env.VITE_FREENET_WS_URL?.trim();
  // NEW CODE - TESTING: Vite env + Node CLI (process.env)
  const fromImportMeta = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.VITE_FREENET_WS_URL?.trim();
  const fromProcess =
    typeof process !== "undefined"
      ? process.env?.VITE_FREENET_WS_URL?.trim() ||
        process.env?.FREENET_WS_URL?.trim()
      : undefined;
  const fromEnv = fromImportMeta || fromProcess;
  if (fromEnv) return new URL(fromEnv);
  const loc = (
    globalThis as { location?: { protocol?: string; host?: string } }
  ).location;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "127.0.0.1:7509";
  return new URL(`${proto}//${host}/v1/contract/command`);
}

type Conn = {
  api: FreenetWsApi;
  ready: Promise<void>;
  getChain: Promise<void>;
};

let conn: Conn | null = null;
/** In-flight open — single-flight so timeouts don't spawn orphan sockets. */
let connecting: Promise<Conn> | null = null;
let activeApi: FreenetWsApi | null = null;

type DelegateListener = (payloads: object[]) => void;
const delegateListeners = new Set<DelegateListener>();

type DelegateRawListener = (response: DelegateResponse) => void;
const delegateRawListeners = new Set<DelegateRawListener>();

/** Fired when the command WS drops so pending delegate waits can fail fast. */
type ConnDropListener = (err: Error) => void;
const connDropListeners = new Set<ConnDropListener>();

/** HostError from Freenet (e.g. delegate rejected origin) — fail pending waits. */
type HostErrListener = (err: Error) => void;
const hostErrListeners = new Set<HostErrListener>();

/**
 * Freenet often answers subscribed Put/Update with UpdateNotification instead
 * of PutResponse/UpdateResponse (same as freenet-git wsclient). Stdlib only
 * resolves on *Response, so we race notifications here.
 */
type UpdateNotifListener = (key: ContractKey) => void;
const updateNotifListeners = new Set<UpdateNotifListener>();

export function onDelegatePayloads(listener: DelegateListener): () => void {
  delegateListeners.add(listener);
  return () => {
    delegateListeners.delete(listener);
  };
}

/** Raw DelegateResponse (incl. empty-values RegisterDelegate acks). */
export function onDelegateResponseRaw(
  listener: DelegateRawListener,
): () => void {
  delegateRawListeners.add(listener);
  return () => {
    delegateRawListeners.delete(listener);
  };
}

export function onFreenetConnDrop(listener: ConnDropListener): () => void {
  connDropListeners.add(listener);
  return () => {
    connDropListeners.delete(listener);
  };
}

export function onFreenetHostError(listener: HostErrListener): () => void {
  hostErrListeners.add(listener);
  return () => {
    hostErrListeners.delete(listener);
  };
}

export function onContractUpdateNotification(
  listener: UpdateNotifListener,
): () => void {
  updateNotifListeners.add(listener);
  return () => {
    updateNotifListeners.delete(listener);
  };
}

function notifyUpdateNotification(key: ContractKey): void {
  for (const listener of updateNotifListeners) {
    try {
      listener(key);
    } catch (e) {
      console.warn("[freenet-forge] update-notif listener error:", e);
    }
  }
}

function notifyConnDrop(code: number, reason: string): void {
  const err = new Error(
    `Connection closed: ${code}${reason ? ` ${reason}` : ""}`,
  );
  for (const listener of connDropListeners) {
    try {
      listener(err);
    } catch (e) {
      console.warn("[freenet-forge] conn-drop listener error:", e);
    }
  }
}

function notifyHostError(cause: string): void {
  const err = new Error(cause || "Freenet host error");
  for (const listener of hostErrListeners) {
    try {
      listener(err);
    } catch (e) {
      console.warn("[freenet-forge] host-err listener error:", e);
    }
  }
}

function noopHandler(): ResponseHandler {
  return {
    onContractPut: (_r: PutResponse) => {},
    onContractGet: (_r: GetResponse) => {},
    onContractUpdate: (_r: UpdateResponse) => {},
    onContractUpdateNotification: (_n: UpdateNotification) => {},
    onContractNotFound: (_id: Uint8Array) => {},
    onDelegateResponse: (_r: DelegateResponse) => {},
    onErr: (err: HostError) => {
      console.warn("[freenet-forge] host error:", err.cause);
      notifyHostError(
        typeof err.cause === "string" ? err.cause : String(err.cause),
      );
    },
    onOpen: () => {},
  };
}

function closeApiSocket(api: FreenetWsApi | null | undefined): void {
  if (!api) return;
  try {
    // FreenetWsApi does not expose close(); underlying browser WS does.
    const ws = (api as unknown as { ws?: WebSocket }).ws;
    if (ws && ws.readyState < 2) ws.close();
  } catch {
    /* ignore */
  }
}

/** Force next ensureConn to open a fresh socket (after a known-dead WS). */
export function resetFreenetConn(): void {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // conn = null;
  // NEW CODE - TESTING: also abort in-flight open + close orphan sockets so
  // timed-out connects cannot fill the shell's MAX_CONNECTIONS (32) pool.
  const api = activeApi;
  conn = null;
  connecting = null;
  activeApi = null;
  closeApiSocket(api);
}

async function openFreenetConn(): Promise<Conn> {
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  let closedBeforeReady = false;
  let settledReady = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (settledReady) return;
      settledReady = true;
      resolve();
    };
    rejectReady = (err: Error) => {
      if (settledReady) return;
      settledReady = true;
      reject(err);
    };
  });
  // Declared before handler so onClose can ignore stale sockets after reconnect.
  let api: FreenetWsApi;
  const handler: ResponseHandler = {
    ...noopHandler(),
    onOpen: () => resolveReady(),
    onDelegateResponse: (r: DelegateResponse) => {
      for (const listener of delegateRawListeners) {
        try {
          listener(r);
        } catch (e) {
          console.warn("[freenet-forge] delegate raw listener error:", e);
        }
      }
      const payloads = parseDelegateResponse(r);
      if (payloads.length === 0) return;
      for (const listener of delegateListeners) {
        try {
          listener(payloads);
        } catch (e) {
          console.warn("[freenet-forge] delegate listener error:", e);
        }
      }
    },
    onContractUpdateNotification: (n: UpdateNotification) => {
      // NEW CODE - TESTING: freenet-git treats UpdateNotification as write success
      notifyUpdateNotification(n.key);
    },
    onErr: (err: HostError) => {
      console.warn("[freenet-forge] host error:", err.cause);
      notifyHostError(
        typeof err.cause === "string" ? err.cause : String(err.cause),
      );
    },
    onClose: (code, reason) => {
      console.warn("[freenet-forge] ws closed", code, reason);
      closedBeforeReady = true;
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // if (activeApi) { conn = null; if (connecting) connecting = null; }
      // Cleared ANY active socket when a *previous* WS closed → orphaned the
      // fresh reconnect mid-Put and surfaced Connection closed: 1006 on save.
      // NEW CODE - TESTING: only tear down if this closed socket is still current
      if (activeApi === api) {
        activeApi = null;
        conn = null;
        connecting = null;
      }
      rejectReady(
        new Error(`Connection closed: ${code}${reason ? ` ${reason}` : ""}`),
      );
      notifyConnDrop(code, reason ?? "");
    },
  };
  const url = commandWsUrl();
  try {
    api = new FreenetWsApi(url, handler, "");
  } catch (err) {
    rejectReady(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  activeApi = api;
  const timer = setTimeout(() => {
    rejectReady(new Error(`Freenet WS connect timeout (${url})`));
  }, CONNECT_TIMEOUT_MS);
  try {
    await ready;
  } catch (err) {
    closeApiSocket(api);
    if (activeApi === api) activeApi = null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (closedBeforeReady) {
    closeApiSocket(api);
    if (activeApi === api) activeApi = null;
    throw new Error("Connection closed before Freenet WS was ready");
  }
  const c: Conn = { api, ready, getChain: Promise.resolve() };
  conn = c;
  return c;
}

async function ensureConn(): Promise<Conn> {
  if (conn) return conn;
  if (connecting) return connecting;
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Each timed-out ensureConn left FreenetWsApi opening in the background;
  // rapid retries spawned orphans and bricked the shared GET pump.
  // NEW CODE - TESTING: single-flight connect + close on failure
  const p = openFreenetConn().finally(() => {
    if (connecting === p) connecting = null;
  });
  connecting = p;
  return p;
}

export function isWsDropError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Connection closed|1006|WebSocket|network|timed out|timeout/i.test(
    msg,
  );
}

/** Socket death only — not stdlib "Request timeout" (retrying that hangs Updates). */
function isHardWsDropError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Connection closed|1006|WebSocket|network/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WRITE_MAX_ATTEMPTS = 3;

function isConnectTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Freenet WS connect timed out|connect timeout/i.test(msg);
}

const CONNECT_TIMEOUT_MS = 8_000;
const GET_ATTEMPT_TIMEOUT_MS = 12_000;
/** Soft/background GETs (registry, stars, profile) — fail fast, don't stall tip packs. */
const SOFT_GET_TIMEOUT_MS = 4_000;

export type GetPriority = "high" | "low";

export interface GetContractOptions {
  /** `high` = tip packs / repo state; `low` = hub metadata (default high). */
  priority?: GetPriority;
  timeoutMs?: number;
  maxAttempts?: number;
  /**
   * Cancel group (usually repo prefix). Leaving a page calls
   * `abortContractGets(scope)` so stalled tip GETs don't clog the WS pump.
   */
  scope?: string;
  /**
   * Fetch WASM/params with state (needed before Update merge). Soft listing
   * GETs leave this false.
   */
  fetchContract?: boolean;
  /**
   * Register this node as a subscriber/holder. Required before Update when
   * the contract was Put without subscribe (freenet-mail #288).
   */
  subscribe?: boolean;
}

/** True when a GET was dropped because the user left the page / repo. */
export function isContractGetCancelled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /contract GET cancelled|tip load cancelled|left repo/i.test(msg);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function abortableDelay(ms: number, job: QueuedGet): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.aborted) {
      reject(
        new Error(
          job.scope
            ? `contract GET cancelled (${job.scope})`
            : "contract GET cancelled",
        ),
      );
      return;
    }
    const timer = setTimeout(() => {
      clearInterval(watch);
      resolve();
    }, ms);
    const watch = setInterval(() => {
      if (!job.aborted) return;
      clearTimeout(timer);
      clearInterval(watch);
      reject(
        new Error(
          job.scope
            ? `contract GET cancelled (${job.scope})`
            : "contract GET cancelled",
        ),
      );
    }, 50);
  });
}

type QueuedGet = {
  key: ContractKey;
  priority: GetPriority;
  timeoutMs: number;
  maxAttempts: number;
  scope?: string;
  fetchContract?: boolean;
  subscribe?: boolean;
  /** Set by abortContractGets — stop retries / connect waits. */
  aborted?: boolean;
  resolve: (v: Uint8Array) => void;
  reject: (e: unknown) => void;
};

const highGetQueue: QueuedGet[] = [];
const lowGetQueue: QueuedGet[] = [];
let getPumpRunning = false;
let cancelInFlightGet: ((err: Error) => void) | null = null;
let inFlightJob: QueuedGet | null = null;
/** After a transport failure, skip reconnect loops for a short window. */
let transportCooldownUntil = 0;

function jobMatchesScope(job: QueuedGet, scope?: string): boolean {
  if (scope) return job.scope === scope;
  return job.scope != null && job.scope !== "";
}

function drainQueueForAbort(queue: QueuedGet[], err: Error, scope?: string): void {
  const keep: QueuedGet[] = [];
  for (const job of queue) {
    if (jobMatchesScope(job, scope)) {
      job.aborted = true;
      job.reject(err);
    } else {
      keep.push(job);
    }
  }
  queue.length = 0;
  for (const job of keep) queue.push(job);
}

/**
 * Drop queued + in-flight contract GETs for a cancel scope (repo prefix).
 * Call when navigating away so stalled tip packs don't clog the WS pump.
 */
export function abortContractGets(scope?: string): void {
  const err = new Error(
    scope
      ? `contract GET cancelled (${scope})`
      : "contract GET cancelled",
  );
  drainQueueForAbort(highGetQueue, err, scope);
  drainQueueForAbort(lowGetQueue, err, scope);
  let killedInFlight = false;
  if (
    cancelInFlightGet &&
    inFlightJob &&
    jobMatchesScope(inFlightJob, scope)
  ) {
    inFlightJob.aborted = true;
    const cancel = cancelInFlightGet;
    cancelInFlightGet = null;
    inFlightJob = null;
    cancel(err);
    killedInFlight = true;
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // resetFreenetConn() always — Discover→repo (or deferred clear of repo B while
  // loading A) tore down the socket mid-GET → stuck "Reading refs" until reload.
  // NEW CODE - TESTING: only reset when we cancelled in-flight or full abort
  if (killedInFlight || !scope) {
    resetFreenetConn();
    void import("./chunk-ws-pool")
      .then((m) => m.resetChunkWsPool())
      .catch(() => {});
  }
}

/**
 * Drop Discover/profile soft GETs waiting in the low queue so a repo tip/refs
 * GET is next after the current in-flight finishes (or is preempted by high).
 */
export function flushBackgroundContractGets(
  reason = "background contract GET flushed",
): void {
  const err = new Error(reason);
  while (lowGetQueue.length > 0) {
    const job = lowGetQueue.shift();
    if (!job) break;
    job.aborted = true;
    job.reject(err);
  }
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Also cancelled in-flight low + resetFreenetConn — raced the refs GET reconnect
  // NEW CODE - TESTING: only drain the queue; high enqueue already preempts low
  void pumpContractGets();
}

function enqueueContractGet(
  key: ContractKey,
  opts: GetContractOptions = {},
): Promise<Uint8Array> {
  const priority = opts.priority ?? "high";
  const timeoutMs =
    opts.timeoutMs ??
    (priority === "low" ? SOFT_GET_TIMEOUT_MS : GET_ATTEMPT_TIMEOUT_MS);
  const maxAttempts = opts.maxAttempts ?? (priority === "low" ? 1 : 3);
  return new Promise<Uint8Array>((resolve, reject) => {
    const job: QueuedGet = {
      key,
      priority,
      timeoutMs,
      maxAttempts,
      scope: opts.scope,
      fetchContract: opts.fetchContract,
      subscribe: opts.subscribe,
      resolve,
      reject,
    };
    if (priority === "high") {
      highGetQueue.push(job);
      if (
        cancelInFlightGet &&
        inFlightJob &&
        inFlightJob.priority === "low"
      ) {
        const cancel = cancelInFlightGet;
        cancelInFlightGet = null;
        inFlightJob = null;
        cancel(new Error("preempted by high-priority contract GET"));
      }
    } else {
      lowGetQueue.push(job);
    }
    void pumpContractGets();
  });
}

async function runOneContractGet(job: QueuedGet): Promise<Uint8Array> {
  let lastErr: unknown;
  // Connect failures used to retry 3×12s and freeze every other repo's GETs.
  const attempts =
    Date.now() < transportCooldownUntil
      ? 1
      : job.maxAttempts;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (job.aborted) {
      throw new Error(
        job.scope
          ? `contract GET cancelled (${job.scope})`
          : "contract GET cancelled",
      );
    }
    try {
      const res = await new Promise<GetResponse>((resolve, reject) => {
        const onCancel = (err: Error) => {
          resetFreenetConn();
          reject(err);
        };
        cancelInFlightGet = onCancel;
        inFlightJob = job;
        void (async () => {
          try {
            const c = await ensureConn();
            if (job.aborted) {
              throw new Error(
                job.scope
                  ? `contract GET cancelled (${job.scope})`
                  : "contract GET cancelled",
              );
            }
            const req = new GetRequest(
              job.key,
              Boolean(job.fetchContract),
              Boolean(job.subscribe),
              false,
            );
            const label = `contract GET ${job.key.encode().slice(0, 16)}…`;
            const got = await withTimeout(
              c.api.get(req),
              job.timeoutMs,
              label,
            );
            resolve(got);
          } catch (err) {
            reject(err);
          } finally {
            if (cancelInFlightGet === onCancel) cancelInFlightGet = null;
            if (inFlightJob === job) inFlightJob = null;
          }
        })();
      });
      if (!res.state || res.state.length === 0) {
        throw new Error(`empty state for ${job.key.encode()}`);
      }
      return Uint8Array.from(res.state);
    } catch (err) {
      lastErr = err;
      const preempted =
        err instanceof Error &&
        err.message.includes("preempted by high-priority");
      if (preempted || isContractGetCancelled(err) || job.aborted) break;

      // OLD CODE - KEEP UNTIL CONFIRMED WORKING
      // resetFreenetConn(); // every failure — killed identity delegate mid-inbox
      // NEW CODE - TESTING: soft/low GET timeouts must not tear down the shared
      // command WS (inbox ExportIdentity / Sign* share it). Hard drops still reset.
      if (
        isHardWsDropError(err) ||
        isConnectTimeoutError(err) ||
        job.priority === "high"
      ) {
        resetFreenetConn();
      }

      if (isConnectTimeoutError(err)) {
        // Don't burn 3× connect timeouts on a dead bridge — cool down briefly
        // so the rest of the queue fails fast instead of brick-locking the UI.
        transportCooldownUntil = Date.now() + 2_500;
        console.warn(
          "[freenet-forge] WS connect timed out — failing this GET without long retries",
          err instanceof Error ? err.message : err,
        );
        break;
      }

      if (!isWsDropError(err) || attempt === attempts) break;
      console.warn(
        `[freenet-forge] GET failed (attempt ${attempt}/${attempts}), reconnecting:`,
        err instanceof Error ? err.message : err,
      );
      try {
        await abortableDelay(250 * attempt, job);
      } catch (delayErr) {
        lastErr = delayErr;
        break;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function pumpContractGets(): Promise<void> {
  if (getPumpRunning) return;
  getPumpRunning = true;
  try {
    while (highGetQueue.length > 0 || lowGetQueue.length > 0) {
      const job = highGetQueue.shift() ?? lowGetQueue.shift();
      if (!job) break;
      if (job.aborted) {
        job.reject(
          new Error(
            job.scope
              ? `contract GET cancelled (${job.scope})`
              : "contract GET cancelled",
          ),
        );
        continue;
      }
      try {
        job.resolve(await runOneContractGet(job));
      } catch (err) {
        const preempted =
          err instanceof Error &&
          err.message.includes("preempted by high-priority");
        if (preempted && job.priority === "low") {
          lowGetQueue.unshift(job);
          continue;
        }
        job.reject(err);
      }
    }
  } finally {
    getPumpRunning = false;
    if (highGetQueue.length > 0 || lowGetQueue.length > 0) {
      void pumpContractGets();
    }
  }
}

/** Serialized GET with priority. Tip packs must use `high` (default). */
export async function getContractState(
  key: ContractKey,
  opts?: GetContractOptions,
): Promise<Uint8Array> {
  return enqueueContractGet(key, opts);
}

/** Soft GET — empty/missing returns null; low priority + short timeout. */
export async function tryGetContractState(
  key: ContractKey,
  opts?: { timeoutMs?: number },
): Promise<Uint8Array | null> {
  try {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return await getContractState(key, {
    //   priority: "low",
    //   timeoutMs: SOFT_GET_TIMEOUT_MS,
    //   maxAttempts: 1,
    // });
    // NEW CODE - TESTING: allow shorter miss timeouts (e.g. optional ForgeRepoMeta)
    return await getContractState(key, {
      priority: "low",
      timeoutMs: opts?.timeoutMs ?? SOFT_GET_TIMEOUT_MS,
      maxAttempts: 1,
    });
  } catch {
    return null;
  }
}

function contractKeyId(key: ContractKey): string {
  try {
    return key.encode();
  } catch {
    return String(key);
  }
}

function typedResponseKeyId(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return null;
  const key = (resp as { key?: ContractKey }).key;
  if (!key) return null;
  return contractKeyId(key);
}

/** True when stdlib returned a Put/Update for a different contract (FIFO residue). */
export function isStaleWriteKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /stale (Put|Update)Response key mismatch/i.test(msg);
}

/**
 * Serialise Puts/Updates on the shell WS. JS FreenetWsApi resolves pending
 * writes FIFO without key matching — overlapping writes amplify stale-response
 * bugs (freenet-git #9 / docs/15-freenet-git-ws-hygiene.md).
 */
let writeChain: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((r) => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Wait for PutResponse/UpdateResponse OR matching UpdateNotification.
 * Without this, subscribed writes hang on stdlib "Request timeout".
 *
 * `startWrite` must be a factory so the listener is armed before the request
 * hits the wire (notifications can arrive before PutResponse/UpdateResponse).
 *
 * NEW CODE - TESTING: typed response must match expectKey (freenet-git
 * dispatch_put_response). Mismatch → reject so caller reconnects; do not
 * treat as success or the next write inherits queue residue.
 */
async function awaitWriteOrNotification(
  startWrite: () => Promise<unknown>,
  expectKey: ContractKey | null,
): Promise<void> {
  let settled = false;
  let write: Promise<unknown> = Promise.resolve();
  let unsub: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      unsub = onContractUpdateNotification((key) => {
        if (expectKey && contractKeyId(key) !== contractKeyId(expectKey)) {
          return;
        }
        if (settled) return;
        settled = true;
        resolve();
      });
      write = startWrite();
      write.then(
        (resp) => {
          if (settled) return;
          if (expectKey) {
            const got = typedResponseKeyId(resp);
            if (got && got !== contractKeyId(expectKey)) {
              console.warn(
                "[freenet-forge] ignoring stale write response for",
                got.slice(0, 16),
                "want",
                contractKeyId(expectKey).slice(0, 16),
              );
              settled = true;
              reject(
                new Error(
                  "stale Put/UpdateResponse key mismatch — reconnect",
                ),
              );
              return;
            }
          }
          settled = true;
          resolve();
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  } finally {
    unsub();
    // If notification won, stdlib may still reject with Request timeout — ignore.
    void write.catch(() => {});
  }
}

export async function putContract(
  req: PutRequest,
  expectKey?: ContractKey | null,
): Promise<void> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await c.api.put(req); // hangs when host replies UpdateNotification first
  // NEW CODE - TESTING: serial lock + key-check + UpdateNotification race
  return withWriteLock(async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
      try {
        const c = await ensureConn();
        await awaitWriteOrNotification(
          () => c.api.put(req),
          expectKey ?? null,
        );
        return;
      } catch (err) {
        lastErr = err;
        const retry =
          isHardWsDropError(err) || isStaleWriteKeyError(err);
        if (!retry || attempt === WRITE_MAX_ATTEMPTS) break;
        console.warn(
          `[freenet-forge] Put failed (attempt ${attempt}/${WRITE_MAX_ATTEMPTS}), reconnecting:`,
          err instanceof Error ? err.message : err,
        );
        resetFreenetConn();
        await delay(200 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  });
}

export async function updateContract(
  req: UpdateRequest,
  expectKey?: ContractKey | null,
): Promise<void> {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // await c.api.update(req);
  // NEW CODE - TESTING: serial lock + key-check + UpdateNotification race
  return withWriteLock(async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
      try {
        const c = await ensureConn();
        await awaitWriteOrNotification(
          () => c.api.update(req),
          expectKey ?? null,
        );
        return;
      } catch (err) {
        lastErr = err;
        const retry =
          isHardWsDropError(err) || isStaleWriteKeyError(err);
        if (!retry || attempt === WRITE_MAX_ATTEMPTS) break;
        console.warn(
          `[freenet-forge] Update failed (attempt ${attempt}/${WRITE_MAX_ATTEMPTS}), reconnecting:`,
          err instanceof Error ? err.message : err,
        );
        resetFreenetConn();
        await delay(200 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  });
}

export async function getFreenetApi(): Promise<FreenetWsApi> {
  const c = await ensureConn();
  return c.api;
}

/** Lightweight WS open check for website-mode status pills. */
export async function probeFreenetNode(timeoutMs = 8_000): Promise<boolean> {
  try {
    const c = await Promise.race([
      ensureConn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("node probe timeout")),
          timeoutMs,
        ),
      ),
    ]);
    return Boolean(c);
  } catch {
    return false;
  }
}
